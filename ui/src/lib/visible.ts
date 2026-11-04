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
