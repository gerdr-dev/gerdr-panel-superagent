// Work someone asks of the user (DESIGN.md「来自别处的任务」): an event carrying `data.assign`, from any source (a team
// panel, a ticket system). It isn't judged by the secretary: the person asked decides.
//
//   data.assign = { title, body?, by?, agreed?, how?, agent?, repos? }
//     not agreed: a card under 等你 — 同意 (an agent does it: picks agent and repository, sent out at once; or 我自己安排:
//       a task of their own, split as they like) or 拒绝 (with why).
//     agreed: no one to ask (their own, or agreed elsewhere): taken as `how` says at once.
//   data.update = { state: "agreed" | "rejected" | "returned" | "accepted" | "dropped", text? } on the same key: what
//     happened there since (agreed / rejected elsewhere: this card goes; returned: back to work, the worker told why).
//
// Everything said back goes through the event's own reply address with what step it is: `data.step` agree, reject,
// say, deliver. Only a person delivers: the agents' tools have nothing for it, it's the 回复并交付 button.
// Other messages on the same key are follow-ups, like any conversation a task follows (_main.ts followUp).

import { find, load, update, note, type Task } from "./_store";
import { add, drop, start } from "./tasks";
import { wake } from "./_wake";
import { addWait, endWaits } from "./_waits";
import { compact } from "./_main";

export type Assigned = {
  /** ask: waiting for the user to agree; agreed: being done; delivered: waiting for whoever asked; done. */
  state: "ask" | "agreed" | "delivered" | "done";
  by?: string;
  how?: "agent" | "self";
  /** The agent and repositories the source suggested (agent: a Gerdr agent id). */
  agent?: string;
  repos?: string[];
};

type AssignData = { title?: string; body?: string; by?: string; agreed?: boolean; how?: "agent" | "self"; agent?: string; repos?: string[] };

/** An event carrying an assignment or an update to one: handled here (true), or not one (false). */
export async function onAssignEvent(ctx: Ctx, e: GerdrEvent): Promise<{ handled: boolean; task?: string; note?: string }> {
  const a = e.data?.assign as AssignData | undefined;
  const u = e.data?.update as { state?: string; text?: string } | undefined;
  if (!a && !u) return { handled: false };
  const { store } = load(ctx);
  const mine = store.tasks.filter((t) => t.assigned && t.origin?.source === e.source && t.origin?.key === e.key && t.status !== "dropped");
  if (u) return { handled: true, ...(await onUpdate(ctx, mine, u)) };
  if (mine.some((t) => t.status !== "done")) return { handled: true, note: "已经有这个任务了" };
  const ev = compact(e);
  const origin = { id: e.id, source: e.source, kind: e.kind, key: e.key, title: e.title, url: e.url, reply: e.reply };
  const title = (a!.title || e.title || "").trim();
  const body = (a!.body ?? e.text ?? "").trim();
  const assigned: Assigned = { state: a!.agreed ? "agreed" : "ask", by: a!.by || ev.who, how: a!.how, agent: a!.agent, repos: a!.repos };
  const threads = e.key ? [{ source: e.source, key: e.key }] : undefined;
  if (a!.agreed && a!.how === "self") {
    const t = await add({ owner: "human", title, steps: body, origin, threads, assigned } as any, ctx);
    return { handled: true, task: t.id };
  }
  const repo = a!.repos?.find((r) => ctx.dirs.stat(r)?.dir);
  const t = await add({ title, prompt: body || title, repo, agent: a!.agent, origin, threads, assigned } as any, ctx);
  // Agreed (or nobody to ask) and an agent does it: out at once; without a repository the secretary picks one
  if (a!.agreed) await start({ id: t.id }, ctx).catch((err: any) => ctx.log(`${t.id} 没派出去：${err?.message ?? err}`));
  return { handled: true, task: t.id };
}

async function onUpdate(ctx: Ctx, mine: Task[], u: { state?: string; text?: string }) {
  if (!mine.length) return { note: "这里没有这个任务" };
  const text = (u.text ?? "").trim();
  for (const t of mine) {
    switch (u.state) {
      case "agreed":
      case "rejected":
        // Decided on another computer of theirs: this card goes
        if (t.assigned?.state === "ask") await drop({ id: t.id, reason: u.state === "agreed" ? "在别的电脑上同意了" : "在别的电脑上拒绝了" }, ctx);
        break;
      case "accepted":
        update(ctx, (s) => {
          const x = find(s, t.id);
          Object.assign(x, { status: "done", doneAt: Date.now(), updatedAt: Date.now(), assigned: { ...x.assigned, state: "done" } });
          endWaits(x, (w) => w.what.startsWith(DELIVERED), "通过了");
          note(x, `对方验收通过了${text ? `：${text}` : ""}`);
        });
        break;
      case "returned":
        // Back to work, with what's wrong: an agent's worker is told; one's own task is back under 等你
        update(ctx, (s) => {
          const x = find(s, t.id);
          x.assigned = { ...(x.assigned as Assigned), state: "agreed" };
          endWaits(x, (w) => w.what.startsWith(DELIVERED), "打回了");
          note(x, `对方打回了：${text}`);
          x.updatedAt = Date.now();
        });
        if (t.owner === "agent" && t.session)
          await wake(ctx, t.id, { how: "对方打回了", text: `[任务面板] 发起人没通过：\n\n${text}\n\n照这个改，改完在回复里说改了什么。`, resume: true });
        break;
      case "dropped":
        if (t.status !== "done") await drop({ id: t.id, reason: `对方不要了${text ? `：${text}` : ""}` }, ctx);
        break;
    }
  }
  return { task: mine[0].id };
}

