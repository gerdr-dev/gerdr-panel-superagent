// The task board's data, shared by tasks.ts (the board, the panel's agent) and the watchers (waits.ts). Kept as one
// file per part in user/data/reqs/ (_parts.ts; this person's, never shared — _user.ts). A helper file (leading _):
// nothing here is callable from a page.

import { sync, type Wait } from "./_waits";
import { readAll, split, writeChanged } from "./_parts";
import { byCaller, unarchive } from "./_archive";

/** An artifact (产物): something a step produced, kept with when it came. */
export type Link = { label: string; url: string; at?: number };
/**
 * What the user gives back: nothing, a value, a secret (stored, never shown), or one of options (a decision); multi:
 * any number of the options, handed back one per line.
 */
export type HandBack = { kind: "none" | "value" | "secret" | "choice" | "questions"; name?: string; label?: string; options?: string[]; multi?: boolean };

/**
 * One of several things a worker needs the user to decide or give it (an ask with handBack "questions"): a choice
 * (options) or a value. They're one ask because the worker can't go on until all are answered; it hears every answer
 * at once (tasks.answerQuestion).
 */
export type Question = { id: string; title: string; kind: "choice" | "value"; options?: string[]; multi?: boolean; label?: string; steps?: string; answer?: string; dropped?: string; at?: number; skipped?: boolean; sent?: boolean };

/**
 * One line in a requirement's activity feed (活动): what the user follows instead of its workers' chats. Milestones
 * and hand-offs only — a member finishing its part, telling a teammate, pulling one in, the user answering.
 * by: the member it's about (a task id); kind: what sort of line, for its icon.
 */
export type Activity = { at: number; by?: string; kind: "progress" | "tell" | "join" | "done" | "review" | "user" | "stuck" | "wait" | "got" | "message"; text: string; to?: string; files?: { path: string; name?: string }[]; /** The ask (or one of its questions) whose answer this line records: drawn by that item's record instead (DESIGN.md「一个架构」) */ of?: string };

/** One message a worker wrote for a chat, waiting for the user (local/outbox.ts). */
export type Outgoing = {
  /** "o1", "o2"…: unique within the task; the chat card's ref is "<task>~<id>". */
  id: string;
  text: string;
  /** The message it answers (its reply address goes to that conversation / thread), as the event had it. */
  to: { id: string; source: string; kind: string; key?: string; actor?: string; title?: string; url?: string; reply?: { kind: string; data?: unknown } };
  /** Where it goes, in a few words, for the card: "slack-me · 千一". */
  where: string;
  at: number;
  /** withdrawn: its worker took it back before the user chose (board.ts drop_reply): moot by then. */
  state: "pending" | "sent" | "skipped" | "withdrawn";
  /** When the user sent it or let it go, or the worker took it back. */
  doneAt?: number;
  /** Why the worker took it back (withdrawn): the card says so. */
  reason?: string;
  /** The user changed the words before sending. */
  edited?: boolean;
};

/**
 * Something a task's worker needs from the user (board.ts ask_human): a step only they can do (sign in, hand back a
 * key), a decision, a value, or several questions at once. Kept on the task that asked, never a task of its own: a
 * task is work for an agent, and there is nothing else on the board (2026-11-19). Until then these were "human tasks"
 * (owner "human", askedBy): a board item with its own tN and no worker, so a message the secretary attached to one
 * was recorded on it and read by nobody (c379 → t206, a colleague's "我点了" for the approval t203 waited on).
 */
export type Ask = {
  /** "a12": unique on the board (the task counter), what the tools, the chat cards and tasks.complete name it by. */
  id: string;
  title: string;
  /** open → done (did it / answered) | dropped (taken back, set aside, no longer needed). */
  status: "open" | "done" | "dropped";
  /** How to do it, what to hand back, how the worker will check it, roughly how long it takes. */
  steps?: string;
  handBack: HandBack;
  /** handBack "questions": what it asks, each answered on its own (in the chat or on the board). */
  questions?: Question[];
  verify?: string;
  minutes?: number;
  /** A step holding the worker up (a warning mark); a decision can wait. */
  urgent?: boolean;
  /** ms: when what it asks for stops working (a sign-in link valid 30 minutes). Past it, the board offers a redo. */
  expiresAt?: number;
  handedBack?: string;
  /** Why its worker took it back (cancel_human): the card in the worker's chat says so. */
  dropReason?: string;
  /**
   * The user ignored it (the card's ✕, tasks.ignore): usually moot and its worker never took it back. Not a wake of its
   * own; `told` once its worker heard, at the start of its next turn (ignoredLead).
   */
  ignored?: boolean;
  told?: boolean;
  /** When the user asked its worker to bring it up to date (tasks.refreshAsk): the drawer says so until it changes. */
  refreshing?: number;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
};

