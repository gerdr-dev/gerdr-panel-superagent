import { onShowSession } from "@gerdr/core";
import { useEffect } from "react";
import { Outlet } from "react-router";
import { CodeSection } from "./components/CodeSection";
import { project } from "./lib/gerdr";
import { CodeView, showInCode, useView } from "./lib/view";

// Two views of the same tasks. The default is Code itself (Gerdr's own layout: the same workspaces, tabs and panes
// Code mode shows) with the secretary and its workers at the top of Code's list (components/CodeSection.tsx). The
// other is the board (pages/board.tsx), shown instead of Code when asked for. Only one is mounted: both follow the
// tasks (tasks.list), and two would run it twice.
export default function Layout() {
  const view = useView();
  // In the Code view a conversation of ours brought up from elsewhere (a notification, the inbox) is a pane like any
  // other; in the board view the board's own handler opens its task's drawer
  useEffect(() => {
    if (view !== "code") return;
    return onShowSession(project, (session) => showInCode(session));
  }, [view]);
  if (view === "code" && CodeView) return <CodeView sidebar={<CodeSection />} />;
  return (
    // Scrolls on a phone, where the board grows with its content (max-md:h-auto) instead of filling the screen
    <div className="h-full min-h-0 overflow-y-auto overscroll-y-contain">
      <Outlet />
    </div>
  );
}