/** The wait a delivered task shows while whoever asked looks at it. */
const DELIVERED = "等发起人验收";

function assignedTask(ctx: Ctx, id: string) {
  const t = find(load(ctx).store, id);
  if (!t.assigned || !t.origin?.reply) throw new Error(`${id} 不是别人指给你的任务`);
  return t;
}

function tell(ctx: Ctx, t: Task, text: string, data: Record<string, unknown>) {
  const ev = (ctx as any).events;
  if (!ev?.reply) throw new Error("这个 Gerdr 还没有事件功能：升级 Gerdr 后再用");
  return ev.reply(t.origin as any, text, data);
}

/**
 * The user agrees: { id, how: "agent" | "self", agent?, repo?, prompt? }. agent: sent out at once (with the agent and
 * repository chosen, else the suggested ones); self: it becomes a task of their own (split it with new tasks from it).
 * A task already agreed as self can still go to an agent this way (how: "agent").
 */
export async function agree(input: { id: string; how: "agent" | "self"; agent?: string; repo?: string; prompt?: string }, ctx: Ctx) {
  const t = assignedTask(ctx, input.id);
  // Agreed to arrange it themselves (or one's own task, which arrives agreed), then handing it to an agent after all
  if (t.assigned!.state === "agreed" && t.assigned!.how === "self" && input.how === "agent" && t.owner === "human") {
    tell(ctx, t, "", { step: "how", how: "agent" });
    update(ctx, (s) => {
      const x = find(s, t.id);
      const prompt = (input.prompt ?? x.steps ?? x.title).trim();
      Object.assign(x, { owner: "agent", prompt, status: "todo", updatedAt: Date.now(), assigned: { ...x.assigned, how: "agent" } });
    });
    return start({ id: t.id, repo: input.repo || t.repo || t.assigned!.repos?.[0], agent: input.agent || t.agent }, ctx);
  }
  if (t.assigned!.state !== "ask") throw new Error(`${t.id} 已经同意过了`);
  if (input.how !== "agent" && input.how !== "self") throw new Error("how 只能是 agent 或 self");
  tell(ctx, t, "", { step: "agree", how: input.how });
  if (input.how === "self") {
    update(ctx, (s) => {
      const x = find(s, t.id);
      Object.assign(x, { owner: "human", steps: input.prompt ?? x.prompt, status: "todo", updatedAt: Date.now(), assigned: { ...x.assigned, state: "agreed", how: "self" } });
    });
    return find(load(ctx).store, t.id);
  }
  update(ctx, (s) => {
    const x = find(s, t.id);
    Object.assign(x, { assigned: { ...x.assigned, state: "agreed", how: "agent" }, ...(input.prompt ? { prompt: input.prompt } : {}) });
  });
  return start({ id: t.id, repo: input.repo || t.repo || t.assigned!.repos?.[0], agent: input.agent || t.agent }, ctx);
}

/** The user says no: { id, reason } — told to whoever asked; the card goes. */
export async function decline(input: { id: string; reason: string }, ctx: Ctx) {
  const t = assignedTask(ctx, input.id);
  if (t.assigned!.state !== "ask") throw new Error(`${t.id} 已经同意了：不做就放弃它，并在回复里说一声`);
  const why = input.reason?.trim();
  if (!why) throw new Error("写一句为什么不做");
  tell(ctx, t, why, { step: "reject" });
  return drop({ id: t.id, reason: `拒绝了：${why}` }, ctx);
}

/**
 * The user answers whoever asked: { id, text, deliver? }. deliver: it's done as far as they're concerned (after they
 * looked at the work themselves); it waits for whoever asked to accept or return it.
 */
export async function replyOrigin(input: { id: string; text: string; deliver?: boolean }, ctx: Ctx) {
  const t = assignedTask(ctx, input.id);
  const text = input.text?.trim();
  if (!text) throw new Error(input.deliver ? "交付要写一句：做了什么、怎么看结果" : "说点什么");
  if (input.deliver && t.assigned!.state !== "agreed") throw new Error(t.assigned!.state === "ask" ? "还没同意" : `${t.id} 已经交付过了`);
  tell(ctx, t, text, { step: input.deliver ? "deliver" : "say" });
  return update(ctx, (s) => {
    const x = find(s, t.id);
    note(x, `${input.deliver ? "交付了" : "回复了"}：${text}`);
    if (input.deliver) {
      x.assigned = { ...(x.assigned as Assigned), state: "delivered" };
      // Woken by whatever happens on that conversation (accepted, returned, a question): it's theirs now
      addWait(x, { kind: "reply", what: `${DELIVERED}${x.assigned.by ? `（${x.assigned.by}）` : ""}`, ...(x.origin?.key ? { on: { source: x.origin.source, key: x.origin.key } } : {}) } as any);
    }
    x.updatedAt = Date.now();
    return x;
  });
}
