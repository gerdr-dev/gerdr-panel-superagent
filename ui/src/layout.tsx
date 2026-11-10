import { Outlet } from "react-router";
import "./lib/gerdr";

// Two views of the same tasks: the secretary (pages/index.tsx) and the board (pages/board.tsx). Their settings, workflow (流程) and schedules (定时任务) are in the settings sheet (settings/).
export default function Layout() {
  return (
    // Scrolls on a phone, where the board grows with its content (max-md:h-auto) instead of filling the screen
    <div className="h-full min-h-0 overflow-y-auto overscroll-y-contain">
      <Outlet />
    </div>
  );
}
