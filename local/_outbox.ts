// Holding a worker's message for the user (outbox.ts has what the card and the page call, and why).

import { find, note, update, type Outgoing, type Task } from "./_store";

/** The pending ones of a task, oldest first. */
export function pending(t: Task): Outgoing[] {
  return (t.outbox ?? []).filter((o) => o.state === "pending");
}

/** Puts a message in the task's outbox; returns it (its card ref is `<task>~<id>`). */
export function hold(ctx: Ctx, taskId: string, text: string, to: Outgoing["to"], where: string): Outgoing {
  return update(ctx, (s) => {
    const t = find(s, taskId);
    const n = (t.outbox ?? []).reduce((m, o) => Math.max(m, Number(o.id.slice(1)) || 0), 0) + 1;
    const o: Outgoing = { id: `o${n}`, text, to, where, at: Date.now(), state: "pending" };
    t.outbox = [...(t.outbox ?? []), o];
    note(t, `写好了要发给 ${where} 的话，等你决定发不发`);
    t.updatedAt = Date.now();
    return o;
  });
}

/** The pending ones going to the conversation an event is in (same source and thread / DM), oldest first. */
export function pendingFor(t: Task, e: { source: string; key?: string }): Outgoing[] {
  return pending(t).filter((o) => o.to.source === e.source && (o.to.key ?? "") === (e.key ?? ""));
}

/** How pending drafts read in a message to the worker: one line each, with the id its tools take. */
export function draftLines(l: Outgoing[]): string {
  return l.map((o) => `- ${o.id}（回给 ${o.where}）：${o.text.replace(/\s*\n\s*/g, " ")}`).join("\n");
}

/**
 * The worker takes back a draft the user hasn't chosen on yet (board.ts drop_reply, reply_message replaces): the
 * conversation moved on (the user answered there themselves, the other side asked something else) and it no longer
 * fits. The card shows it struck through with the reason.
 */
export function withdraw(ctx: Ctx, taskId: string, id: string, reason: string): Outgoing {
  return update(ctx, (s) => {
    const t = find(s, taskId);
    const o = t.outbox?.find((x) => x.id === id);
    if (!o) throw new Error(`没有待发送的 ${id}（${taskId} 的有：${(t.outbox ?? []).map((x) => x.id).join("、") || "无"}）`);
    if (o.state !== "pending") throw new Error(o.state === "sent" ? `${id} 用户已经发出去了，撤不回` : `${id} 已经不在待发送里了`);
    Object.assign(o, { state: "withdrawn", doneAt: Date.now(), reason });
    note(t, `撤回了要发给 ${o.where} 的话（${reason}）：${o.text}`);
    t.updatedAt = Date.now();
    return o;
  });
}
