// What a task waits on — one record for every kind, so where a task stands follows from one place.
//
// Before (until 2026-11-04) each kind had its own field, its own wake-up path and its own rules for "is it stopped?":
// a worker's question in t.question, a wait_for in t.waiting, an MR in t.delivery, the user's steps in t.blockedBy,
// the sessions it handed work to only in Gerdr's session list. Every new kind meant touching column(), stopped(),
// silentStop(), the card, the chat card and the 在等 list — and the gaps were the bugs: a worker saying "I'll wait"
// with nothing to wake it (t29), one reporting "working" and stopping (t30), an MR wait nobody could see in the chat.
//
// Now a task has `waits`: each says what it waits for, whether that's the user, and what ends it. Two kinds are
// registered by the worker's own calls (a reply / a time with wait_for, a question for the user); three are kept in
// step with what they mirror on every write (sync): the MR it delivers in, the user's board items it's blocked by, the
// sessions it handed work to. The board reads only this:
//
//   未完成的等待里有等你的   → 等你
//   worker 在跑，或者还有等待 → 进行中
//   都没有、worker 也停了     → 停下了（等你，要你看一眼）
//
// Every wake-up goes one way too (_wake.ts): it ends the waits it answers, with how, and tells the worker.

import type { Store, Task } from "./_store";

export type WaitKind = "reply" | "time" | "mr" | "session" | "user" | "task";

export type Wait = {
  id: string;
  kind: WaitKind;
  /** What it waits for, in words: the card, the chat card and the 在等 list show it. */
  what: string;
  since: number;
  /** It waits on the user (a question, a step, a helper's approval): the task goes under 等你. */
  user?: boolean;
  /** What wakes it. reply / mr: a message in this conversation (an event's source + key); where: it in words. */
  on?: { source: string; key: string };
  where?: string;
  /** time: when it's woken to look again. */
  at?: number;
  /** session: the session it handed work to. */
  session?: string;
  /** user / task: the board item it's blocked by (the user's step, or another task); a user wait without one is a
   * question answered in the chat or on the card. */
  item?: string;
  url?: string;
  /** Long waits (an MR) are woken more than once without ending: the last time, and by what. */
  woke?: { how: string; at: number };
  /** How it ended: what came, or why it no longer applies. */
  end?: { how: string; at: number };
};

const KEEP_ENDED = 12;

export function open(t: Task): Wait[] {
  return (t.waits ?? []).filter((w) => !w.end);
}

export function addWait(t: Task, w: Omit<Wait, "id" | "since"> & { since?: number }): Wait {
  const n = (t.waits ?? []).reduce((m, x) => Math.max(m, Number(x.id.slice(1)) || 0), 0) + 1;
  const out: Wait = { ...w, id: `w${n}`, since: w.since ?? Date.now() };
  t.waits = [...(t.waits ?? []), out];
  return out;
}

/** Ends the open waits `pick` selects, saying how. Returns them. */
export function endWaits(t: Task, pick: (w: Wait) => boolean, how: string): Wait[] {
  const now = Date.now();
  const ended = open(t).filter(pick);
  for (const w of ended) w.end = { how, at: now };
  if (ended.length) trim(t);
  return ended;
}

function trim(t: Task) {
  const ws = t.waits ?? [];
  const ended = ws.filter((w) => w.end);
  if (ended.length <= KEEP_ENDED) return;
  const drop = new Set(ended.slice(0, ended.length - KEEP_ENDED));
  t.waits = ws.filter((w) => !drop.has(w));
}

/**
 * Something needs the user's say on this task (a worker's question, a closed MR, a stop it didn't explain): a wait on
 * the user with no board item — answered in its chat or on the card (tasks.answer). The same question twice is one.
 */
export function askUser(t: Task, text: string): Wait {
  const same = open(t).find((w) => w.kind === "user" && !w.item && w.what === text);
  return same ?? addWait(t, { kind: "user", what: text, user: true });
}

/** The open question to the user (no board item): what the card and the origin's chat are told. */
export function question(t: Task): string | undefined {
  return open(t).find((w) => w.kind === "user" && !w.item)?.what;
}

/** Ends the open questions (the user answered, or the worker moved on). */
export function endQuestions(t: Task, how: string) {
  return endWaits(t, (w) => w.kind === "user" && !w.item, how);
}

/** The worker's own waits on outside (wait_for): a reply, a time. */
export function isOutside(w: Wait) {
  return w.kind === "reply" || w.kind === "time";
}

