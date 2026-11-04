import * as core from "@gerdr/core";
import { useEffect, useRef, useSyncExternalStore } from "react";

// Whether this panel is on screen. Gerdr keeps the panel mounted while another panel or Code is shown, and the page
// lives inside Gerdr's own, so document.visibilityState is "visible" all day: polling "while visible" ran tasks.list
// and superagent.log every few seconds for as long as the app was open (with two installs, about one run a second).
// Through the namespace, so a Gerdr from before usePanelVisible still runs this panel (the window alone, as then).
const fromCore = (core as unknown as { usePanelVisible?: () => boolean }).usePanelVisible;

const subscribe = (f: () => void) => (document.addEventListener("visibilitychange", f), () => document.removeEventListener("visibilitychange", f));
const useWindowVisible = () => useSyncExternalStore(subscribe, () => document.visibilityState === "visible");

export const usePanelVisible: () => boolean = fromCore ?? useWindowVisible;

/** Calls fn now, every `ms` while the panel is on screen, and again as soon as it comes back on screen. */
export function usePoll(fn: () => unknown, ms: number) {
  const visible = usePanelVisible();
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => {
    if (!visible) return;
    void f.current();
    const t = setInterval(() => void f.current(), ms);
    return () => clearInterval(t);
  }, [visible, ms]);
}

// Pushed changes (Gerdr's core usePanelChange / useSessions), through the namespace too: a Gerdr from before them
// has neither, and the board then polls as it used to. Each is fixed for the page's life, so hooks keep their order.
type CoreSession = { id: string; status: string; waiting?: string; waitingKind?: string; pending?: number; reportTo?: string; parent?: string; tags?: Record<string, string>; [k: string]: unknown };
const coreChange = (core as unknown as { usePanelChange?: (path?: string) => number }).usePanelChange;
const coreSessions = (core as unknown as { useSessions?: (match?: (s: CoreSession) => boolean) => CoreSession[] }).useSessions;
const NONE: CoreSession[] = [];

/** Whether Gerdr pushes changes to this page; without it the page polls. */
export const pushed = !!coreChange && !!coreSessions;

/** How many times this panel's files under `path` changed through its functions (0 forever on an older Gerdr). */
export const usePanelChange: (path?: string) => number = coreChange ?? (() => 0);

/** The conversations `match` picks, live (none on an older Gerdr). */
export const useSessions: (match: (s: CoreSession) => boolean) => CoreSession[] = coreSessions ?? (() => NONE);

/** What about a conversation a board shows: a change here is worth a refresh, a streamed chunk isn't. */
export const sessionsKey = (list: CoreSession[]) =>
  list
    .map((s) => `${s.id}:${s.status}:${s.waiting ?? ""}:${s.waitingKind ?? ""}:${s.pending ?? 0}`)
    .sort()
    .join("|");

/**
 * Calls fn now, whenever `deps` change (pushed: a usePanelChange count, a sessionsKey) and every `fallback` ms, only
 * while the panel is on screen and again when it comes back. At most once a second: a refresh that itself changed
 * a file mustn't spin. Without push (an older Gerdr) every `poll` ms instead, as before.
 */
export function useRefresh(fn: () => unknown, deps: unknown[], { fallback = 60_000, poll = 5000 } = {}) {
  const visible = usePanelVisible();
  const f = useRef(fn);
  f.current = fn;
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fire = useRef(() => {
    const wait = last.current + 1000 - Date.now();
    if (wait > 0) {
      timer.current ??= setTimeout(() => {
        timer.current = null;
        last.current = Date.now();
        void f.current();
      }, wait);
      return;
    }
    last.current = Date.now();
    void f.current();
  }).current;
  const key = JSON.stringify(deps);
  useEffect(() => {
    if (visible) fire();
  }, [visible, key, fire]);
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(fire, pushed ? fallback : poll);
    return () => clearInterval(t);
  }, [visible, fallback, poll, fire]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
}
