// The secretary's own questions to the user (DESIGN.md「秘书的问题」): ask_human / cancel_human called from the
// secretary's conversation land here instead of on a task. Before this the secretary asked in its reply text, its turn
// ended, nothing marked it, and the user missed it (2026-11-19: "我会漏看"). Same card as a worker's ask (cards.tsx
// TaskStep, ref sN); the 秘书 button counts the open ones; the user answers on the card or closes one unanswered.

import { secIgnoredLead, state, toMain, updateState, type SecAsk } from "./_main";
import { noteIgnored } from "./_store";

const SHOWN = "这个问题已经作为卡片显示在你的对话里，用户能直接在卡片上答，任务列表里「秘书」那一行也会亮着「等你」计数：回复里不要再把问题、选项写一遍，一句话说为什么要问就够了。";

export function isSecAsk(id: string) {
  return /^s\d+$/.test(String(id ?? "").split("#")[0]);
}

function findSec(asks: SecAsk[] | undefined, id: string): SecAsk {
  const a = (asks ?? []).find((x) => x.id === id);
  if (!a) throw new Error(`没有 ${id} 这个问题`);
  return a;
}

/** ask_human from the secretary's conversation: { title, steps?, options?, multi?, handBack?, replaces? }. */
export function secAsk(input: any, ctx: Ctx) {
  if (input?.handBack?.kind === "secret") throw new Error("秘书不收密钥：要密钥的事派给 worker，由它用 ask_human 在任务上问");
  const title = String(input?.title ?? "").trim();
  if (!title) throw new Error("title 是要问的事");
  const options = Array.isArray(input?.options) ? input.options.map(String).filter(Boolean) : [];
  const kind: SecAsk["kind"] = options.length ? "choice" : input?.handBack?.kind === "none" ? "none" : "value";
  const replaced = (Array.isArray(input?.replaces) ? input.replaces : input?.replaces ? [input.replaces] : []).map(String);
  const a = updateState(ctx, (x) => {
    x.asks ??= [];
    for (const id of replaced) {
      const old = x.asks.find((y) => y.id === id && y.status === "open");
      if (old) Object.assign(old, { status: "dropped", reason: "换成了新的问题", doneAt: Date.now() });
    }
    const n = x.nextAsk ?? 1;
    // Messages waiting on a replaced question wait on this one (decide's wait links them by id)
    for (const it of x.items ?? []) if (it.state === "waiting" && it.ask && replaced.includes(it.ask)) it.ask = `s${n}`;
    x.nextAsk = n + 1;
    const a: SecAsk = {
      id: `s${n}`,
      title,
      steps: input?.steps ? String(input.steps) : undefined,
      kind,
      options: options.length ? options : undefined,
      multi: options.length && input?.multi === true ? true : undefined,
      label: input?.handBack?.label,
      status: "open",
      at: Date.now(),
    };
    x.asks.push(a);
    // Kept: the open ones and the last 50 settled (their cards still ask how they ended)
    const settled = x.asks.filter((y) => y.status !== "open");
    if (settled.length > 50) x.asks = x.asks.filter((y) => y.status === "open" || settled.slice(-50).includes(y));
    return a;
  });
  const project = ctx.workspace.project;
  const choose =
    kind === "choice"
      ? { project, fn: "secretary.answer", input: { id: a.id }, field: "value", options: a.options, multi: a.multi, other: true }
      : kind === "value"
        ? { project, fn: "secretary.answer", input: { id: a.id }, field: "value", options: [], other: true }
        : { project, fn: "secretary.answer", input: { id: a.id }, field: "value", options: ["做完了"], other: false };
  return {
    id: a.id,
    title: a.title,
    note: `${SHOWN} 用户的回答会作为 [你问的 ${a.id}] 发进这段对话（可能过很久）；他也可能忽略它，那时你下一轮开头会知道。不用等它，这一轮照常结束。`,
    gerdrCard: {
      type: "task-step",
      ref: a.id,
      project,
      // 等你, as a worker's cards say (local/board.ts): whose it is, the conversation it's in says
      kicker: "等你",
      title: a.title,
      body: a.steps || undefined,
      tone: kind === "none" ? "warn" : "info",
      choose,
    },
  };
}

