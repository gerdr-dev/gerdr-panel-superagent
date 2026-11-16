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
