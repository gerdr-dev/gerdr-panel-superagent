import * as core from "@gerdr/core";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import type { SettingsTab } from "../components/SettingsSheet";

// This panel is Code with the secretary in it: Gerdr's own Code layout (core CodeView) with our part at the top of
// its list. There is no board. What's behind the secretary (设置, 流程, 记忆, 触发器, 定时任务, 去向) is a sheet shown
// instead of Code while it's open.
// Through the namespace: CodeView is experimental (2026-11); a Gerdr without it can't show this panel (layout.tsx says so).
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

/** The settings sheet's open tab; null = Code. Not kept across reloads: coming back, one wants Code. */
let settings: SettingsTab | null = null;
const subs = new Set<() => void>();

export function openSettings(tab: SettingsTab | null) {
  if (tab === settings) return;
  settings = tab;
  for (const f of subs) f();
}

export function useSettingsTab(): SettingsTab | null {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => settings,
  );
}
