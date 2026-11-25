// A conversation the person starts themselves while the panel shows Code: a task from the start, like the
// secretary's (the person, 2026-11-25: 「我希望他就是任务」, and earlier: don't treat the ones I open differently from
// the secretary's). Gerdr hands every start in Code to the panel (core useCodeStart): the new-conversation page
// (Cmd+T, 进行中's +), ⌘D (a copy of the focused one: agent, folder, mode), the overview's new agent, a fork
// (continueFrom). Here it becomes a task whose worker starts with the panel's tools and rules, sends nothing, and
// waits for the person's first message.

import { add, drop, start } from "./tasks";
import { load, update } from "./_store";

/** { cwd, agent?, mode?, continueFrom? } → { task, session }: the worker Code shows. */
export async function run(input: { cwd: string; agent?: string; mode?: string; continueFrom?: string }, ctx: Ctx) {
  const cwd = String(input?.cwd ?? "").trim();
  if (!cwd) throw new Error("要给目录（cwd）");
  const agent = input?.agent || undefined;
  const from = input?.continueFrom ? ctx.sessions.get(input.continueFrom) : undefined;
  if (input?.continueFrom && !from) throw new Error("要分出来的那个对话不在了");
  const was = String(from?.title ?? "").trim();
  // A fresh one is named by Gerdr's auto title of the first message (autoTitle); a fork after the one it came from
  const t = await add(
    (from
      ? { title: `${was || "对话"}（分支）`, prompt: `从对话「${was || input.continueFrom}」分出来的：之前的内容都在上面，接下来做什么看你的下一条消息。` }
      : { title: "新会话", autoTitle: true, blank: true, prompt: "你自己新开的对话：要做什么看你的第一条消息。" }) as any,
    ctx,
  );
  try {
    const out: any = await start(
      { id: t.id, repo: cwd, ...(agent ? { agent } : {}), ...(input?.mode ? { mode: input.mode } : {}), ...(from ? { continueFrom: from.id } : { quiet: true }) },
      ctx,
    );
    return { task: t.id, session: out?.session as string };
  } catch (e) {
    await drop({ id: t.id }, ctx).catch(() => {});
    throw e;
  }
}

/**
 * The person closed the pane of a conversation (core useCodeClosed). A task opened here (blank) that nobody spoke to
 * goes away whole, as an empty tab would (the person, 2026-11-25: ⌘W on one moved on but left it in the list). One
 * with anything said in it stays: closing its pane isn't giving the work up. { session } → { removed? }.
 */
export function closed(input: { session: string }, ctx: Ctx) {
  const id = String(input?.session ?? "");
  const t = load(ctx).store.tasks.find((x) => x.session === id);
  if (!t || !(t as any).blank || t.status !== "running") return {};
  let said: { role: string }[] | null | undefined;
  try {
    said = (ctx.sessions as any).read?.(id, { last: 20 });
  } catch {
    return {};
  }
  // Can't tell (a Gerdr without read): keep it
  if (!Array.isArray(said) || said.some((x) => x.role === "user")) return {};
  update(ctx, (s) => {
    s.tasks = s.tasks.filter((x) => x.id !== t.id);
  });
  return { removed: t.id };
}
