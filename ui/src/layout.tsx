import { onShowSession } from "@gerdr/core";
import { useEffect } from "react";
import { Outlet } from "react-router";
import { CodeSection, Fusion } from "./components/CodeSection";
import { SettingsSheet } from "./components/SettingsSheet";
import { project, run } from "./lib/gerdr";
import { WholeWindow } from "./lib/portal";
import { usePanelVisible } from "./lib/visible";
import { CodeView, canHostCode, openSettings, showInCode, useSettingsTab } from "./lib/view";

// With a Gerdr that has CodeView, the panel is a Code of its own: Gerdr's own panes and tabs (the same layout Code mode
// shows) beside a list we draw (components/CodeSection.tsx): the secretary, then the tasks grouped by where they stand
// (待办, 进行中, 待验收, 已完成). No board, no workspace groups. The settings sheet is over the whole window.
// An older Gerdr (no CodeView): the board, as Superagent always was (pages/index.tsx), with its own settings sheet and
// its own way of showing a conversation (a drawer)
const hosted = !!CodeView && canHostCode;

export default function Layout() {
  const tab = useSettingsTab();
  // The sheet is on the whole window, so nothing hides it with the panel: leaving the panel closes it
  const visible = usePanelVisible();
  useEffect(() => {
    if (!visible) openSettings(null);
  }, [visible]);
  // A conversation of ours brought up from elsewhere (a notification, the inbox) is a pane like any other
  useEffect(() => (hosted ? onShowSession(project, (session) => (openSettings(null), showInCode(session))) : undefined), []);
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
  if (hosted)
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
    // Scrolls on a phone, where the board grows with its content (max-md:h-auto) instead of filling the screen
    <div className="h-full min-h-0 overflow-y-auto overscroll-y-contain">
      <Outlet />
    </div>
  );
}
