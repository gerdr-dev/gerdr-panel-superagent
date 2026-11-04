// The Superagent's core, shared by tasks.ts, inbox.ts, board.ts and superagent.ts (a helper file: nothing here is
// callable from a page). Modelled on dsh-superagent's domain (docs/001-domain.md there; DESIGN.md「Superagent」here):
//
//   event (Trigger) ─ gate ─┬─ a task subscribed to its conversation → delivered to that task's worker (no Eval)
//                           └─ otherwise → Eval: the main session decides accept / attach / stop / ignore
//   a task typed on the board → already accepted, the main session only picks repository / agent / model
//
// The main session is one long-lived conversation that only routes: it never waits, never does the work, and gets
// everything as messages (a batch arriving while it decides waits for its next pause). It replaced a one-off router
// per task: no conversation to start per task, and one place that has seen every decision. Every event is logged
// with where it went (user/data/superagent.json items), so "what happened to that message" always has an answer.

import { workflow } from "./_config";
import { allAgents } from "./_agents";
import { textOf } from "./playbooks";
import { DATA, migrate } from "./_user";
import { find, load as loadTasks, note, update as updateTasks, type Task } from "./_store";
import { wake } from "./_wake";
import { isOutside } from "./_waits";

const STATE = `${DATA}/superagent.json`;
/** A fresh main session after this many items: its context stays small, so it stays fast. */
const ROTATE = 30;
/** Items kept in the log. */
const KEEP = 300;

export type Ev = {
  id: string;
  source: string;
  kind: string;
  key?: string;
  actor?: string;
  /** Display name, when the source gives one (data.userName). */
  who?: string;
  title?: string;
  text?: string;
  url?: string;
  reply?: { kind: string; data?: unknown };
  files?: { path: string; name: string; mime?: string }[];
};

/**
 * One event and where it went (dsh's Disposition): filtered by the gate, delivered to subscribed tasks, or through
 * Eval: pending → accepted / attached / stopped / ignored, or unavailable (the main session gave no decision).
 */
export type Item = {
  id: string;
  at: number;
  event: Ev;
  state: "filtered" | "delivered" | "pending" | "accepted" | "attached" | "stopped" | "ignored" | "unavailable" | "observed";
  /**
   * Not addressed to the agent (the trigger says so: a channel message without @, an alert, an MR nobody follows):
   * dsh's inferred strength. Taken only under a rule from skills/…/proactive.md, and in observe mode only recorded.
   */
  inferred?: boolean;
  /** The proactive rule it was (or would have been) taken under. */
  rule?: string;
  /** Observe mode: what accepting it would have been, so 去向's 照做 can do exactly that. */
  would?: { title?: string; parts: unknown[] };
  reason?: string;
  tasks?: string[];
  /** Workers that gave a delivered message back (not their task's business), with why. */
  handBacks?: { task: string; reason: string; at: number }[];
  sentAt?: number;
  decidedAt?: number;
};

type State = { main?: string; mains: string[]; brief?: string; handled: number; next: number; items: Item[] };

function load(ctx: Ctx): { s: State; etag?: string } {
  migrate(ctx);
  const st = ctx.fs.stat(STATE);
  if (!st) return { s: { mains: [], handled: 0, next: 1, items: [] } };
  return { s: JSON.parse(ctx.fs.read(STATE)), etag: st.etag };
}

export function state(ctx: Ctx): State {
  return load(ctx).s;
}

export function updateState<T>(ctx: Ctx, fn: (s: State) => T): T {
  for (let i = 0; ; i++) {
    const { s, etag } = load(ctx);
    const out = fn(s);
    if (s.items.length > KEEP) s.items = s.items.slice(-KEEP);
    try {
      ctx.fs.write(STATE, JSON.stringify(s, null, 2), etag ? { etag } : undefined);
      return out;
    } catch (e) {
      if (i >= 4) throw e;
    }
  }
}

