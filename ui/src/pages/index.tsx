import { BoardPage } from "../components/TaskDetail";
import { canHostCode, CodeView } from "../lib/view";

// With CodeView the panel shows in Code (layout.tsx) and this page has nothing of its own: what's behind it (settings,
// where outside messages went…) is a sheet over it. The board was taken out there (2026-11-24, the person: 「我不想有看板」).
// A Gerdr without CodeView still gets the board, so updating the panel there breaks nothing.
export default function Index() {
  return CodeView && canHostCode ? null : <BoardPage />;
}
