import { DATA } from "./_user";

// "Something moved on the board" as a number on the panel's rail button (Gerdr's ctx.badge): the user works in Code
// and only sees the board when they open it, so a card that went to 等你 / 待验收 / 已完成, or a new one, went unseen
// until they happened to look. Counted by tasks.sync (every minute, page open or not) against the columns it saw last
// time; Gerdr clears the badge once the user opens the panel. Not the inbox: that's only what waits on the user, and
// it notifies the phone.

const SEEN = `${DATA}/badge-seen.json`;

export function tellBadge(ctx: Ctx, tasks: { id: string; column: string }[]) {
  const badge = (ctx as any).badge as { add(n?: number): void } | undefined;
  if (!badge?.add) return; // a Gerdr from before ctx.badge
  const now: Record<string, string> = {};
  for (const t of tasks) now[t.id] = t.column;
  let before: Record<string, string> | null = null;
  try {
    before = ctx.fs.stat(SEEN) ? JSON.parse(ctx.fs.read(SEEN)) : null;
  } catch {
    before = null;
  }
  // The first look has nothing to compare with: everything would count as new
  const moved = before ? Object.keys(now).filter((id) => before![id] !== now[id]).length : 0;
  if (!before || moved) ctx.fs.write(SEEN, JSON.stringify(now));
  if (!moved) return;
  try {
    badge.add(moved);
  } catch (err: any) {
    ctx.log(`面板角标没更新：${err?.message ?? err}`);
  }
}
