// The task board's data, shared by tasks.ts (the board, the panel's agent) and the watchers (waits.ts). Kept as one
// file per part in user/data/reqs/ (_parts.ts; this person's, never shared — _user.ts). A helper file (leading _):
// nothing here is callable from a page.

import { addWait, askUser, mrConversation, open, sync, type Wait } from "./_waits";
import { migrate } from "./_user";
import { readAll, split, writeChanged } from "./_parts";

/** An artifact (产物): something a step produced, kept with when it came. */
export type Link = { label: string; url: string; at?: number };
/**
 * What the user gives back: nothing, a value, a secret (stored, never shown), or one of options (a decision); multi:
 * any number of the options, handed back one per line.
 */
export type HandBack = { kind: "none" | "value" | "secret" | "choice" | "questions"; name?: string; label?: string; options?: string[]; multi?: boolean };

/**
 * One of several things a worker needs the user to decide or give it (a human task with handBack "questions"): a
 * choice (options) or a value. They're one board item because the worker can't go on until all are answered; it
 * hears every answer at once (tasks.answerQuestion).
 */
export type Question = { id: string; title: string; kind: "choice" | "value"; options?: string[]; multi?: boolean; label?: string; steps?: string; answer?: string; dropped?: string; at?: number; skipped?: boolean; sent?: boolean };

/**
 * One line in a requirement's activity feed (活动): what the user follows instead of its workers' chats. Milestones
 * and hand-offs only — a member finishing its part, telling a teammate, pulling one in, the user answering.
 * by: the member it's about (a task id); kind: what sort of line, for its icon.
 */
export type Activity = { at: number; by?: string; kind: "progress" | "tell" | "join" | "done" | "review" | "user" | "stuck" | "wait" | "got" | "message"; text: string; to?: string; files?: { path: string; name?: string }[]; /** The step / question item (human task) whose answer this line records: drawn by that item's record instead (DESIGN.md「一个架构」) */ of?: string };

