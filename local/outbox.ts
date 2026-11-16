// What a worker says to the people in a chat its task follows (board.ts reply_message), when 设置 → 回话 is "review":
// the words wait as a card in the worker's chat (ui/src/cards.tsx "task-outgoing") and on the task's card, and the user
// sends them or lets them go. Unlike ask_human nothing waits on it: the worker carries on, and never hears which the
// user chose (2026-11-16, the user: "无论点击是否，ai 都不用知道"). DESIGN.md「回话先过目」.

import { find, load, note, update } from "./_store";

function split(ref: string): [string, string] {
  const [task, id] = String(ref ?? "").split("~");
  if (!task || !id) throw new Error(`不认识的待发送消息：${ref}`);
  return [task, id];
}

/** The card asks how one stands: { ref: "t5~o1" } → { state, text, where, doneAt, edited } or { state: "missing" }. */
export function status(input: { ref: string }, ctx: Ctx) {
  const [task, id] = split(input?.ref);
  const t = load(ctx).store.tasks.find((x) => x.id === task);
  const o = t?.outbox?.find((x) => x.id === id);
  if (!o) return { state: "missing" };
  return { state: o.state, text: o.text, where: o.where, doneAt: o.doneAt, edited: o.edited };
}

/**
 * The user sends it: { ref, text? } (text: their own wording instead). Sent through the message's own reply address,
 * the same way for every source. The worker isn't told.
 */
export async function send(input: { ref: string; text?: string }, ctx: Ctx) {
  const [task, id] = split(input?.ref);
  const t = find(load(ctx).store, task);
  const o = t.outbox?.find((x) => x.id === id);
  if (!o) throw new Error(`${input.ref} 不在了`);
  if (o.state !== "pending") throw new Error(o.state === "sent" ? "已经发过了" : "已经选了不发");
  const text = (input.text ?? o.text).trim();
  if (!text) throw new Error("内容是空的");
  const ev = (ctx as any).events;
  if (!ev?.reply) throw new Error("这个 Gerdr 还没有事件功能：升级 Gerdr 后再用");
  ev.reply(o.to as any, text);
  return update(ctx, (s) => {
    const x = find(s, task);
    const y = x.outbox!.find((z) => z.id === id)!;
    Object.assign(y, { state: "sent", doneAt: Date.now(), ...(text !== o.text ? { text, edited: true } : {}) });
    note(x, `发给了 ${y.where}：${text}`);
    x.updatedAt = Date.now();
    return { ref: input.ref, state: y.state };
  });
}

/** The user lets it go: { ref }. Nothing is sent, nobody is told. */
export function skip(input: { ref: string }, ctx: Ctx) {
  const [task, id] = split(input?.ref);
  return update(ctx, (s) => {
    const x = find(s, task);
    const y = x.outbox?.find((z) => z.id === id);
    if (!y) throw new Error(`${input.ref} 不在了`);
    if (y.state !== "pending") throw new Error(y.state === "sent" ? "已经发过了" : "已经选了不发");
    Object.assign(y, { state: "skipped", doneAt: Date.now() });
    note(x, `没发给 ${y.where}：${y.text}`);
    x.updatedAt = Date.now();
    return { ref: input.ref, state: y.state };
  });
}
