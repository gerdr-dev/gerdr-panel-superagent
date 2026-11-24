import { onShowSession } from "@gerdr/core";
import { useEffect } from "react";
import { Outlet } from "react-router";
import { CodeSection } from "./components/CodeSection";
import { SettingsSheet } from "./components/SettingsSheet";
import { project, run } from "./lib/gerdr";
import { CodeView, canHostCode, openSettings, showInCode, useSettingsTab } from "./lib/view";

// The panel is a Code of its own: Gerdr's own panes and tabs (the same layout Code mode shows) beside a list we draw
// (components/CodeSection.tsx): the secretary, then everything open grouped by where it stands — 等你, 进行中, 待验收,
// 待办 — the secretary's tasks and the person's own conversations together. No board, no workspace groups. The settings sheet takes
// Code's place while it's open: the panel's own overlays aren't drawn over Code.
export default function Layout() {
  const tab = useSettingsTab();
  // A conversation of ours brought up from elsewhere (a notification, the inbox) is a pane like any other
  useEffect(() => onShowSession(project, (session) => (openSettings(null), showInCode(session))), []);
  // 去向 names tasks: go to the task's conversation
  const toTask = (id: string) =>
    run<{ tasks: { id: string; session?: string }[] }>("tasks.list").then(
      (r) => {
        const s = r.tasks.find((t) => t.id === id)?.session;
        openSettings(null);
        if (s) showInCode(s);
      },
      () => openSettings(null),
    );
  // Code stays hosted under the settings sheet. Shown in Code's place instead (as it first was), opening the sheet
  // took Code away: on a phone the drawer's list turned into Code's default one and the sheet opened behind the drawer
  if (CodeView && canHostCode)
    return (
      <>
        <CodeView list="replace" sidebar={<CodeSection />} />
        {tab && <SettingsSheet tab={tab} onTab={openSettings} onClose={() => openSettings(null)} onTask={(id) => void toTask(id)} />}
      </>
    );
  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-y-contain">
      {!canHostCode && (
        <div className="mx-auto max-w-md px-6 py-16 text-center text-[13px] text-muted-foreground">
          <div className="pb-2 text-[15px] font-medium text-foreground">这个面板要显示在 Code 里</div>
          现在这份 Gerdr 界面没有 CodeView（实验中的接口，界面被重新同步后会丢）。重新同步带 CodeView 的界面后，这里就是 Code 加秘书。
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
