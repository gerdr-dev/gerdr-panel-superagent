import { onShowSession } from "@gerdr/core";
import { useEffect } from "react";
import { Outlet } from "react-router";
import { CodeSection } from "./components/CodeSection";
import { SettingsSheet } from "./components/SettingsSheet";
import { project, run } from "./lib/gerdr";
import { CodeView, canHostCode, openSettings, showInCode, useSettingsTab } from "./lib/view";

// The panel is Code itself (Gerdr's own layout: the same workspaces, tabs and panes Code mode shows) with the
// secretary and its tasks at the top of Code's list (components/CodeSection.tsx). No board. The settings sheet takes
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
  if (!tab && CodeView) return <CodeView sidebar={<CodeSection />} />;
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
