// The task board's data (data/tasks.json), shared by tasks.ts (the board, the Work agent) and the watchers
// (mrwatch.ts). A helper file (leading _): nothing here is callable from a page.

export const FILE = "data/tasks.json";

/** An artifact (产物): something a step produced, kept with when it came. */
export type Link = { label: string; url: string; at?: number };
/** What the user gives back: nothing, a value, a secret (stored, never shown), or one of options (a decision). */
export type HandBack = { kind: "none" | "value" | "secret" | "choice"; name?: string; label?: string; options?: string[] };

export type Task = {
  id: string;
  title: string;
  owner: "agent" | "human";
  /**
   * todo → running → done (nothing for the user to judge) | review (the user judges the result) | delivering (handed
   * off to a process: an MR on its way to merge, followed by a watcher) → done; dropped. Human tasks: todo → done.
   */
  status: "todo" | "running" | "review" | "delivering" | "done" | "dropped";
  /** While delivering: what it waits on and what the watcher (mrwatch.ts) last saw. */
  delivery?: Delivery;
  /** When it was handed to the Work agent to pick the repository / agent (the user dispatched it without one). */
  routing?: number;
  /** The one-off conversation picking its repository (tasks.ts route), closed once it has dispatched the task. */
  router?: string;
  /** Agent task: what the worker is told, the repository it runs in, which agent / role. */
  prompt?: string;
  /** Images and files the user gave with it (uploaded to Gerdr's machine): sent with the first message to the worker. */
  attachments?: { path: string; name: string; mime?: string }[];
  repo?: string;
  agent?: string;
  worktree?: boolean;
  /** The worker session now and every one it had (re-runs, hand-offs). */
  session?: string;
  sessions?: string[];
  /** Tasks that must be done first (a human task blocking an agent task, or the other way round). */
  blockedBy?: string[];
  /** A question the worker / Work agent wants the user to decide. */
  question?: string;
  /** The latest result in a line or a paragraph, and where to look (MR, doc). */
  summary?: string;
  links?: Link[];
  /** Human task: how to do it, what to hand back, how the agent will check it, roughly how long it takes. */
  steps?: string;
  handBack?: HandBack;
  handedBack?: string;
  verify?: string;
  minutes?: number;
  urgent?: boolean;
  /** ms: when what it asks for stops working (a sign-in link valid 30 minutes). Past it, the board offers a redo. */
  expiresAt?: number;
  /** Human task: the agent task that asked for it (its worker made it), so a newer ask from that worker replaces it. */
  askedBy?: string;
  /** Its worker reports through the Work tools (board.ts): no ```gerdr-task``` block to expect at the end of a turn. */
  viaTools?: boolean;
  /** Feedback history (rejections, answers), newest last. */
  notes?: { at: number; text: string }[];
  /** The session `updatedAt` whose reply was last applied, so a reply is applied once. */
  synced?: number;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
};

/** An MR the task's work went out in; mrwatch.ts follows it to merged. */
export type Delivery = {
  kind: "mr";
  url: string;
  project: string; // group/repo
  iid: number;
  since: number; // when it was handed over: comments before it were the worker's to see already
  /** GitLab's detailed_merge_status (mergeable, need_rebase, not_approved, ci_still_running...) and a line for the card. */
  state?: string;
  detail?: string;
  checked?: number;
  /** Notes already handed to the worker, the pipeline / sha already acted on, how many review rounds so far. */
  seen?: number[];
  pipeline?: number;
  rebased?: string;
  conflict?: string;
  rounds?: number;
  merging?: number;
};

export type Store = { next: number; tasks: Task[] };

export function load(ctx: Ctx): { store: Store; etag?: string } {
  const st = ctx.fs.stat(FILE);
  if (!st) return { store: { next: 1, tasks: [] } };
  return { store: JSON.parse(ctx.fs.read(FILE)), etag: st.etag };
}

/** Read, change, write back; retried when another run wrote in between (the etag no longer matches). */
export function update<T>(ctx: Ctx, fn: (s: Store) => T): T {
  for (let i = 0; ; i++) {
    const { store, etag } = load(ctx);
    const out = fn(store);
    try {
      ctx.fs.write(FILE, JSON.stringify(store, null, 2), etag ? { etag } : undefined);
      return out;
    } catch (e) {
      if (i >= 4) throw e;
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

