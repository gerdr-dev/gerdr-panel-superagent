import * as core from "@gerdr/core";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import type { SettingsTab } from "../components/SettingsSheet";

// This panel is a Code of its own, made from Code's parts (core CodeView): Gerdr's panes, tabs and terminals as they
// are, and a list we draw ourselves, grouped by where each piece of work stands instead of by workspace. There is no board. What's behind the secretary (设置, 流程, 记忆, 触发器, 定时任务, 去向) is a sheet over Code.
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
  CodeRow?: (props: { pane: string; where?: string; below?: ReactNode }) => ReactNode;
  useCodeRows?: () => CodeRowInfo[];
  newCodeTab?: (opts?: { cwd?: string }) => void;
  closeCodeDrawer?: () => void;
  useCodePaneTag?: (fn: (row: { pane: string; session?: string }) => CodePaneTag | CodePaneTag[] | null) => void;
  jumpInCode?: (session: string, ref: string) => void;
  useCodeDirs?: (dirs: { path: string; name?: string }[]) => void;
  useCodeRowMenu?: (fn: (row: { pane: string; session?: string }) => CodeMenuItem[]) => void;
  useCodeRowDrop?: (fn: (row: { pane: string; session?: string }) => void) => (el: HTMLElement | null) => void;
  showInCodeView?: (session: string, replace?: string) => void;
  useCodeSession?: () => string | undefined;
};
const c = core as unknown as Core;

export const CodeView = c.CodeView;
/** Code's own row for a pane: the rows here look and behave as in Code (its menu, dragging, unread). */
export const CodeRow = c.CodeRow!;
export const useCodeRows = c.useCodeRows!;
/** A place Code's rows can be dropped on (a group of ours). Without it (an older Gerdr): nothing lands, the buttons still move. */
export const useCodeRowDrop: (fn: (row: { pane: string; session?: string }) => void) => (el: HTMLElement | null) => void = c.useCodeRowDrop ?? (() => () => {});
export type CodeMenuItem = { id: string; label: string; icon?: ReactNode; disabled?: boolean; onSelect?: () => void; children?: CodeMenuItem[] };
/** Our items in a pane's ⋯ menu and its row's right-click menu (移到…). Without it (an older Gerdr): none there. */
export const useCodeRowMenu: (fn: (row: { pane: string; session?: string }) => CodeMenuItem[]) => void = c.useCodeRowMenu ?? (() => {});
/** The folders offered on Code's new-conversation page while we show: ours (设置 → 仓库), not Code's workspaces. */
export const useCodeDirs: (dirs: { path: string; name?: string }[]) => void = c.useCodeDirs ?? (() => {});
/** Close a phone's drawer (Code's list), before showing what opens behind it. */
export const closeCodeDrawer = () => c.closeCodeDrawer?.();
export type CodePaneTag = { label: string; icon?: ReactNode; tone?: "warn" | "ok" | "brand"; title?: string; items?: CodeMenuItem[] };
/** A tag after a pane's title (a task's number and status, tapped to move it). Without it (an older Gerdr): none. */
export const useCodePaneTag: (fn: (row: { pane: string; session?: string }) => CodePaneTag | CodePaneTag[] | null) => void = c.useCodePaneTag ?? (() => {});
/** Show a conversation in Code scrolled to one of its cards (a question waiting on the person). An older Gerdr: just shows it. */
export const jumpInCode = (session: string, ref: string) => (c.jumpInCode ? c.jumpInCode(session, ref) : c.showInCodeView?.(session));
export const newCodeTab = (opts?: { cwd?: string }) => c.newCodeTab?.(opts);
// All of it or nothing: the list is ours to draw (list="replace"), from Code's rows
export const canHostCode = !!c.CodeView && !!c.showInCodeView && !!c.CodeRow && !!c.useCodeRows;
export const showInCode = (session: string, replace?: string) => c.showInCodeView?.(session, replace);
export const useCodeSession: () => string | undefined = c.useCodeSession ?? (() => undefined);

/** The settings sheet's open tab; null = Code. Not kept across reloads: coming back, one wants Code. */
let settings: SettingsTab | null = null;
const subs = new Set<() => void>();

export function openSettings(tab: SettingsTab | null) {
  // Opened from the list: on a phone that list is Gerdr's drawer, over everything
  if (tab) c.closeCodeDrawer?.();
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
