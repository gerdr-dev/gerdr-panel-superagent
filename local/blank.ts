// A conversation the person starts themselves while the panel shows Code: a task from the start, like the
// secretary's (the person, 2026-11-25: 「我希望他就是任务」, and earlier: don't treat the ones I open differently from
// the secretary's). Gerdr hands every start in Code to the panel (core useCodeStart): the new-conversation page
// (Cmd+T, 进行中's +), ⌘D (a copy of the focused one: agent, folder, mode), the overview's new agent, a fork
// (continueFrom, with fork / forkText: Gerdr's fork dialog, which may fork a running conversation). Here it becomes a task whose worker starts with the panel's tools and rules, sends nothing, and
// waits for the person's first message.

import { add, drop, start, BLANK_TITLE } from "./tasks";

/** { cwd, agent?, mode?, continueFrom?, fork?, forkText? } → { task, session }: the worker Code shows. */
export async function run(input: { cwd: string; agent?: string; mode?: string; continueFrom?: string; fork?: boolean; forkText?: boolean }, ctx: Ctx) {
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
      : { title: BLANK_TITLE, autoTitle: true, blank: true, prompt: "你自己新开的对话：要做什么看你的第一条消息。" }) as any,
    ctx,
  );
  try {
    const out: any = await start(
      { id: t.id, repo: cwd, ...(agent ? { agent } : {}), ...(input?.mode ? { mode: input.mode } : {}), ...(from ? { continueFrom: from.id, fork: !!input.fork, forkText: !!input.forkText } : { quiet: true }) },
      ctx,
    );
    return { task: t.id, session: out?.session as string };
  } catch (e) {
    await drop({ id: t.id }, ctx).catch(() => {});
    throw e;
  }
}

