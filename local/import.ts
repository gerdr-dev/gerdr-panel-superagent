// Bringing in what the person already has in Code, once, by their choice (the page's 从 Code 导入): the project's
// workspaces as repositories (设置 → 仓库), and conversations as tasks. The panel lists only its own tasks; a Code
// conversation isn't one until it's brought in (the person, 2026-11-25: Code is 「一个可选的一次性导入」).
//
// A conversation isn't moved, it is carried on: a task is made for it and its worker starts as any worker does (the
// panel's tools, skills and rules, which only a conversation the panel started has) with `continueFrom` the original,
// so the chat so far is above and the agent knows it. The original is then closed (kept, readable). Nothing of this
// needs Gerdr to know about importing: listing conversations and carrying one on are all it gives.

import { workflow } from "./_config";
import { set as setSettings } from "./settings";
import { add, start } from "./tasks";

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/**
 * { repos?: [path…], sessions?: [id…] } → what was done, one entry per item. A conversation still running is refused
 * (it can't be carried on mid-turn): import it once it stops.
 */
export async function run(input: { repos?: string[]; sessions?: string[] }, ctx: Ctx) {
  const out: { repos: string[]; tasks: { session: string; task: string; worker?: string }[]; failed: { session: string; why: string }[] } = { repos: [], tasks: [], failed: [] };
  const have = workflow(ctx).repos;
  const fresh = [...new Set((input?.repos ?? []).map((p) => p.replace(/\/+$/, "")).filter(Boolean))].filter((p) => !have.some((r) => r.path.replace(/\/+$/, "") === p));
  if (fresh.length) {
    setSettings({ repos: [...have, ...fresh.map((path) => ({ path }))] }, ctx);
    out.repos = fresh;
  }
  for (const id of input?.sessions ?? []) {
    try {
      const s = ctx.sessions.get(id);
      if (!s) throw new Error("这个对话不在了");
      if ((s as any).tags?.panel === ctx.workspace.project) throw new Error("已经是这个面板的对话了");
      if (s.status === "running" || s.status === "starting") throw new Error("还在跑：等它这一轮停下再导入");
      if (s.status === "waiting") throw new Error("它在等你审批 / 回答：先在 Code 里处理掉再导入");
      const title = s.title || base(s.cwd);
      const t = await add({ title, prompt: `接着 Code 里的对话「${title}」做（从 Code 导入的，之前的内容都在上面）。`, repo: s.cwd, agent: s.agent } as any, ctx);
      const started: any = await start({ id: t.id, agent: s.agent, continueFrom: id }, ctx);
      // The original goes off the screen (its tab closes); it is kept and can be reopened from Code's history
      await ctx.sessions.close(id).catch(() => {});
      out.tasks.push({ session: id, task: t.id, worker: started?.session });
    } catch (e: any) {
      out.failed.push({ session: id, why: String(e?.message ?? e) });
    }
  }
  return out;
}
