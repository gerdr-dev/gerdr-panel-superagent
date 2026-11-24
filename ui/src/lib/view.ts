import * as core from "@gerdr/core";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import type { SettingsTab } from "../components/SettingsSheet";

// This panel is a Code of its own, made from Code's parts (core CodeView): Gerdr's panes, tabs and terminals as they
// are, and a list we draw ourselves, grouped by where each piece of work stands instead of by workspace. There is no board. What's behind the secretary (设置, 流程, 记忆, 触发器, 定时任务, 去向) is a sheet shown
// instead of Code while it's open.
// Through the namespace: CodeView is experimental (2026-11); a Gerdr without it can't show this panel (layout.tsx says so).
/** A pane of Code's layout (core CodeRowInfo): a conversation, a terminal, a file, a browser page… */
export type CodeRowInfo = {
  pane: string;
  kind: "session" | "terminal" | "file" | "browser" | "subagent" | "new";
  session?: string;
  cwd?: string;
  workspace: { id: string; name: string; cwd?: string };
  current: boolean;
};
type Core = {
  CodeView?: (props: { sidebar?: ReactNode; list?: "add" | "replace" }) => ReactNode;
  CodeRow?: (props: { pane: string; where?: string }) => ReactNode;
  useCodeRows?: () => CodeRowInfo[];
  newCodeTab?: (opts?: { cwd?: string }) => void;
  showInCodeView?: (session: string) => void;
  useCodeSession?: () => string | undefined;
};
const c = core as unknown as Core;

export const CodeView = c.CodeView;
/** Code's own row for a pane: the rows here look and behave as in Code (its menu, dragging, unread). */
export const CodeRow = c.CodeRow!;
export const useCodeRows = c.useCodeRows!;
export const newCodeTab = (opts?: { cwd?: string }) => c.newCodeTab?.(opts);
// All of it or nothing: the list is ours to draw (list="replace"), from Code's rows
export const canHostCode = !!c.CodeView && !!c.showInCodeView && !!c.CodeRow && !!c.useCodeRows;
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
