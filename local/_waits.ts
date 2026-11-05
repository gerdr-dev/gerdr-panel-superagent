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

export type WaitKind = "reply" | "check" | "time" | "session" | "agent" | "user" | "task" | "teammate";

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
  /** session: the session it handed work to. agent: its worker's session, and `sub` the subagent / background command
   * that worker started (its toolCallId, else the task id): SessionChat's sub shows a subagent's conversation. */
  session?: string;
  sub?: string;
  /** teammate: the member of its requirement it waits to hear from (a task id): its tell ends this. */
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

/** The worker's own waits on outside (wait_for): news in a conversation, a check it wrote, a time, a teammate. */
export function isOutside(w: Wait) {
  return w.kind === "reply" || w.kind === "check" || w.kind === "time" || w.kind === "teammate";
}

/**
 * How long a conversation a worker waited on (wait_for message) stays followed after the wait ended. The worker being
 * woken ends the wait at once, and a person often sends a second line while it works: that one still reaches it. Past
 * this, the conversation is no longer the task's — 2026-11-05: t32 had waited on a colleague's DM the day before,
 * kept following it for good, and the colleague's next, unrelated DM went to t32, was handed back and became a task of its own.
 */
const FOLLOW_GRACE = 2 * 3_600_000;

/** The conversations the task follows because it waits on them (wait_for message), open or lately ended. */
export function waitingOn(t: Task, now = Date.now()): { source: string; key: string }[] {
  return (t.waits ?? [])
    .filter((w) => w.kind === "reply" && w.on && (!w.end || now - w.end.at < FOLLOW_GRACE))
    .map((w) => ({ source: w.on!.source, key: w.on!.key }));
}

/** One thing that wakes a worker waiting on outside: news in a conversation, a check it wrote coming true, a time. */
export type WakeOn =
  | { type: "message"; conv: { source: string; key: string; where?: string; url?: string } }
  | { type: "check"; command: string; cwd: string; every: number }
  | { type: "time"; at: number }
  | { type: "teammate"; id: string; name: string };

/**
 * The worker waits on outside (wait_for): whichever of `on` comes first wakes it — a wait each, all sharing `what`. The
 * task follows each conversation while it waits on it (waitingOn), not for good. Replaces what it waited on outside
 * before: this says what it waits on now. Returns the new waits.
 */
export function waitOn(t: Task, what: string, on: WakeOn[]): Wait[] {
  const now = Date.now();
  endWaits(t, isOutside, "换成了新的等待");
  return on.map((c) => {
    if (c.type === "message") {
      return addWait(t, { kind: "reply", what, since: now, on: { source: c.conv.source, key: c.conv.key }, where: c.conv.where, url: c.conv.url });
    }
    if (c.type === "teammate") return addWait(t, { kind: "teammate", what, since: now, item: c.id, where: c.name });
    if (c.type === "check") return addWait(t, { kind: "check", what, since: now, check: { command: c.command, cwd: c.cwd, every: c.every, next: now } });
    return addWait(t, { kind: "time", what, since: now, at: c.at });
  });
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
      if (!w.item || (w.kind !== "user" && w.kind !== "task")) continue;
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

type Bg = { id: string; type: string; description: string; subagent?: string; toolCallId?: string; parent?: string; status: string };

/**
 * What the worker itself started that runs on (Claude Code's subagents and background commands: ctx.sessions'
 * tasks), as waits: its own work going on, not something outside — Claude Code wakes it when they finish, so no
 * wait_for. Open while running; only the top-level ones (a subagent's own tasks are under it).
 */
export function syncAgents(t: Task, worker: string | undefined, bg: Bg[]) {
  if (t.owner !== "agent" || t.status === "done" || t.status === "dropped") return;
  const running = new Map(bg.filter((x) => x.status === "running" && !x.parent).map((x) => [x.toolCallId || x.id, x]));
  endWaits(t, (w) => w.kind === "agent" && (w.session !== worker || !running.has(w.sub!)), "做完了");
  for (const [sub, x] of running) {
    const who = x.type === "local_agent" ? `子 agent${x.subagent ? `（${x.subagent}）` : ""}` : "后台命令";
    const what = `它开的${who}：${x.description || sub}`;
    const w = open(t).find((y) => y.kind === "agent" && y.sub === sub) ?? addWait(t, { kind: "agent", session: worker, sub, what });
    w.what = what;
  }
}

// ---- for people ----

/** What will wake it, in words (the 在等 list, the chat card). */
/**
 * The same as wakeText, in parts for a list (the chat's wait card, ui/src/cards.tsx): kind picks the icon, text is one
 * short line, code the check's command in full (the card shortens it). "…就叫醒它" is left off: the list's heading says it.
 */
export type WakeItem = { kind: Wait["kind"]; text: string; code?: string };
export function wakeItem(w: Wait): WakeItem {
  switch (w.kind) {
    case "reply":
      return { kind: w.kind, text: `${w.where ?? (w.on ? `${w.on.source} ${w.on.key}` : "那个对话")} 有新消息` };
    case "check":
      return { kind: w.kind, text: `每 ${w.check?.every ?? 1} 分钟跑一次检查，等到了`, code: (w.check?.command ?? "").replace(/\s+/g, " ").trim() };
    case "time":
      return { kind: w.kind, text: w.at ? `${Math.round((w.at - w.since) / 60000)} 分钟后（${hhmm(w.at)}）回来看` : "到点回来看" };
    default:
      return { kind: w.kind, text: wakeText(w).replace(/，?就?叫醒它$/, "") };
  }
}

export function wakeText(w: Wait): string {
  switch (w.kind) {
    case "reply":
      return `${w.where ?? (w.on ? `${w.on.source} ${w.on.key}` : "那个对话")} 上有新消息 / 新动静就叫醒它`;
    case "check":
      return `每 ${w.check?.every ?? 1} 分钟跑一次它写的检查（${short(w.check?.command ?? "")}），等到了就叫醒它`;
    case "time":
      // The worker picked the interval (wait_for recheck): say it, not only the clock time it comes to
      return w.at ? `${Math.round((w.at - w.since) / 60000)} 分钟后（${hhmm(w.at)}）叫醒它回来看` : "到点叫醒它";
    case "agent":
      return "它自己的活，做完 Claude Code 会叫醒它";
    case "session":
      return "它做完会回报，Gerdr 把结果交给 worker";
    case "user":
      return w.item ? `你在看板上做完 / 答了 ${w.item} 就叫醒它` : "你在对话里回复，或在看板上回答，就叫醒它";
    case "task":
      return `${w.item} 做完就叫醒它`;
    case "teammate":
      return `队友 ${w.where ?? w.item} 发来消息就叫醒它`;
  }
}
