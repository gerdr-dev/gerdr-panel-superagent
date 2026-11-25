// A conversation the person opens themselves on the page (Cmd+T, 进行中's +, the new-conversation page's 开始): a task
// from the start, like the secretary's (the person, 2026-11-25: 「我希望他就是任务」, and earlier: don't treat the ones I
// open differently from the secretary's). Gerdr's new-conversation page hands its start to the panel (core
// useCodeStart); here it becomes a task whose worker starts empty, with the panel's tools and rules, and waits for the
// person's first message. Its title follows Gerdr's auto title of that message (autoTitle).

import { add, drop, start } from "./tasks";

/** { cwd, agent? } → { task, session }: the worker to put in the pane. */
export async function run(input: { cwd: string; agent?: string }, ctx: Ctx) {
  const cwd = String(input?.cwd ?? "").trim();
  if (!cwd) throw new Error("要给目录（cwd）");
  const agent = input?.agent || undefined;
  // No title: the task takes the conversation's auto title once the person has said something
  const t = await add({ title: "新会话", autoTitle: true, prompt: "你自己新开的对话：要做什么看你的第一条消息。", repo: cwd, ...(agent ? { agent } : {}) } as any, ctx);
  try {
    const out: any = await start({ id: t.id, repo: cwd, ...(agent ? { agent } : {}), quiet: true }, ctx);
    return { task: t.id, session: out?.session as string };
  } catch (e) {
    await drop({ id: t.id }, ctx).catch(() => {});
    throw e;
  }
}