export type Task = {
  id: string;
  title: string;
  owner: "agent" | "human";
  /**
   * todo → running → done (nothing for the user to judge) | review (the user judges the result); dropped. Only the
   * worker or the user says done: no rule does (a merged MR is news for the worker, not the end). Human tasks: todo → done.
   * "delivering" (an MR the board followed to merge) is gone: read as running, waiting on the MR (upgrade).
   */
  status: "todo" | "running" | "review" | "done" | "dropped" | "delivering";
  /** @deprecated the MR of a "delivering" task: read by upgrade into a wait on the MR's conversation. */
  delivery?: { url: string; project: string; iid: number; since: number };
  /** When it was handed to the panel's agent to pick the repository / agent (the user dispatched it without one). */
  routing?: number;
  /**
   * The user sent the router feedback on how this card was handed out (仓库错了…): it is rearranging the card, and
   * decides how (another repository, several, keep or stop the old workers). Set on the card (the requirement root)
   * until the router decides or leaves it (sweep).
   */
  reroute?: { feedback: string; at: number; router?: string };
  /** When the user last typed in its worker's chat that the feed has (Gerdr's personSaid): each one is logged once. */
  heard?: number;
  /**
   * The user spoke to it from the requirement's feed (tasks.message) and is owed a message back (board.ts message);
   * nudged: reminded once already. Cleared by its message.
   */
  asked?: { at: number; nudged?: boolean; /** Asked through the secretary (its words): the answer goes back to its chat. */ relay?: string; /** What it sent with message_user meanwhile. */ said?: string };
  /** Dropped by the board because nothing it unblocked was still going (tasks.ts dropOrphans), not by anyone: a handover can take it back. */
  orphaned?: number;
  /**
   * The conversation that dispatched it: the Superagent's main session (_main.ts; a part split off shares its
   * parent's), or, for older tasks, a one-off router since closed (routerClosed). Kept, so every task traces back to
   * the decision that sent it out.
   */
  router?: string;
  routerClosed?: boolean;
  /** Agent task: what the worker is told, the repository it runs in, which agent / role. */
  prompt?: string;
  /** Images and files the user gave with it (uploaded to Gerdr's machine): sent with the first message to the worker. */
  attachments?: { path: string; name: string; mime?: string }[];
  repo?: string;
  agent?: string;
  /** The worker's model / thinking effort (the agent's own values); unset = the worker defaults in 设置, else Gerdr's default. */
  model?: string;
  effort?: string;
  /** Agents the user @-mentioned: the router hands the task to them (one part each, or as it sees fit). */
  mentions?: string[];
  /**
   * The event it came from (a chat message, through the 触发器 settings: local/inbox.ts), with its reply address:
   * the board answers there when the task is taken (设置 → 回复对方). Results are not sent back: what the board hears
   * (done, review, questions) is written for the user; the worker tells the person itself when it judges they should know.
   */
  /** Later messages of the same conversation handled as follow-ups (event ids), so a re-sent one isn't handled twice. */
  followups?: string[];
  /**
   * The conversations it follows (source + key): its origin's, and any the Superagent attached since. A message in
   * one goes straight to this task's worker, without Eval (_main.ts subscribers). Unset on older tasks: the origin's.
   */
  threads?: { source: string; key: string }[];
  /** Everything it waits on, open and lately ended (_waits.ts): where it stands follows from these. */
  waits?: Wait[];
  /** @deprecated before waits: a worker's question (now a user wait) and a wait_for (reply / time waits). Read once by upgrade. */
  waiting?: { what: string; since: number; source?: string; key?: string; where?: string; recheckAt?: number };
  waitEnd?: unknown;
  origin?: { id: string; source: string; kind: string; key?: string; title?: string; url?: string; reply?: { kind: string; data?: unknown } };
  /**
   * A member of requirement `team` (the task whose card the user sees; its own worker is the lead, 负责人): it works
   * in its own repository next to the others and talks to them straight (board.ts tell), not through the router.
   * Unset on a requirement itself and on a task that works alone.
   */
  team?: string;
  /**
   * A requirement's own words, as the user (or the message it came from) put them: its card's description. Kept when
   * the lead's prompt is narrowed to its own part (dispatch with team). Unset: the prompt is still the whole request.
   */
  request?: string;
  /** A requirement's feed (on the task that has members): see Activity. */
  activity?: Activity[];
  /** @deprecated: was the requirement's tell count on its root, written by every member. Now bouncesOf. */
  bounces?: number;
  /**
   * When this member told a teammate something (board.ts tell), latest few. Kept on the member that told, not the
   * requirement, so each part has one writer; bouncesOf adds them up.
   */
  tells?: number[];
  /** Split off this task: by the router (one of several parts run in parallel), or by its worker (tasks.add from: a part handed on, or the rest of the work when it hands over). */
  from?: string;
  worktree?: boolean;
  /** The worker session now and every one it had (re-runs, hand-offs). */
  session?: string;
  sessions?: string[];
  /** Tasks that must be done first (a human task blocking an agent task, or the other way round). */
  blockedBy?: string[];
  /**
   * Added with start while what it's blocked by was still going: the board starts it once those are done (tasks.ts
   * startUnblocked), told what they came to. A split's later part, waiting on the one it needs (2026-11-11: the
   * secretary no longer watches tasks to send it out itself).
   */
  startWhenFree?: boolean;
  /** The person who sent its message hears back when it's sent out (设置 → 外面来的消息 → 回复对方: 派出去时). */
  ackOnStart?: boolean;
  /** @deprecated a question for the user: now a user wait (_waits.ts askUser). */
  question?: string;
  /** The latest result in a line or a paragraph, and where to look (MR, doc). */
  summary?: string;
  links?: Link[];
  /** Human task: how to do it, what to hand back, how the agent will check it, roughly how long it takes. */
  steps?: string;
  handBack?: HandBack;
  /** handBack "questions": what it asks, each answered on its own (in the chat or on the board). */
  questions?: Question[];
  /** When the user asked its worker to bring it up to date (tasks.refreshAsk): the drawer says so until it changes. */
  refreshing?: number;
  /** Why its worker took it back (cancel_human): the card in the worker's chat says so once it ended. */
  dropReason?: string;
  handedBack?: string;
  verify?: string;
  minutes?: number;
  urgent?: boolean;
  /** ms: when what it asks for stops working (a sign-in link valid 30 minutes). Past it, the board offers a redo. */
  expiresAt?: number;
  /** Human task: the agent task that asked for it (its worker made it), so a newer ask from that worker replaces it. */
  askedBy?: string;
  /** Its worker reports through the panel tools (board.ts): no ```gerdr-task``` block to expect at the end of a turn. */
  viaTools?: boolean;
  /** When its worker last reported (task_update / ask_human): a stop with nothing reported since is noticed (tasks.list). */
  reportedAt?: number;
  /** What it was before 放弃, so restore puts it back. */
  droppedFrom?: Task["status"];
  /** Reminders sent for stops without a report since its last one: one, then the stop goes to the user. */
  nudges?: number;
  /** Feedback history (rejections, answers), newest last. */
  notes?: { at: number; text: string }[];
  /** The session `updatedAt` whose reply was last applied, so a reply is applied once. */
  synced?: number;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
};

