// What a task waits on — one record for every kind, so where a task stands follows from one place.
//
// Before (until 2026-11-04) each kind had its own field, its own wake-up path and its own rules for "is it stopped?":
// a worker's question in t.question, a wait_for in t.waiting, an MR in t.delivery, the user's steps in t.blockedBy,
// the sessions it handed work to only in Gerdr's session list. Every new kind meant touching column(), stopped(),
// silentStop(), the card, the chat card and the 在等 list — and the gaps were the bugs: a worker saying "I'll wait"
// with nothing to wake it (t29), one reporting "working" and stopping (t30), an MR wait nobody could see in the chat.
//
// Now a task has `waits`: each says what it waits for, whether that's the user, and what ends it. Two kinds are
// registered by the worker's own calls (wait_for: news in a conversation — a colleague's DM, an MR — or a time; a
// question for the user); two are kept in step with what they mirror (sync): the user's board items it's blocked by,
// the sessions it handed work to. An MR is no kind of its own: a way of working (the worker's skill) plus a source of
// events (mrwatch.ts), waited on like any conversation. The board reads only this:
//
//   有直接等你的（问题、批准）→ 等你（等你在看板上做的那一项，是那一项的卡片在等你）
//   worker 在跑，或者还有等待 → 进行中
//   都没有、worker 也停了     → 停下了（等你，要你看一眼）
//
// Every wake-up goes one way too (_wake.ts): it ends the waits it answers, with how, and tells the worker.

import type { Store, Task } from "./_store";

export type WaitKind = "reply" | "check" | "time" | "session" | "user" | "task";

export type Wait = {
  id: string;
  kind: WaitKind;
  /** What it waits for, in words: the card, the chat card and the 在等 list show it. */
  what: string;
  since: number;
  /** It waits on the user (a question, a step, a helper's approval): the task goes under 等你. */
  user?: boolean;
  /** What wakes it. reply: anything new in this conversation — a person's message, an MR's review / pipeline / merge
   * (an event's source + key); where: it in words. */
  on?: { source: string; key: string };
  where?: string;
  /** time: when it's woken to look again. */
  at?: number;
  /**
   * check: a command the worker wrote to tell whether what it waits for has happened (a publish approved, a job done),
   * run by the board every `every` minutes in `cwd`: exit 0 = it has → the worker is woken with its output; any other
   * exit = not yet. last: the latest run, shown on the card. fails: runs in a row that broke (timeout, couldn't start).
   */
  check?: { command: string; cwd: string; every: number; next: number; last?: { at: number; code: number; out: string }; fails?: number };
  /** session: the session it handed work to. */
  session?: string;
  /** user / task: the board item it's blocked by (the user's step, or another task); a user wait without one is a
   * question answered in the chat or on the card. */
  item?: string;
  url?: string;
  /** The last time something woke it without ending it, and what. */
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

/** The worker's own waits on outside (wait_for): news in a conversation, a check it wrote, a time. */
export function isOutside(w: Wait) {
  return w.kind === "reply" || w.kind === "check" || w.kind === "time";
}

/** The task follows a conversation from now on (threads): what comes in it goes to its worker (_main.ts subscribers). */
export function follow(t: Task, on: { source: string; key: string }) {
  const cur = t.threads ?? (t.origin?.key ? [{ source: t.origin.source, key: t.origin.key }] : []);
  if (!cur.some((x) => x.source === on.source && x.key === on.key)) t.threads = [...cur, { source: on.source, key: on.key }];
}

/**
 * The worker waits on outside (wait_for): news in a conversation (the task follows it from now on) and / or a time.
 * Replaces what it waited on outside before: this says what it waits on now. Returns the new waits.
 */
export function waitOn(
  t: Task,
  w: { what: string; conv?: { source: string; key: string; where?: string; url?: string }; check?: { command: string; cwd: string; every: number }; at?: number },
): Wait[] {
  const now = Date.now();
  endWaits(t, isOutside, "换成了新的等待");
  const out: Wait[] = [];
  if (w.conv) {
    follow(t, w.conv);
    out.push(addWait(t, { kind: "reply", what: w.what, since: now, on: { source: w.conv.source, key: w.conv.key }, where: w.conv.where, url: w.conv.url }));
  }
  if (w.check) out.push(addWait(t, { kind: "check", what: w.what, since: now, check: { ...w.check, next: now } }));
  if (w.at) out.push(addWait(t, { kind: "time", what: w.what, since: now, at: w.at }));
  return out;
}

/** The conversation an MR is, as the MR watcher (mrwatch.ts) emits its events: gitlab, group/repo!34. */
export function mrConversation(url: string): { source: string; key: string; where: string; url: string } | null {
  const m = /^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url.trim());
  return m ? { source: "gitlab", key: `${m[2]}!${m[3]}`, where: `MR !${m[3]}`, url: m[0] } : null;
}

// ---- kept in step with what they mirror ----

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const short = (cmd: string) => {
  const one = cmd.replace(/\s+/g, " ").trim();
  return [...one].length > 60 ? [...one].slice(0, 60).join("") + "…" : one;
};

/**
 * Brings the mirrored waits in step, on every write (_store.ts update): the board items it's blocked by; a finished
 * task ends everything. Sessions it handed work to need Gerdr's session list: syncSessions.
 */
export function sync(s: Store) {
  for (const t of s.tasks) {
    if (t.owner !== "agent") continue;
    if (t.status === "done" || t.status === "dropped") {
      endWaits(t, () => true, t.status === "done" ? "任务完成了" : "任务放弃了");
      continue;
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
export function wakeText(w: Wait): string {
  switch (w.kind) {
    case "reply":
      return `${w.where ?? (w.on ? `${w.on.source} ${w.on.key}` : "那个对话")} 上有新消息 / 新动静就叫醒它`;
    case "check":
      return `每 ${w.check?.every ?? 1} 分钟跑一次它写的检查（${short(w.check?.command ?? "")}），等到了就叫醒它`;
    case "time":
      // The worker picked the interval (wait_for recheck): say it, not only the clock time it comes to
      return w.at ? `${Math.round((w.at - w.since) / 60000)} 分钟后（${hhmm(w.at)}）叫醒它回来看` : "到点叫醒它";
    case "session":
      return "它做完会回报，Gerdr 把结果交给 worker";
    case "user":
      return w.item ? `你在看板上做完 / 答了 ${w.item} 就叫醒它` : "你在对话里回复，或在看板上回答，就叫醒它";
    case "task":
      return `${w.item} 做完就叫醒它`;
  }
}
