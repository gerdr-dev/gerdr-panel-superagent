// The panel has no page of its own to look at: it shows in Code (layout.tsx), and what's behind it (settings, where
// outside messages went…) is a sheet over this empty page. The board Superagent has was taken out (2026-11-24, the
// person: 「我不想有看板」): the tasks are the rows in Code's list.
export default function Empty() {
  return null;
}