/** v: the store's shape — 2 since wait_for stopped adding the conversations it waits on to threads. */
export type Store = { next: number; tasks: Task[]; v?: number };

export function load(ctx: Ctx) {
  migrate(ctx);
  const loaded = readAll(ctx, reqOf);
  loaded.store = upgrade(loaded.store);
  return loaded;
}

/** Tasks written before waits: their question and wait_for become waits (kept so on the next write). */
function upgrade(s: Store): Store {
  for (const t of s.tasks) {
    if (t.question) {
      if (t.status !== "done" && t.status !== "dropped") askUser(t, t.question);
      t.question = undefined;
    }
    const w = t.waiting;
    if (w) {
      if (t.status === "running") {
        if (w.key) addWait(t, { kind: "reply", what: w.what, since: w.since, on: { source: w.source!, key: w.key }, where: w.where });
        if (w.recheckAt) addWait(t, { kind: "time", what: w.what, since: w.since, at: w.recheckAt });
      }
      t.waiting = undefined;
    }
    t.waitEnd = undefined;
    // Delivering: running, waiting on its MR like on any conversation (the watcher is only a source of its events now)
    if (t.status === "delivering") {
      t.status = "running";
      const d = t.delivery;
      if (d?.url) {
        const on = { source: "gitlab", key: mrConversation(d.url)?.key ?? `${d.project}!${d.iid}` };
        if (!open(t).some((w) => w.on?.key === on.key)) addWait(t, { kind: "reply", what: `MR !${d.iid}：review、流水线、合并`, on, where: `MR !${d.iid}`, url: d.url, since: d.since });
      }
    }
    t.delivery = undefined;
    // Before v2, wait_for added the conversation it waited on to threads for good: taken out again (a conversation
    // some reply wait was on, other than the origin's). Still waited on, it's followed through the wait (waitingOn).
    if (!s.v && t.threads?.length) {
      const waited = (x: { source: string; key: string }) =>
        (t.waits ?? []).some((w) => w.kind === "reply" && w.on?.source === x.source && w.on?.key === x.key);
      const isOrigin = (x: { source: string; key: string }) => x.source === t.origin?.source && x.key === t.origin?.key;
      t.threads = t.threads.filter((x) => isOrigin(x) || !waited(x));
    }
  }
  s.v = 2;
  return s;
}

/** Read, change, write back; retried when another run wrote in between (the etag no longer matches). */
export function update<T>(ctx: Ctx, fn: (s: Store) => T): T {
  for (let i = 0; ; i++) {
    const loaded = load(ctx);
    const store = loaded.store;
    const out = fn(store);
    sync(store);
    // Only the parts this changed are written. Nothing changed (tasks.list reconciling an unchanged board, mostly):
    // no write. A write tells the board's page to reload (Gerdr's usePanelChange), and the page's reload runs
    // tasks.list: writing anyway would loop.
    let wrote: boolean | "same" = false;
    try {
      wrote = writeChanged(ctx, loaded, split(store));
    } catch (e) {
      if (i >= 4) throw e;
      continue;
    }
    if (wrote === "same") return out;
    if (wrote) return out;
    if (i >= 4) throw new Error("看板数据一直在被别处改，没写进去：稍后再试");
  }
}

/**
 * The requirement a task belongs to, if it's part of one with several members: the member's team; the task itself
 * when others work under it; for a human step, its asker's. Undefined for a task that works alone.
 */