export function compact(e: GerdrEvent): Ev {
  const files = Array.isArray(e.data?.files) ? e.data.files.filter((f: any) => f?.path).map((f: any) => ({ path: f.path, name: f.name ?? f.path.split("/").pop(), mime: f.mimetype })) : [];
  return {
    id: e.id,
    source: e.source,
    kind: e.kind,
    key: e.key || undefined,
    actor: e.actor || undefined,
    who: e.data?.userName || undefined,
    title: e.title,
    text: (e.text ?? "").slice(0, 8000),
    url: e.url,
    reply: e.reply,
    ...(files.length ? { files } : {}),
  };
}

export function record(ctx: Ctx, event: Ev, patch: Partial<Item>): Item {
  return updateState(ctx, (s) => {
    const it: Item = { id: `c${s.next++}`, at: Date.now(), event, state: "pending", ...patch };
    s.items.push(it);
    return it;
  });
}

export function findItem(s: State, id: string): Item {
  const it = s.items.find((x) => x.id === id);
  if (!it) throw new Error(`没有 ${id}（记录只留最近 ${KEEP} 条）`);
  return it;
}

/** The conversations a task follows: what it was started from, and any attached since (dsh's Subscription). */
export function threadsOf(t: Task): { source: string; key: string }[] {
  if (t.threads?.length) return t.threads;
  return t.origin?.key ? [{ source: t.origin.source, key: t.origin.key }] : [];
}

/**
 * The tasks a message in this conversation goes to without Eval: every live task following it; when none is live,
 * the latest one that ended (a person speaking in its conversation picks it up again, as dsh resumes an ended
 * Ticket). Dropped tasks get nothing: the person stopped them, so the message is new work to judge.
 */
export function subscribers(tasks: Task[], e: { source: string; key?: string; actor?: string }): Task[] {
  if (!e.key) return [];
  const on = tasks.filter((t) => t.status !== "dropped" && threadsOf(t).some((x) => x.source === e.source && x.key === e.key));
  const live = on.filter((t) => t.status !== "done");
  if (live.length) return live;
  // Only a person picks an ended task up again: a bot or a pipeline (no actor) on a merged MR is no reason to
  if (!e.actor) return [];
  const last = on.sort((a, b) => (b.doneAt ?? b.updatedAt ?? 0) - (a.doneAt ?? a.updatedAt ?? 0))[0];
  return last ? [last] : [];
}

function who(e: Ev) {
  return e.who || e.actor || "";
}

/**
 * A message in a conversation a task follows, handed to it: not dispatched yet → added to what will be handed out;
 * with a worker → sent to it right away (picked up again if it had ended, so its next result is answered too). The
 * worker decides: handle it within its task, or give it back (board.ts hand_back) for the main session to judge.
 */
export async function followUp(ctx: Ctx, id: string, e: Ev) {
  const by = who(e) ? `${who(e)} ` : "";
  const text = (e.text ?? "").trim() || e.title || "";
  const files = e.files ?? [];
  // A person in a chat (it has a reply address) "goes on"; anything else (an MR review, a failed pipeline) is headed by
  // its own title. Only a chat hears back about results (tellOrigins).
  const head = e.reply ? `${e.source} 上${by}接着说` : e.title || `${e.source}/${e.kind}`;
  return wake(ctx, id, {
    how: e.reply ? `${by || "有人"}回复了` : e.title || `${e.source}/${e.kind}`,
    text:
      `[${head}]（任务 ${id}，消息 ${e.id}）\n\n${text}\n\n` +
      `是这个任务的事就照常做、用 task_update 汇报${e.reply ? "，结果会转回给他" : ""}；超出这个任务、或者是别的任务的事，用 hand_back 交回，不要自己答。`,
    files: files.map((f) => f.path),
    // What it waited on outside came — or something else did: it looks again either way, and waits again if it must
    ends: isOutside,
    on: e.key ? { source: e.source, key: e.key } : undefined,
    resume: true,
    followup: e.id,
    also: (x) => {
      note(x, `${by}接着说：${text}`);
      // Not sent out yet: it goes with the task when it is
      if (!x.session) {
        x.prompt = `${x.prompt ?? ""}\n\n${by}接着说：${text}`;
        if (files.length) x.attachments = [...(x.attachments ?? []), ...files];
      }
    },
  });
}

// ---- the main session ----