/** cancel_human from the secretary's conversation: { id, reason }. */
export function secCancel(input: { id: string; reason: string }, ctx: Ctx) {
  const id = String(input?.id ?? "").split("#")[0];
  const reason = String(input?.reason ?? "").trim() || "撤回";
  const a = updateState(ctx, (x) => {
    const a = findSec(x.asks, id);
    if (a.status === "done") throw new Error(`${id} 用户已经答了：${a.answer ?? "做完了"}`);
    if (a.status === "open") Object.assign(a, { status: "dropped", reason, doneAt: Date.now() });
    return a;
  });
  return { id: a.id, status: "dropped", gerdrCard: { type: "task-taken-back", ref: `${a.id}:taken-back`, title: `撤回了「${a.title}」`, body: reason, tone: "info" } };
}

/** Where one stands, the shape cards.tsx TaskStep reads (as _cardstate.ts askState). */
export function secAskState(a: SecAsk | undefined) {
  if (!a) return { status: "missing" };
  return { status: a.status === "open" ? "todo" : a.status, title: a.title, handedBack: a.answer, kind: a.kind, reason: a.closedByUser ? "你忽略了" : a.reason };
}

export function secStatus(id: string, ctx: Ctx) {
  return secAskState((state(ctx).asks ?? []).find((x) => x.id === id));
}

/** The open ones, oldest first, and every card's state (keyed as cards.tsx looks them up: step:sN). */
export function secAsks(ctx: Ctx) {
  const all = state(ctx).asks ?? [];
  const cards: Record<string, unknown> = {};
  for (const a of all) {
    const { title, ...st } = secAskState(a) as { title?: string };
    cards[`step:${a.id}`] = st;
  }
  return { project: ctx.workspace.project, open: all.filter((a) => a.status === "open").map((a) => ({ id: a.id, title: a.title, kind: a.kind, at: a.at })), cards };
}

/** The user answered on the card: { id, value }. Goes to the secretary as a message of its own, shown whole. */
export async function answerSec(input: { id: string; value?: string }, ctx: Ctx) {
  const value = String(input?.value ?? "").trim();
  const a = updateState(ctx, (x) => {
    const a = findSec(x.asks, String(input?.id ?? ""));
    if (a.status === "done") throw new Error(`已经答了：${a.answer ?? "做完了"}`);
    if (a.status === "dropped") throw new Error(`「${a.title}」已经${a.closedByUser ? "忽略" : "撤回"}了`);
    if (a.kind !== "none" && !value) throw new Error(a.kind === "choice" ? "选一个，或者写下你的决定" : `写下${a.label || "你的回答"}`);
    Object.assign(a, { status: "done", answer: value || undefined, doneAt: Date.now() });
    return a;
  });
  // Messages put on wait for this question (superagent.decide wait + ask): named, so the answer gets them decided
  const waiting = (state(ctx).items ?? []).filter((x) => x.state === "waiting" && x.ask === a.id).map((x) => x.id);
  const then = waiting.length ? `\n在等这个回答的消息：${waiting.join("、")}，照回答用 superagent.decide 给它们决定。` : "";
  const text = (a.kind === "none" ? `[你问的 ${a.id}] 「${a.title}」用户做完了。` : `[你问的 ${a.id}] 「${a.title}」用户的回答：${a.answer}`) + then;
  await toMain(ctx, [text], "user", undefined, false);
  return { ask: a.id, answer: a.answer };
}

/** The user ignored it (the ✕ on its card or its row): { id }. The secretary hears with its next message, not now. */
export function closeSec(input: { id: string }, ctx: Ctx) {
  const a = updateState(ctx, (x) => {
    const a = findSec(x.asks, String(input?.id ?? ""));
    if (a.status !== "open") throw new Error(`「${a.title}」已经不在等你了`);
    // Said with the secretary's next message, whoever sends it (noteIgnored); untold only on a Gerdr without notes
    Object.assign(a, { status: "dropped", closedByUser: true, told: noteIgnored(ctx, x.main, a), doneAt: Date.now() });
    return a;
  });
  return { closed: a.id };
}

/**
 * The secretary's turn started without the board (the user typed in its chat) while it hasn't heard of questions the
 * user ignored: said into that turn now. Called with every session event (tasks.list).
 */
export async function secretaryIgnored(ctx: Ctx) {
  const s = state(ctx);
  if (!s.main || !(s.asks ?? []).some((a) => a.closedByUser && !a.told)) return;
  if (ctx.sessions.get(s.main)?.status !== "running") return;
  const lead = secIgnoredLead(ctx);
  if (lead) await ctx.sessions.send(s.main, lead, { now: true, fold: "你忽略了秘书问的问题" } as any).catch(() => {});
}
