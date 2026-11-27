import { onShowSession } from "@gerdr/core";
import { useEffect } from "react";
import { Outlet } from "react-router";
import { CodeSection, Fusion } from "./components/CodeSection";
import { SettingsSheet } from "./components/SettingsSheet";
import { project, run } from "./lib/gerdr";
import { WholeWindow } from "./lib/portal";
import { usePanelVisible } from "./lib/visible";
import { CodeView, canHostCode, openSettings, showInCode, useSettingsTab } from "./lib/view";

// The panel is a Code of its own: Gerdr's own panes and tabs (the same layout Code mode shows) beside a list we draw
// (components/CodeSection.tsx): the secretary, then the tasks grouped by where they stand (待办, 进行中, 待验收, 已完成).
// No board (2026-11-25, the person: no fallback to it on an older Gerdr either), no workspace groups. The settings sheet takes
// Code's place while it's open: the panel's own overlays aren't drawn over Code.
export default function Layout() {
  const tab = useSettingsTab();
  // The sheet is on the whole window, so nothing hides it with the panel: leaving the panel closes it
  const visible = usePanelVisible();
  useEffect(() => {
    if (!visible) openSettings(null);
  }, [visible]);
  // A conversation of ours brought up from elsewhere (a notification, the inbox) is a pane like any other
  useEffect(() => onShowSession(project, (session) => (openSettings(null), showInCode(session))), []);
  // 去向 names tasks: go to the task's conversation
  const toTask = (id: string) =>
    run<{ session?: string }>("tasks.get", { id }).then(
      ({ session }) => {
        openSettings(null);
        if (session) showInCode(session);
      },
      () => openSettings(null),
    );
  // Code stays hosted under the settings sheet. Shown in Code's place instead (as it first was), opening the sheet
  // took Code away: on a phone the drawer's list turned into Code's default one and the sheet opened behind the drawer
  if (CodeView && canHostCode)
    return (
      <>
        {/* Fusion is mounted with the panel; the list it draws is only in the page while Code's list is (CodeSection) */}
        <Fusion>
          <CodeView list="replace" sidebar={<CodeSection />} />
        </Fusion>
        {/* Over the whole window, Gerdr's bars included (lib/portal.ts WholeWindow) */}
        {tab && (
          <WholeWindow>
            <SettingsSheet tab={tab} onTab={openSettings} onClose={() => openSettings(null)} onTask={(id) => void toTask(id)} />
          </WholeWindow>
        )}
      </>
    );
  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-y-contain">
      {!canHostCode && (
        <div className="mx-auto max-w-md px-6 py-16 text-center text-[13px] text-muted-foreground">
          <div className="pb-2 text-[15px] font-medium text-foreground">这个面板要显示在 Code 里</div>
          这份 Gerdr 太旧，还不能把面板显示在 Code 里。升级 Gerdr 后，这里就是 Code 加秘书。
          <div className="pt-4">
            <button className="rounded-md border px-3 py-1.5 text-foreground hover:bg-accent/60" onClick={() => openSettings("settings")}>
              打开设置
            </button>
          </div>
        </div>
      )}
      <Outlet />
      {tab && <SettingsSheet tab={tab} onTab={openSettings} onClose={() => openSettings(null)} onTask={(id) => void toTask(id)} />}
    </div>
  );
}