async function brief(ctx: Ctx): Promise<string> {
  const agents = await allAgents(ctx);
  const agentLines = agents.map((a) => `- ${a.id}（${a.name}${a.base ? `，基于 ${a.base}` : ""}）${a.prompt ? `：${oneLine(a.prompt, 160)}` : ""}`);
  const recent = ctx.dirs
    .recent()
    .map((d) => d.path)
    .filter((p) => !p.includes("/.gerdr/"))
    .slice(0, 20);
  const w = workflow(ctx);
  const repoText = w.repos.length
    ? w.repos.map((r) => `- ${r.path}${r.note ? `：${r.note}` : ""}${r.direct ? "（小改动可直推）" : ""}`).join("\n")
    : `（用户没设仓库列表）最近用过的目录：\n${recent.map((p) => `- ${p}`).join("\n")}`;
  const def = (x: { agent: string; model: string; effort: string }) =>
    `${x.agent || "Gerdr 的默认 agent"}，模型 ${x.model || "它的默认"}，思考强度 ${x.effort || "它的默认"}`;
  const modelText =
    `worker 默认：${def(w.worker)}。parts 里不写 agent / model / effort 就用这个；换了别的 agent 而没写模型，用那个 agent 自己的默认。\n` +
    `模型名要是那个 agent 的模型菜单里有的（claude：sonnet / haiku / fable 这类），写错了命令会报错并列出可选的。`;
  // The user's own routing rules (how they pick a repository, when a stronger or cheaper model): their prose, whole
  const rules = textOf(ctx, ROUTING);
  const ex = (o: unknown) => JSON.stringify(o);
  return [
    `你是 Superagent 的调度会话。要派的活都先到你这里：用户在看板上建的任务，和外面来的消息（私信、@、告警……）。`,
    // How it judges is the user's prose (流程 → my-workflow/references/dispatch.md), theirs to read and change; only the
    // command and the facts below are the code's
    textOf(ctx, DISPATCH) || `判断规则（用户的 dispatch.md）不见了：只分派，不自己动手、不等待；拿不准就问用户。`,
    `## 一条命令给出这一批全部的决定\n` +
      `gerdr work run superagent.decide '${ex({ decisions: [{ item: "t12", parts: [{ repo: "/绝对路径" }] }, { item: "c3", decision: "accept", title: "十几个字的标题", parts: [{ repo: "/绝对路径" }] }, { item: "c4", decision: "ignore", reason: "道谢" }] })}'\n\n` +
      `- attach：${ex({ item: "c5", decision: "attach", task: "t9" })}；stop：${ex({ item: "c6", decision: "stop", task: "t9", reason: "…" })}\n` +
      `- parts 每项一份活：repo 必填；agent、model、effort 不写就用下面的默认，简单的活可以给便宜的模型；worktree 默认 false。\n` +
      `- 只有一份：就是这件事本身，不用写 prompt。拆成几份并行（用户 @ 了几个 agent，或者活明显能分开做）：每份写 title（十几个字）和 prompt（这一份做什么、和别的份怎么配合）；同一个仓库有两份以上时都写 "worktree": true。\n` +
      `- 任务的标题是从内容第一行截的，不够好就加 "title"。\n` +
      `- 命令报错就按错误改了再发那几条。`,
    `## 可选的 agent\n${agentLines.join("\n")}`,
    `## 仓库（用户的设置）\n${repoText}`,
    `## agent 和模型\n${modelText}`,
    rules && `## 怎么派（用户自己写的规则）\n${rules}`,
    proactiveText(ctx),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The skill files the brief carries whole (the router doesn't read skills: DESIGN.md, 「派活要快」). */
const ROUTING = "my-workflow/references/routing.md";
const DISPATCH = "my-workflow/references/dispatch.md";
const PROACTIVE = "my-workflow/references/proactive.md";

/** The proactive rules for the brief, when proactive work is on at all. */
function proactiveText(ctx: Ctx) {
  const mode = workflow(ctx).proactive;
  if (mode === "off") return "";
  const rules = textOf(ctx, PROACTIVE);
  return (
    `## 不是找你的事：主动工作（用户自己写的规则）\n` +
    `标着「不是找你的」的 [消息 cN]：只有符合下面某条规则才 accept，并且在决定里写 "rule"（是哪一条，用规则原话的开头）；不符合任何一条就 ignore（reason 写「没有对应的规则」），不回复。` +
    `${mode === "observe" ? "现在是「只记录」：你照常给出决定，系统只记下来不执行。" : ""}\n\n${rules || "（还没写规则：一律 ignore）"}`
  );
}

function oneLine(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return [...t].length > max ? [...t].slice(0, max).join("") + "…" : t;
}

function hash(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The main session's id, if there is one. */
export function mainId(ctx: Ctx): string | undefined {
  return state(ctx).main;
}

/** Every main session there has been (rotated ones too): never closed as a one-off router, drawn as 调度 in 链路. */
export function isMain(ctx: Ctx, id?: string) {
  return !!id && (state(ctx).mains ?? []).includes(id);
}

/**
 * Hands the main session a batch: `blocks` are items in the format the brief describes. Starts one (the brief,
 * then the batch) when there's none, it failed, or it has handled ROTATE items; otherwise it's a message, which a
 * running main session reads at its next pause. When the user's rules changed since it was told them (repositories,
 * models, roles), the new brief goes first.
 */
async function toMain(ctx: Ctx, blocks: string[]): Promise<string> {
  const b = await brief(ctx);
  const h = hash(b);
  const s = state(ctx);
  const cur = s.main ? ctx.sessions.get(s.main) : null;
  const body = blocks.join("\n\n");
  if (!cur || cur.status === "error" || s.handled >= ROTATE) {
    const r = workflow(ctx).router;
    const sess = await ctx.sessions.start({
      cwd: ctx.workspace.dir,
      agent: r.agent || undefined,
      model: r.model || undefined,
      effort: r.effort || undefined,
      title: "Superagent 调度",
      prompt: `${b}\n\n---\n\n${body}`,
      tags: { superagent: "main" },
      workspace: "none",
    });
    updateState(ctx, (x) => {
      Object.assign(x, { main: sess.id, mains: [...(x.mains ?? []), sess.id], brief: h, handled: blocks.length });
    });
    // The one it replaces finished its last decision: let it go (still readable, as every router before it)
    if (cur && cur.status === "idle") await ctx.sessions.close(cur.id).catch(() => {});
    return sess.id;
  }
  const text = h !== s.brief ? `（用户的规则有更新，以这份为准）\n\n${b}\n\n---\n\n${body}` : body;
  await ctx.sessions.send(cur.id, text);
  updateState(ctx, (x) => {
    x.handled = (x.handled ?? 0) + blocks.length;
    x.brief = h;
  });
  return cur.id;
}

function taskBlock(t: Task, agents: { id: string; name: string }[]) {
  const named = (id: string) => {
    const a = agents.find((x) => x.id === id);
    return a && a.name !== a.id ? `${a.name}（${a.id}）` : id;
  };
  const m = t.mentions ?? [];
  const pin = m.length
    ? `用户 @ 了：${m.map(named).join("、")}，点名要它们做` + (m.length > 1 ? `：通常每个一份、并行；能合成一份的也可以只派给其中一个。` : `：就派给它。`)
    : t.agent || t.model
      ? `用户指定了 ${[t.agent && `agent「${t.agent}」`, t.model && `模型「${t.model}」`].filter(Boolean).join("、")}，照用。`
      : "";
  return [
    `[任务 ${t.id}] ${t.title}`,
    t.prompt,
    t.attachments?.length ? `附件（派出时自动带给 worker）：\n${t.attachments.map((a) => `- ${a.name}：${a.path}`).join("\n")}` : "",
    pin,
  ]
    .filter(Boolean)
    .join("\n");
}

function eventBlock(it: Item, tasks: Task[]) {
  const e = it.event;
  const related = tasks.filter((t) => threadsOf(t).some((x) => x.source === e.source && x.key === e.key));
  const recent = tasks
    .filter((t) => t.owner === "agent" && t.status !== "dropped")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);
  return [
    `[消息 ${it.id}]${it.inferred ? "（不是找你的：只按主动工作的规则判断）" : ""} ${e.source}/${e.kind}${who(e) ? ` · ${who(e)}${e.actor && e.actor !== who(e) ? `（${e.actor}）` : ""}` : ""}${e.key ? ` · 对话 ${e.key}` : ""}`,
    e.text || e.title || "",
    e.files?.length ? `附件：\n${e.files.map((f) => `- ${f.name}：${f.path}`).join("\n")}` : "",
    it.handBacks?.length ? `负责它的 worker 交回了：\n${it.handBacks.map((h) => `- ${h.task}：${h.reason}`).join("\n")}` : "",
    related.length ? `这个对话里的任务：${related.map((t) => `${t.id}「${t.title}」(${t.status})`).join("、")}` : "",
    `最近的任务（attach / stop 用）：${recent.map((t) => `${t.id}「${t.title}」(${t.status})`).join("；") || "无"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A board task with no repository: to the main session to pick one. Marked routing once it's sent. */
export async function routeTask(ctx: Ctx, id: string) {
  const agents = await allAgents(ctx);
  const t = find(loadTasks(ctx).store, id);
  const main = await toMain(ctx, [taskBlock(t, agents)]);
  return updateTasks(ctx, (s) => Object.assign(find(s, id), { routing: Date.now(), router: main, routerClosed: undefined, updatedAt: Date.now() }));
}

/** Events to judge (pending items, by id): to the main session in one message. */
export async function evaluate(ctx: Ctx, ids: string[], tasks: Task[]) {
  const s = state(ctx);
  const items = ids.map((id) => findItem(s, id));
  await toMain(
    ctx,
    items.map((it) => eventBlock(it, tasks)),
  );
  updateState(ctx, (x) => {
    for (const id of ids) Object.assign(findItem(x, id), { state: "pending", sentAt: Date.now(), reason: undefined });
  });
}

/**
 * A worker gives back a message that reached its task: not this task's business. Once every task it went to has
 * given it back, it goes to Eval, with their reasons (dsh: "a message becomes new work only after all its owners
 * hand it back").
 */
export async function handBack(ctx: Ctx, task: string, eventId: string, reason: string, tasks: Task[]) {
  const it = state(ctx).items.filter((x) => x.event.id === eventId && x.state === "delivered").pop();
  if (!it || !it.tasks?.includes(task)) throw new Error(`消息 ${eventId} 没有交给 ${task}（看给你的消息里写的消息 id）`);
  const now = updateState(ctx, (s) => {
    const x = findItem(s, it.id);
    if (!x.handBacks?.some((h) => h.task === task)) x.handBacks = [...(x.handBacks ?? []), { task, reason, at: Date.now() }];
    return x;
  });
  const left = (now.tasks ?? []).filter((t) => !now.handBacks?.some((h) => h.task === t));
  if (left.length) return { note: `已交回；${left.join("、")} 还在处理它` };
  await evaluate(ctx, [now.id], tasks);
  return { note: "已交回给 Superagent 重新判断" };
}

/**
 * Called on every board refresh: what the main session let pass without a decision. It's idle (not still at it, not
 * asking the user) and has been for a while after the item was sent: the item is unavailable, the task goes back to
 * 待办 to be dispatched again. A message queued while it ran starts its next turn at once, so a 20 s quiet
 * spell means it was read and left.
 */
export function sweep(ctx: Ctx) {
  const s = state(ctx);
  if (!s.main) return;
  const m = ctx.sessions.get(s.main);
  if (!m || m.status !== "idle" || Date.now() - m.updatedAt < 20_000) return;
  const left = (at?: number) => !!at && at + 3000 < m.updatedAt;
  if (s.items.some((x) => x.state === "pending" && left(x.sentAt))) {
    updateState(ctx, (x) => {
      for (const it of x.items) if (it.state === "pending" && left(it.sentAt)) Object.assign(it, { state: "unavailable", reason: "调度会话这一轮结束了，没给决定" });
    });
  }
  const stuck = (t: Task) => t.status === "todo" && !!t.routing && t.router === s.main && left(t.routing);
  if (!loadTasks(ctx).store.tasks.some(stuck)) return;
  updateTasks(ctx, (st) => {
    for (const t of st.tasks) {
      if (!stuck(t)) continue;
      note(t, "Superagent 这一轮结束了也没派出去：再派一次，或在它的对话里问问");
      Object.assign(t, { routing: undefined, updatedAt: Date.now() });
    }
  });
}
