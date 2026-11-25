// Where each of a task's chat cards stands (ui/src/cards.tsx: task-outgoing, task-step, task-wait), worked out from the
// task alone. The cards' own status calls (outbox.status, tasks.status, waits.status) answer with these, and
// tasks.list hands them all out with the board, so a card drawn while the board is loaded starts from its real state
// instead of drawing "still open" and collapsing a moment later — a flash on every switch (2026-11-19).

import { type Ask, type Outgoing, type Task } from "./_store";
import { isOutside, wakeItem, wakeText, type Wait } from "./_waits";

/** A held reply (outbox.status). */
export function outgoingState(o: Outgoing | undefined) {
  if (!o) return { state: "missing" };
  return { state: o.state, text: o.text, where: o.where, doneAt: o.doneAt, edited: o.edited, reason: o.reason };
}

/** An ask, or one question of it (tasks.status). qid: the question, for a card ref like a5#2. */
export function askState(a: Ask, qid?: string) {
  // The card says "todo" while it waits (cards.tsx)
  const st = a.status === "open" ? "todo" : a.status;
  if (qid) {
    const q = a.questions?.find((x) => x.id === qid);
    if (!q) return { status: "missing" };
    const status = q.dropped || a.status === "dropped" ? "dropped" : q.answer ? "done" : "todo";
    // Answered while the ask's other questions aren't: nothing has gone to the worker yet (answerQuestion holds them
    // all). The card said 已处理 and the user waited for a worker that was never told (t93, 2026-11-25)
    const rest = a.status === "open" && q.answer ? (a.questions ?? []).filter((x) => !x.dropped && !x.answer).map((x) => x.title) : [];
    return { status, title: q.title, handedBack: q.answer, kind: q.kind, reason: q.dropped, ...(rest.length ? { rest } : {}) };
  }
  const back = a.handBack.kind === "secret" ? undefined : a.handedBack;
  return { status: st, title: a.title, handedBack: back, kind: a.handBack.kind, reason: a.dropReason };
}

/** Some of t's waits — the ones one wait_for made (waits.status). */
export function waitsState(t: Task, ws: Wait[]) {
  const on = ws.filter((w) => !w.end);
  if (on.length) {
    const woke = on.find((w) => w.woke)?.woke;
    const last = on.find((w) => w.check?.last)?.check?.last;
    return { state: "waiting", body: on.map((w) => wakeText(w)).join("；"), wakes: on.map(wakeItem), woke, check: last };
  }
  // Over: how, plus what the card showed while it waited (its last check, the last wake), so the card keeps its rows
  // and its height (cards.tsx TaskWait)
  const woke = ws.find((w) => w.woke)?.woke;
  const check = ws.find((w) => w.check?.last)?.check?.last;
  const end = ws.map((w) => w.end).filter(Boolean).sort((a, b) => a!.at - b!.at)[0];
  if (end) return { state: "ended", how: end.how, at: end.at, woke, check };
  return { state: "ended", how: t.status === "done" ? "任务完成了" : t.status === "dropped" ? "任务放弃了" : "接着做了", woke, check };
}

/**
 * Every card state of t, keyed the way ui/src/cards.tsx looks them up: out:<task>~<o>, step:<ask>[#q],
 * wait:<task>:<since> (one wait_for's waits share their since: _waits.ts waitOn).
 */
export function cardStates(t: Task): Record<string, unknown> {
  // Sent with every board poll, so without what the card already has: the words unless the user changed them, the
  // titles (cards.tsx draws its own). With them the states were a third of the whole list (2026-11-19)
  const out: Record<string, unknown> = {};
  for (const o of t.outbox ?? []) {
    const { text, ...st } = outgoingState(o) as { text?: string };
    out[`out:${t.id}~${o.id}`] = o.edited ? { ...st, text } : st;
  }
  const step = (a: Ask, q?: string) => {
    const { title, ...st } = askState(a, q) as { title?: string };
    return st;
  };
  for (const a of t.asks ?? []) {
    out[`step:${a.id}`] = step(a);
    for (const q of a.questions ?? []) out[`step:${a.id}#${q.id}`] = step(a, q.id);
  }
  const groups = new Map<number, Wait[]>();
  for (const w of t.waits ?? []) if (isOutside(w)) groups.set(w.since, [...(groups.get(w.since) ?? []), w]);
  for (const [since, ws] of groups) out[`wait:${t.id}:${since}`] = waitsState(t, ws);
  return out;
}
