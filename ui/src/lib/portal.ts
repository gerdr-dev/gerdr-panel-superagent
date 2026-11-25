import * as core from "@gerdr/core";
import { createContext, createElement, type ReactNode, useContext } from "react";

// Where this panel's overlays (sheets, dialogs) are portaled: inside its own area, so they're hidden with it when
// another panel or Code is shown — a sheet on document.body stayed on screen over them. Through the namespace, so a
// Gerdr from before usePortalContainer still runs this panel (body, as then).
const fromCore = (core as unknown as { usePortalContainer?: () => HTMLElement | null }).usePortalContainer;

const Whole = createContext(false);

/**
 * What's inside is portaled to the whole window (document.body) instead of the panel's area: the settings sheet,
 * with the menus and dialogs it opens. The panel's area is under Gerdr's own bars (a phone's top bar, Code's list),
 * and settings opened there read as a page stuck inside another page (the person, 2026-11-24: the top bar shouldn't
 * show; the whole page, or a popup). Whoever uses it closes it when the panel stops showing (layout.tsx): nothing
 * hides it with the panel any more.
 */
export function WholeWindow({ children }: { children: ReactNode }) {
  return createElement(Whole.Provider, { value: true }, children);
}

export function usePortalContainer(): HTMLElement | null {
  const whole = useContext(Whole);
  const inPanel = fromCore ? fromCore() : null;
  return whole ? null : inPanel;
}
