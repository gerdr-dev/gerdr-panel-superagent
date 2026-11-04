// The task board's data (user/data/tasks.json: this person's, never shared — _user.ts), shared by tasks.ts (the board, the panel's agent) and the watchers
// (mrwatch.ts). A helper file (leading _): nothing here is callable from a page.

import { addWait, askUser, follow, open, question, sync, type Wait } from "./_waits";
import { DATA, migrate } from "./_user";

export const FILE = `${DATA}/tasks.json`;

/** An artifact (产物): something a step produced, kept with when it came. */
export type Link = { label: string; url: string; at?: number };
/** What the user gives back: nothing, a value, a secret (stored, never shown), or one of options (a decision). */
export type HandBack = { kind: "none" | "value" | "secret" | "choice" | "questions"; name?: string; label?: string; options?: string[] };

/**
 * One of several things a worker needs the user to decide or give it (a human task with handBack "questions"): a
 * choice (options) or a value. They're one board item because the worker can't go on until all are answered; it
 * hears every answer at once (tasks.answerQuestion).
 */
export type Question = { id: string; title: string; kind: "choice" | "value"; options?: string[]; label?: string; steps?: string; answer?: string; dropped?: string };

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
   * the board answers there when the task is taken, and again when it reaches a result (tellOrigins below).
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
  /** Split off this task by the router (one of several parts run in parallel). */
  from?: string;
  worktree?: boolean;
  /** The worker session now and every one it had (re-runs, hand-offs). */
  session?: string;
  sessions?: string[];
  /** Tasks that must be done first (a human task blocking an agent task, or the other way round). */
  blockedBy?: string[];
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

export type Store = { next: number; tasks: Task[] };

export function load(ctx: Ctx): { store: Store; etag?: string } {
  migrate(ctx);
  const st = ctx.fs.stat(FILE);
  if (!st) return { store: { next: 1, tasks: [] } };
  return { store: upgrade(JSON.parse(ctx.fs.read(FILE))), etag: st.etag };
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
        const on = { source: "gitlab", key: `${d.project}!${d.iid}` };
        follow(t, on);
        if (!open(t).some((w) => w.on?.key === on.key)) addWait(t, { kind: "reply", what: `MR !${d.iid}：review、流水线、合并`, on, where: `MR !${d.iid}`, url: d.url, since: d.since });
      }
    }
    t.delivery = undefined;
  }
  return s;
}

/** Read, change, write back; retried when another run wrote in between (the etag no longer matches). */
export function update<T>(ctx: Ctx, fn: (s: Store) => T): T {
  for (let i = 0; ; i++) {
    const { store, etag } = load(ctx);
    const before = snapshot(store);
    const out = fn(store);
    sync(store);
    try {
      ctx.fs.write(FILE, JSON.stringify(store, null, 2), etag ? { etag } : undefined);
      tellOrigins(ctx, before, store);
      return out;
    } catch (e) {
      if (i >= 4) throw e;
    }
  }
}

// Every change goes through update, so this is the one place that notices a task from an event reaching a result
// and answers where it came from (ctx.events.reply: the event's own address, whatever the source — Slack, Feishu…).
type Seen = Record<string, { status: string; question?: string }>;
function snapshot(s: Store): Seen {
  const out: Seen = {};
  for (const t of s.tasks) if (t.origin?.reply) out[t.id] = { status: t.status, question: question(t) };
  return out;
}

function tellOrigins(ctx: Ctx, before: Seen, s: Store) {
  const reply = (ctx as any).events?.reply;
  if (typeof reply !== "function") return;
  for (const t of s.tasks) {
    const b = before[t.id];
    if (!b || !t.origin?.reply) continue;
    let text = "";
    if (t.status !== b.status) {
      const summary = t.summary ? `：${t.summary}` : "";
      if (t.status === "done") text = `${t.id} 做完了${summary}`;
      else if (t.status === "review") text = `${t.id} 有结论了，等你看${summary}`;
      else if (t.status === "dropped") text = `${t.id} 不做了`;
    } else if (question(t) && question(t) !== b.question) {
      text = `${t.id} 需要你定：${question(t)}（在任务看板上回答）`;
    }
    if (!text) continue;
    try {
      reply({ ...t.origin, at: 0 }, text);
    } catch (e: any) {
      ctx.log(`回复 ${t.origin.source}/${t.origin.kind} 失败：${e?.message ?? e}`);
    }
  }
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