export type Task = {
  id: string;
  title: string;
  /**
   * No title was given (the board's 新任务 only asks what to do): the title is a stopgap cut from the prompt, and the
   * worker's conversation is started without a fixed name so Gerdr names it from what was asked; list() then takes
   * that name for the task. Cleared once the task is renamed by anyone else.
   */
  autoTitle?: boolean;
  /**
   * todo → running → done (nothing for the user to judge) | review (the user judges the result); dropped. Only the
   * worker or the user says done: no rule does (a merged MR is news for the worker, not the end).
   */
  status: "todo" | "running" | "review" | "done" | "dropped";
  /** When it was handed to the panel's agent to pick the repository / agent (the user dispatched it without one). */
  routing?: number;
  /**
   * The user sent the router feedback on how this card was handed out (仓库错了…): it is rearranging the card, and
   * decides how (another repository, several, keep or stop the old workers). Set on the card (the requirement root)
   * until the router decides or leaves it (sweep).
   */
  /** was: a card not sent out yet (tasks.redraft), what it looked like before, to tell whether the secretary changed it. */
  reroute?: { feedback: string; at: number; router?: string; was?: string };
  /** When the user last typed in its worker's chat that the feed has (Gerdr's personSaid): each one is logged once. */
  heard?: number;
  /** A question the secretary passed on (tasks.message, its words in relay): the worker's reply goes back to its chat. */
  asked?: { at: number; relay: string };
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
  origin?: { id: string; source: string; kind: string; key?: string; title?: string; url?: string; reply?: { kind: string; data?: unknown } };
  /**
   * Work someone asked of the user through its origin (assign.ts): whether they agreed, delivered, and who asked.
   * Only these are agreed to, replied to and delivered from the task panel.
   */
  assigned?: { state: "ask" | "agreed" | "delivered" | "done"; by?: string; how?: "agent" | "self"; agent?: string; repos?: string[]; share?: "" | "view" | "talk"; draft?: string; shareDir?: string; unattended?: boolean };
  /**
   * What its worker wrote to the people in a conversation it follows (board.ts reply_message) while 设置 → 回话 is
   * "review": each waits as a card for the user to send or not (local/outbox.ts). The worker never hears which.
   */
  outbox?: Outgoing[];
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
  /** Tasks that must be done first (a split's later part waiting on the one it needs). */
  blockedBy?: string[];
  /**
   * Added with start while what it's blocked by was still going: the board starts it once those are done (tasks.ts
   * startUnblocked), told what they came to. A split's later part, waiting on the one it needs (2026-11-11: the
   * secretary no longer watches tasks to send it out itself).
   */
  startWhenFree?: boolean;
  /** The person who sent its message hears back when it's sent out (设置 → 外面来的消息 → 回复对方: 派出去时). */
  ackOnStart?: boolean;
  /**
   * What the user wrote in the card's 回复对方 box before 派出去: sent to its message's sender once it's out (empty: nothing
   * is sent, not even the 回复对方 words). Kept on the task because 派出去 may first go to the secretary for a repository.
   */
  replyOnStart?: string;
  /**
   * The user's own words on a card that came from outside (备注): its prompt is someone else's message, theirs to keep
   * as it was, so what the user adds goes here and rides with it to the worker (and the secretary when it routes).
   */
  remark?: string;
  /** The latest result in a line or a paragraph, and where to look (MR, doc). */
  summary?: string;
  links?: Link[];
  /** What its worker asks of the user (ask_human), open and answered: see Ask. */
  asks?: Ask[];
  /** When its worker last asked or waited through the panel tools (ask_human, wait_for). */
  reportedAt?: number;
  /** What it was before 放弃, so restore puts it back. */
  droppedFrom?: Task["status"];
  /** Reminders sent for stops without a report since its last one: one, then the stop goes to the user. */
  nudges?: number;
  /** Feedback history (rejections, answers), newest last. */
  notes?: { at: number; text: string }[];
  /** The session `updatedAt` whose reply was last applied, so a reply is applied once. */
  synced?: number;
  /**
   * When tasks.compactWorkers sent its worker `/compact` (ms): that turn is upkeep, like a slash command the user
   * types (tasks.ts upkeep). Cleared once a later turn starts.
   */
  compactAt?: number;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
};

export type Store = { next: number; tasks: Task[] };

/** The run's ctx, for find to bring an archived task back with (each run has its own module state). */
let current: Ctx | undefined;

export function load(ctx: Ctx) {
  current = ctx;
  byCaller(ctx);
  const loaded = readAll(ctx, reqOf);
  return loaded;
}