// ---- kept in step with what they mirror ----

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

/**
 * Brings the mirrored waits in step, on every write (_store.ts update): the MR it delivers in, the board items it's
 * blocked by; a finished task ends everything. Sessions it handed work to need Gerdr's session list: syncSessions.
 */
export function sync(s: Store) {
  for (const t of s.tasks) {
    if (t.owner !== "agent") continue;
    if (t.status === "done" || t.status === "dropped") {
      endWaits(t, () => true, t.status === "done" ? "任务完成了" : "任务放弃了");
      continue;
    }
    // The MR: one open wait while delivering it
    const d = t.status === "delivering" ? t.delivery : undefined;
    endWaits(t, (w) => w.kind === "mr" && w.url !== d?.url, t.status === "delivering" ? "换了一个 MR" : "不再等这个 MR");
    if (d && !open(t).some((w) => w.kind === "mr")) {
      addWait(t, { kind: "mr", what: `MR !${d.iid} 合并`, url: d.url, on: { source: "gitlab", key: `${d.project}!${d.iid}` }, since: d.since });
    }
    // The user's board items (and any task it's blocked by): open while the item is
    for (const id of t.blockedBy ?? []) {
      const h = s.tasks.find((x) => x.id === id);
      if (!h || h.status === "done" || h.status === "dropped") continue;
      if (!open(t).some((w) => w.item === id))
        addWait(t, h.owner === "human" ? { kind: "user", item: id, what: h.title, user: true, since: h.createdAt } : { kind: "task", item: id, what: `${h.id} ${h.title} 先做完`, since: h.createdAt });
    }
    for (const w of open(t)) {
      if (!w.item) continue;
      const h = s.tasks.find((x) => x.id === w.item);
      if (h && h.status !== "done" && h.status !== "dropped" && t.blockedBy?.includes(h.id)) continue;
      w.end = { how: itemEnd(h), at: Date.now() };
    }
  }
}

function itemEnd(h?: Task) {
  if (!h) return "不在了";
  if (h.status === "dropped") return "不需要了";
  if (h.status !== "done") return "不再挡着它";
  if (h.owner !== "human") return `${h.id} 做完了`;
  const back = h.handBack?.kind === "secret" ? "" : h.handedBack ? `：${h.handedBack}` : "";
  return `${h.handBack?.kind === "choice" || h.handBack?.kind === "questions" ? "你答了" : "你做完了"}${back}`;
}

type Kid = { id: string; title?: string; status: string; waiting?: string; waitingKind?: string; user?: boolean };

/** The sessions its workers handed work to (tasks.ts helpers), as waits: open while they run or wait. */
export function syncSessions(t: Task, kids: Kid[]) {
  if (t.owner !== "agent" || t.status === "done" || t.status === "dropped") return;
  const live = new Map(kids.map((k) => [k.id, k]));
  endWaits(t, (w) => w.kind === "session" && !live.has(w.session!), "回报了 / 结束了");
  for (const k of kids) {
    const what = `它派出的「${k.title || k.id}」${k.status === "waiting" ? `在等：${k.waiting ?? "批准或回答"}` : "在跑"}`;
    const w = open(t).find((x) => x.kind === "session" && x.session === k.id) ?? addWait(t, { kind: "session", session: k.id, what });
    Object.assign(w, { what, user: k.user || undefined });
  }
}

// ---- for people ----

/** What will wake it, in words (the 在等 list, the chat card). */
export function wakeText(w: Wait, t?: Task): string {
  switch (w.kind) {
    case "reply":
      return `${w.where ?? (w.on ? `${w.on.source} ${w.on.key}` : "那个对话")} 一回复就叫醒它`;
    case "time":
      return w.at ? `${hhmm(w.at)} 叫醒它回来看` : "到点叫醒它";
    case "mr": {
      const d = t?.delivery;
      const now = d?.detail ? `现在：${d.detail}${d.checked ? `（${hhmm(d.checked)} 查的）` : ""}。` : "";
      return `${now}每 5 分钟查一次；review 意见、挂掉的流水线叫醒它，能合就自动合`;
    }
    case "session":
      return "它做完会回报，Gerdr 把结果交给 worker";
    case "user":
      return w.item ? `你在看板上做完 / 答了 ${w.item} 就叫醒它` : "你在对话里回复，或在看板上回答，就叫醒它";
    case "task":
      return `${w.item} 做完就叫醒它`;
  }
}
