import * as core from "@gerdr/core";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";

// This panel is Code with the secretary in it: Gerdr's own Code layout (core CodeView) with our part at the top of
// its list. The board is the other view of the same tasks, shown instead of Code when asked for.
// Through the namespace: a Gerdr without CodeView (it's experimental, 2026-11) shows the board alone, as Superagent does.
type Core = {
  CodeView?: (props: { sidebar?: ReactNode }) => ReactNode;
  showInCodeView?: (session: string) => void;
  useCodeSession?: () => string | undefined;
};
const c = core as unknown as Core;

export const CodeView = c.CodeView;
export const canHostCode = !!c.CodeView && !!c.showInCodeView;
export const showInCode = (session: string) => c.showInCodeView?.(session);
export const useCodeSession: () => string | undefined = c.useCodeSession ?? (() => undefined);

export type View = "code" | "board";
const KEY = "gerdr-panel-fusion.view";
let view: View = "code";
try {
  if (localStorage.getItem(KEY) === "board") view = "board";
} catch {}
const subs = new Set<() => void>();

export function setView(v: View) {
  if (v === view) return;
  view = v;
  try {
    localStorage.setItem(KEY, v);
  } catch {}
  for (const f of subs) f();
}

/** Which view shows: Code with the secretary's part (the default), or the board. Always the board without CodeView. */
export function useView(): View {
  const v = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => view,
  );
  return canHostCode ? v : "board";
}