/** An ask by its ref: "a12", with a question of it after "#" (a12#2). The task that asked comes with it. */
export function findAsk(s: Store, ref: string): { t: Task; a: Ask; q?: string } {
  const [id, q] = splitRef(ref);
  for (const t of s.tasks) for (const a of t.asks ?? []) if (a.id === id) return { t, a, q };
  throw new Error(`没有 ${ref}（要用户做 / 答的一项）`);
}

/** A new ask on t, open. */
export function newAsk(s: Store, t: Task, p: Omit<Ask, "id" | "status" | "createdAt" | "updatedAt">): Ask {
  const now = Date.now();
  const a: Ask = { ...p, id: `a${s.next++}`, status: "open", createdAt: now, updatedAt: now };
  t.asks = [...(t.asks ?? []), a];
  return a;
}

/** What t still asks the user. */
export function openAsks(t: Task): Ask[] {
  return (t.asks ?? []).filter((a) => a.status === "open");
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
    if (i >= 4) throw new Error("任务面板数据一直在被别处改，没写进去：稍后再试");
  }
}

/**
 * The requirement a task belongs to, if it's part of one with several members: the member's team; the task itself
 * when others work under it. Undefined for a task that works alone.
 */
export function teamOf(s: Store, t: Task): Task | undefined {
  if (t.team) return s.tasks.find((x) => x.id === t.team);
  return s.tasks.some((x) => x.team === t.id) ? t : undefined;
}

/** The card a task shows on (every task is a requirement, alone or with members): a member's requirement, else itself. */
export function reqOf(s: Store, t: Task): Task | undefined {
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

/**
 * The task, brought back from the archive if it's there (_archive.ts): `s` is refilled from the files then. Inside
 * update the write that follows sees parts it didn't read and runs the change again on the full board.
 */
/**
 * Sent out and not finished: 进行中 or 待验收. Its worker's waits, wakes and tools work the same in both — the column is
 * only the user's label (DESIGN.md「状态只由用户改」), and the user may move a task to 待验收 while its worker still
 * waits on something, or talk to it there (t123: wait_for refused with "不是进行中（review）").
 */
export function going(t: Task) {
  return t.status === "running" || t.status === "review";
}

export function find(s: Store, id: string): Task {
  let t = s.tasks.find((x) => x.id === id);
  if (!t && current && unarchive(current, id)) {
    Object.assign(s, load(current).store);
    t = s.tasks.find((x) => x.id === id);
  }
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
  const t: Task = { status: "todo", ...p, id: `t${s.next++}`, createdAt: now, updatedAt: now } as Task;
  s.tasks.push(t);
  return t;
}

/** What redraft changes on a card, to tell afterwards whether the secretary changed anything. */
export function draftOf(t: Task) {
  return JSON.stringify([t.title, t.prompt, t.repo, t.agent, t.model, t.status]);
}

/**
 * What the user ignored of t's asks (tasks.ignore) and its worker hasn't heard yet, as the line its next message starts
 * with; marks them told. Call inside an update. "" when there's nothing.
 */
export function ignoredLead(t: Task): string {
  const asks = (t.asks ?? []).filter((a) => a.ignored && !a.told);
  if (!asks.length) return "";
  for (const a of asks) a.told = true;
  return ignoredText(asks);
}

/** What an agent is told about its questions the user ignored. */
export function ignoredText(asks: { id: string; title: string }[]): string {
  return `[任务面板] 用户忽略了你问的${asks.map((a) => `「${a.title}」（${a.id}）`).join("、")}：多半已经过时了。别等它，也别原样再问；还需要的话按现在的情况重新 ask_human。`;
}

/**
 * Leaves an ignored question as a note on its conversation (Gerdr's ctx.sessions.note): it goes in front of the next
 * message that conversation gets, the user's own typing included, as one folded line above it. It used to be a
 * message of its own, sent once a turn had started: the user typed, and "用户忽略了你问的问题" came after their message
 * as a second one, starting a turn of its own when the first had ended (2026-11-24). false on a Gerdr without notes:
 * the caller leaves it untold, for ignoredLead / secIgnoredLead.
 */
export function noteIgnored(ctx: Ctx, session: string | undefined, a: { id: string; title: string }): boolean {
  const note = (ctx.sessions as any).note;
  if (!session || typeof note !== "function") return false;
  try {
    note(session, `ignored:${a.id}`, ignoredText([a]), { fold: `你忽略了「${cutTitle(a.title)}」` });
    return true;
  } catch {
    return false;
  }
}

const cutTitle = (t: string) => ([...t].length > 30 ? [...t].slice(0, 30).join("") + "…" : t);