export function teamOf(s: Store, t: Task): Task | undefined {
  if (t.owner === "human") {
    const by = t.askedBy ? s.tasks.find((x) => x.id === t.askedBy) : s.tasks.find((x) => x.owner === "agent" && x.blockedBy?.includes(t.id));
    return by && by.id !== t.id ? teamOf(s, by) : undefined;
  }
  if (t.team) return s.tasks.find((x) => x.id === t.team);
  return s.tasks.some((x) => x.team === t.id) ? t : undefined;
}

/**
 * The card a task shows on (every agent task is a requirement, alone or with members): a member's requirement, an
 * agent task itself, a human step's asker's. Undefined for a human step nobody asked for (the user's own).
 */
export function reqOf(s: Store, t: Task): Task | undefined {
  if (t.owner === "human") {
    const by = t.askedBy ? s.tasks.find((x) => x.id === t.askedBy) : s.tasks.find((x) => x.owner === "agent" && x.blockedBy?.includes(t.id));
    return by && by.id !== t.id ? reqOf(s, by) : undefined;
  }
  return (t.team && s.tasks.find((x) => x.id === t.team)) || t;
}

/** The members of requirement `root`, itself (the lead) first. */
export function members(s: Store, root: Task): Task[] {
  return [root, ...s.tasks.filter((x) => x.team === root.id)];
}

const KEEP_ACTIVITY = 200;

/**
 * A line in the feed of `t`'s requirement (t itself when it works alone: its feed shows once it has teammates).
 * Progress that came from outside the members' talk — a part done, the user's answer — starts the bounce count over.
 */
export function activity(s: Store, t: Task, a: Omit<Activity, "at">) {
  // Every task's card has a feed, alone or with teammates (DESIGN.md「需求和队友」)
  const root = reqOf(s, t);
  if (!root) return;
  root.activity = [...(root.activity ?? []), { at: Date.now(), ...a }].sort((x, y) => x.at - y.at).slice(-KEEP_ACTIVITY);
  // Not root.updatedAt: the line is the writing member's, and the root is another member's part. The board
  // works out a card's last change from its members and feed (tasks.ts teams)
}

/**
 * Teammate messages since the last real progress (a member done / for review, the person stepping in): past a limit
 * the members are told to put their disagreement to the person instead of going round (board.ts tell). Worked out,
 * not stored: each member keeps its own tells, so no part writes another's.
 */
export function bouncesOf(s: Store, root: Task) {
  const reset = Math.max(0, ...(root.activity ?? []).filter((a) => a.kind === "done" || a.kind === "review" || a.kind === "user").map((a) => a.at));
  return members(s, root).reduce((n, m) => n + (m.tells ?? []).filter((at) => at > reset).length, 0);
}

/** How a member is named to people and teammates: its repository's folder (后端仓库), else its id. */
export function memberName(t: Task) {
  return t.repo ? `${t.id}（${t.repo.split("/").pop()}）` : t.id;
}

/**
 * "t5#2" → ["t5", "2"]: one question of a task asking several. The "#" that starts a team id (#1, #1-1, #1-1#2) is
 * part of the id, not the separator: splitting on the first "#" turned #1-1 into "", so no team step could be taken back.
 */
export function splitRef(ref: string): [string, string | undefined] {
  const i = ref.indexOf("#", 1);
  return i < 0 ? [ref, undefined] : [ref.slice(0, i), ref.slice(i + 1)];
}

export function find(s: Store, id: string): Task {
  const t = s.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`没有任务 ${id}`);
  return t;
}

export function note(t: Task, text: string) {
  t.notes = [...(t.notes ?? []), { at: Date.now(), text }];
}

export function blockersDone(s: Store, t: Task) {
  return (t.blockedBy ?? []).every((b) => {
    const x = s.tasks.find((y) => y.id === b);
    return !x || x.status === "done" || x.status === "dropped";
  });
}

export function newTask(s: Store, p: Partial<Task> & { title: string }): Task {
  const now = Date.now();
  const t: Task = { status: "todo", owner: "agent", ...p, id: `t${s.next++}`, createdAt: now, updatedAt: now } as Task;
  s.tasks.push(t);
  return t;
}

