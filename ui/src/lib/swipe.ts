import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

// Swiping between the board's columns on a phone, the way Gerdr's own phone overview turns pages
// (gerdr ui/src/components/OverviewPhone.tsx useSwipePager, same numbers): the row of pages follows the finger 1:1 —
// the next column is dragged in under it, rubber-banding past the first / last — and on release slides on to the
// next one or back, at the finger's speed. Gerdr doesn't export its pager to panels, so this is the same feel, kept
// small: all pages are on the track, the index says which one shows.

const SLOP = 10; // px before a touch counts as a drag and its direction is decided
const TURN = 0.35; // of the page width dragged: let go past it and the page turns
const FLICK = 0.3; // px/ms: a flick this fast towards a neighbour turns the page however short it was
const EDGE = 20; // px at the screen's sides left to the system's back gesture / history swipe
const EASE = "cubic-bezier(0.25, 1, 0.5, 1)";

/** Whether the screen is a phone's (the board's md breakpoint). */
export function usePhone() {
  const q = "(max-width: 767px)";
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return on;
}

/**
 * The pager: `view` clips, `track` holds the pages side by side (each its full width). `index` shows; a swipe calls
 * `onIndex` with the neighbour's. A swipe may start anywhere in `area` (the empty space below a short column too). The view's height follows the page shown, so a short column leaves no blank page
 * to scroll below it.
 */
export function useSwipePages(
  view: RefObject<HTMLDivElement | null>,
  track: RefObject<HTMLDivElement | null>,
  index: number,
  count: number,
  onIndex: (i: number) => void,
  /** Where a swipe may start: the whole page, not only the column (it's short when it has few cards). Default: view. */
  area?: RefObject<HTMLElement | null>,
) {
  const at = useRef(index);
  const turn = useRef(onIndex);
  turn.current = onIndex;
  const width = () => view.current?.clientWidth ?? 0;
  const place = (dx: number, ms = 0) => {
    const el = track.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms ${EASE}` : "";
    el.style.transform = `translateX(${-at.current * width() + dx}px)`;
  };
  const slideMs = (dist: number, v: number) => Math.round(Math.min(340, Math.max(160, Math.abs(dist) / Math.max(Math.abs(v), 1.2))));

  // A new index (a swipe, or a tab tapped): slide there. When the pager appears (count changes from 0: the screen
  // became a phone's), jump
  const shownCount = useRef(0);
  useLayoutEffect(() => {
    const from = at.current;
    at.current = index;
    if (shownCount.current !== count) {
      shownCount.current = count;
      return place(0);
    }
    // A swipe already set the track sliding there: leave it be
    if (from === index) return;
    place(0, 260);
  }, [index, count]);

  // Height of the page shown
  useLayoutEffect(() => {
    const v = view.current;
    const page = track.current?.children[index] as HTMLElement | undefined;
    if (!v || !page) return;
    const fit = () => (v.style.height = `${page.offsetHeight}px`);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(page);
    return () => ro.disconnect();
  }, [index, count]);

  // Re-placed when the width changes (rotating the phone)
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const ro = new ResizeObserver(() => place(0));
    ro.observe(v);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // The panel's whole area in Gerdr (its mount), when there is one: below a short column is Gerdr's space, not ours
    const el = (area?.current?.closest("[data-gerdr-mount]") as HTMLElement | null) ?? area?.current ?? view.current;
    if (!el || !count) return;
    let g: { x: number; y: number; mode: "wait" | "swipe" | "off"; off: number; trail: { x: number; t: number }[] } | null = null;
    const has = (step: number) => at.current + step >= 0 && at.current + step < count;
    // 1:1 towards a neighbour, rubber-band past the first / last page
    const off = (d: number) => {
      const w = width();
      const o = Math.max(-w, Math.min(w, d));
      return has(o < 0 ? 1 : -1) ? o : o * 0.25;
    };
    const start = (e: TouchEvent) => {
      g = null;
      if (e.touches.length !== 1) return;
      const p = e.touches[0];
      if (p.clientX < EDGE || p.clientX > window.innerWidth - EDGE) return;
      if (!(e.target instanceof Element) || skip(e.target, el)) return;
      if (String(window.getSelection() ?? "")) return;
      g = { x: p.clientX, y: p.clientY, mode: "wait", off: 0, trail: [{ x: p.clientX, t: e.timeStamp }] };
    };
    const drag = (e: TouchEvent) => {
      if (!g || g.mode === "off") return;
      if (e.touches.length !== 1) {
        if (g.mode === "swipe") place(0, 200);
        return void (g.mode = "off");
      }
      const p = e.touches[0];
      const dx = p.clientX - g.x;
      const dy = p.clientY - g.y;
      if (g.mode === "wait") {
        if (Math.hypot(dx, dy) < SLOP) return;
        // Clearly sideways, or it's a scroll and the rest of this touch is left alone
        if (Math.abs(dx) <= Math.abs(dy) * 1.5) return void (g.mode = "off");
        g.mode = "swipe";
        g.x = p.clientX - Math.sign(dx);
      }
      if (e.cancelable) e.preventDefault();
      g.off = off(p.clientX - g.x);
      g.trail.push({ x: p.clientX, t: e.timeStamp });
      while (g.trail.length > 2 && e.timeStamp - g.trail[0].t > 100) g.trail.shift();
      place(g.off);
    };
    const end = () => {
      if (!g) return;
      const { mode, off: o, trail } = g;
      g = null;
      if (mode !== "swipe") return;
      const last = trail[trail.length - 1];
      const v = (last.x - trail[0].x) / Math.max(1, last.t - trail[0].t) || 0;
      const step = o < 0 ? 1 : -1;
      const w = width();
      const go = has(step) && o !== 0 && (Math.abs(o) > w * TURN || (Math.abs(v) > FLICK && Math.sign(v) === Math.sign(o)));
      if (!go) return place(0, slideMs(o, v));
      // Slide on at the finger's speed; the new index then finds the track already there
      const to = at.current + step;
      const el2 = track.current;
      if (el2) {
        el2.style.transition = `transform ${slideMs(w - Math.abs(o), v)}ms ${EASE}`;
        el2.style.transform = `translateX(${-to * w}px)`;
      }
      at.current = to;
      turn.current(to);
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", drag, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", drag);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [count]);
}

/** A touch that belongs to something under it: a text box, a drawer, something that scrolls sideways, [data-no-swipe]. */
function skip(t: Element, root: Element) {
  // A drawer or dialog over the board (portaled into the same mount): its own touches, not the board's columns
  if (t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-no-swipe], [role='dialog']")) return true;
  for (let n: Element | null = t; n && n !== root; n = n.parentElement) {
    if (n.scrollWidth <= n.clientWidth + 1) continue;
    const ox = getComputedStyle(n).overflowX;
    if (ox === "auto" || ox === "scroll") return true;
  }
  return false;
}
