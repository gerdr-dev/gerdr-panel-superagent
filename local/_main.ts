// The Superagent's core, shared by tasks.ts, inbox.ts, board.ts and superagent.ts (a helper file: nothing here is
// callable from a page). Modelled on dsh-superagent's domain (docs/001-domain.md there; DESIGN.md「Superagent」here):
//
//   event (Trigger) ─ gate ─┬─ a task subscribed to its conversation → delivered to that task's worker (no Eval)
//                           └─ otherwise → Eval: the main session decides accept / attach / stop / ignore
//   a task typed on the board → already accepted, the main session only picks repository / agent / model
//
// The main session is the secretary (DESIGN.md「秘书」): the one agent the user talks to, and the one that routes. It
// never waits and never does the work itself, and gets everything as messages (a batch arriving while it decides
// waits for its next pause): the user's words from the page (secretary.ts say), board tasks and outside messages to
// route, news about tasks that need the user (notice), and the briefing on its schedule. What it says back is taken
// from its reply at the end of each turn (capture) into the conversation the page shows (_log.ts). It replaced a
// one-off router per task and the panel's own chat on the right. Every event is logged with where it went
// (user/data/superagent.json items), so "what happened to that message" always has an answer.

import { workflow } from "./_config";
import { forRouter } from "./memory";
import { allAgents } from "./_agents";
import { textOf } from "./playbooks";
import { DATA, migrate } from "./_user";
import { activity, find, load as loadTasks, note, update as updateTasks, type Task } from "./_store";
import { wake } from "./_wake";
import { append, windowText } from "./_log";
import { waitingLines } from "./_inbox";
import { isOutside, waitingOn } from "./_waits";

const STATE = `${DATA}/superagent.json`;
/**
 * A fresh session once the current one has been idle this long: the model's prompt cache is gone by then, so going on
 * would re-read its whole context at full price anyway, and a new one re-reads less (the brief, the last 7 days of the
 * conversation). DESIGN.md「秘书」「一个对话框，后面换会话」.
 */
const COLD = 3600_000;
/** And after this many messages without ever going cold (a busy inbox): its context mustn't grow without end. */
const ROTATE = 150;
/** What the secretary replies when there's nothing to tell the user (a turn about routing, news it keeps for later). */
/**
 * A machine marker, not a word: it reads the same whatever language the secretary is told in or answers in, and
 * never turns up in a real sentence. 「（无）」 was the word before (2026-11-10): an English reply would have said
 * "(none)" and shown, and 「附件：（无）」 would have lost it.
 */
export const SILENT = "<silent/>";
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
  would?: { title?: string; parts: unknown[]; team?: boolean };
  reason?: string;
  tasks?: string[];
  /** Workers that gave a delivered message back (not their task's business), with why. */
  handBacks?: { task: string; reason: string; at: number }[];
  sentAt?: number;
  decidedAt?: number;
};

/** Why the secretary is having a turn, for what its reply is (capture): an answer to the user, a briefing, its own news. */
export type Why = "user" | "brief" | "notice" | "route";

type State = {
  main?: string;
  mains: string[];
  brief?: string;
  handled: number;
  next: number;
  items: Item[];
  /** Messages sent since its reply was last taken: what the turn was for (the strongest reason wins). */
  awaiting?: { why: Why; /** when the last message went in */ sent: number };
  /** Before 2026-11-10's status news: what was told as needing the user. Unused now. */
  noticed?: Record<string, string>;
  /** Each task's status as last told to the secretary (notice): task id → its key, so each change is told once. */
  states?: Record<string, string>;
  /** The secretary's agent / model / effort / mode its session started with (设置): a change starts a new one. */
  who?: string;
  /** When the last briefing was asked for: the next one covers what happened since. */
  briefAt?: number;
  /**
   * When the secretary page was first opened (ms): the 去向 log goes back to before there was a secretary, and those
   * old outside messages aren't part of its conversation.
   */
  since?: number;
};

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

/** Every conversation whose news goes to the task: its threads, and those it waits on (wait_for) for now. */
export function follows(t: Task): { source: string; key: string }[] {
  const out = [...threadsOf(t)];
  for (const x of waitingOn(t)) if (!out.some((y) => y.source === x.source && y.key === x.key)) out.push(x);
  return out;
}

/**
 * The tasks a message in this conversation goes to without Eval: every live task following it; when none is live,
 * the latest one that ended (a person speaking in its conversation picks it up again, as dsh resumes an ended
 * Ticket). Dropped tasks get nothing: the person stopped them, so the message is new work to judge.
 */
export function subscribers(tasks: Task[], e: { source: string; key?: string; actor?: string }): Task[] {
  if (!e.key) return [];
  const on = tasks.filter((t) => t.status !== "dropped" && follows(t).some((x) => x.source === e.source && x.key === e.key));
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
    ? w.repos.map((r) => `- ${r.path}${r.note ? `：${r.note}` : ""}`).join("\n")
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
    `你是用户的秘书（Superagent）。用户只跟你一个人说话：什么事都交给你，问进度、要日报也找你。你不亲手做事，把活派给 worker，` +
      `跟着它们，替用户记着每一件事，该他知道、该他拍板的时候告诉他。要派的活也都先到你这里：用户交给你的、看板上建的任务，和外面来的消息（私信、@、告警……）。`,
    talkText(ctx),
    // How it judges is the user's prose (流程 → my-workflow/references/dispatch.md), theirs to read and change; only the
    // command and the facts below are the code's
    textOf(ctx, DISPATCH) || `判断规则（用户的 dispatch.md）不见了：只分派，不自己动手、不等待；拿不准就问用户。`,
    `## 外面来的消息 [消息 cN]：一条命令给出这一批的决定\n` +
      `gerdr panel run superagent.decide '${ex({ decisions: [{ item: "c3", decision: "accept", title: "十几个字的标题", parts: [{ repo: "/绝对路径" }] }, { item: "c4", decision: "ignore", reason: "道谢" }] })}'\n\n` +
      `- attach：${ex({ item: "c5", decision: "attach", task: "t9" })}；stop：${ex({ item: "c6", decision: "stop", task: "t9", reason: "…" })}\n` +
      `- decide 会替你建任务、派出去、回原对话一句、记下这条消息的去向。\n\n` +
      `## 看板任务 [任务 tN]：用看板的命令（和用户点按钮是同一套）\n` +
      `- 派出去：gerdr panel run tasks.dispatch '${ex({ id: "t12", parts: [{ repo: "/绝对路径" }] })}'（可加 title、team）\n` +
      `- 它是在管别的任务：停掉 tasks.drop '${ex({ id: "t9", reason: "…" })}'；转告 tasks.say '${ex({ id: "t9", text: "…" })}'；` +
      `接手一个停掉的任务，派的时候加 "from": "t9"，会带上它的进展和对话；tN 只是条指令、照做完了：tasks.edit '${ex({ id: "t12", status: "done", summary: "停了 t9" })}'\n` +
      `- 用户对某张卡的安排有意见（[重新安排 tN]，比如仓库错了）：用 superagent.decide 照反馈重新安排这张卡，item 就是 tN（它要记下这次安排完了没有）。重新派给 parts（新的完整安排：要留下的已有 worker 那份写 "task": "它的 id"，会收到反馈和这份的 prompt；没留下的停掉；没写 task 的开新 worker，都在这张卡上，第一份新的接负责人的位置）；只是让现在的 worker 自己改，写 "decision": "attach"（task 不写就给负责人）；整件事不做了，写 "decision": "stop" 和 reason。\n` +
      `\n## parts（decide 的 accept 和 tasks.dispatch 一样）\n` +
      `- parts 每项一份活：repo 必填；agent、model、effort 不写就用下面的默认，简单的活可以给便宜的模型；worktree 默认 false。\n` +
      `- 只有一份：就是这件事本身，不用写 prompt。拆成几份并行（用户 @ 了几个 agent，或者活明显能分开做）：每份写 title（十几个字）和 prompt（这一份做什么、和别的份怎么配合）；同一个仓库有两份以上时都写 "worktree": true。\n` +
      `- 几份是同一个需求、要互相配合（前端接后端的新接口）：加 "team": true，成了一张卡片、几个成员，第一份是负责人，成员之间直接对话，不经过你。互不相干的几件事不加，各是一张卡。看不出要动别的仓库就只派一份，worker 发现了会自己拉队友。\n` +
      `- 任务的标题是从内容第一行截的，不够好就加 "title"。\n` +
      `- 命令报错就按错误改了再发那几条。`,
    `## 可选的 agent\n${agentLines.join("\n")}`,
    `## 仓库（用户的设置）\n${repoText}`,
    `## agent 和模型\n${modelText}`,
    rules && `## 怎么派（用户自己写的规则）\n${rules}`,
    forRouter(ctx),
    proactiveText(ctx),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The skill files the brief carries whole (the router doesn't read skills: DESIGN.md, 「派活要快」). */
const SECRETARY = "my-workflow/references/secretary.md";
const ROUTING = "my-workflow/references/routing.md";
const DISPATCH = "my-workflow/references/dispatch.md";
const PROACTIVE = "my-workflow/references/proactive.md";

/**
 * How it talks with the user: the mechanism (what each kind of message is, how its reply reaches the user, the
 * commands for the user's matters) is the code's; how it should talk, when to interrupt and what a briefing says are
 * the user's prose (secretary.md).
 */
function talkText(ctx: Ctx) {
  const ex = (o: unknown) => JSON.stringify(o);
  return [
    `## 和用户说话\n` +
      `- 你收到的消息有几种：[用户] 是用户在秘书页上对你说的话；[任务 tN] / [消息 cN] / [重新安排 tN] 是要派的活（见下面）；` +
      `[动态] 是任务的状态变了（开始做、等用户、待验收、做完、放弃、接着做；中途的进展不会来）；[简报] 是到了写简报的时间。\n` +
      `- **你这一轮最后的回复就是用户看到的话**（工具调用和中间过程他看不到）。没有要告诉他的（派活、分拣、不急的动态），整条回复只写「${SILENT}」。\n` +
      `- 用户问到的、你要说的，先查事实再说：\`gerdr panel run secretary.status\` 给出等他的事（带问题的 id 和选项）、在做的、待验收的、最近完成的。` +
      `不要凭记忆说「做完了」。问到某一件事的细节（做到哪、动态里写了什么、开了哪个 MR、它最后说了什么）：` +
      `\`gerdr panel run tasks.list '${ex({ id: "t12" })}'\` 只给这一件（和它的成员），别不带 id 拉整块看板。\n` +
      `- 用户交给你一件事：是活就派（\`tasks.add\` 带 \`"start": true\`，你知道去哪个仓库就给 \`repo\`，不知道就不给，交给下面的派活）；` +
      `他要亲手做的步骤记成人工任务（\`tasks.add\` 带 \`"owner": "human"\`）。派完一句话告诉他交给了谁。\n` +
      `- 替用户回答 worker：问题 \`tasks.answerQuestion ${ex({ id: "t5", q: "1", value: "选项或他的原话" })}\`；` +
      `验收 \`tasks.accept ${ex({ id: "t5" })}\` / 打回 \`tasks.reject ${ex({ id: "t5", feedback: "…" })}\`；` +
      `他做完了自己的步骤 \`tasks.complete ${ex({ id: "t5", value: "要交回的值（没有就不写）" })}\`；` +
      `转告 worker \`tasks.say ${ex({ id: "t5", text: "…" })}\`；不做了 \`tasks.drop ${ex({ id: "t5", reason: "…" })}\`。\n` +
      `- 不要用你自带的提问工具（AskUserQuestion）：有要问用户的，直接在回复里问，他会在秘书页上答你。\n` +
      `- **要用户回答的问题会作为卡片出现在秘书页的对话里**（[动态] 和 secretary.status 里带着问题、选项和交答案的命令）：` +
      `他可以直接点卡片，也可以对你说。你说一句要他决定什么、为什么要紧就行，不用重复选项，更不要让他去看板或 worker 的对话里答。` +
      `他用文字答了，你用给出的命令替他交（一个问题一条命令），再告诉他交了。密钥不经过对话：卡片上会让他在看板上填。\n` +
      `- 改这个面板本身（设置、流程、触发器、定时任务、页面）不归你：告诉用户去面板右边的面板助手那里说。\n` +
      `- 你的对话每隔一阵会换成新的会话，只带最近 7 天的聊天：要长期记住的事当场记下 —— 用户交代的活进看板（任务），` +
      `他的偏好和规矩用 \`remember\` 记进记忆，做事方式写进流程（skill）。只留在聊天里的，过几天就忘了。`,
    textOf(ctx, SECRETARY),
  ]
    .filter(Boolean)
    .join("\n\n");
}

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

/** Which reason for a turn wins when several messages go into one: the user's question is answered first. */
const RANK: Record<Why, number> = { route: 0, notice: 1, brief: 2, user: 3 };

/**
 * Hands the secretary messages: `blocks` are items in the formats the brief describes, `why` what they are (what its
 * reply will be taken as). Starts a session (the brief, the last 7 days of the conversation, then the messages) when
 * there's none, it failed, or it is idle and cold (COLD) or long (ROTATE); otherwise it's a message, which a running
 * session reads at its next pause. When the user's rules changed since it was told them (repositories, models,
 * roles), the new brief goes first.
 */
export async function toMain(ctx: Ctx, blocks: string[], why: Why = "route", attachments?: string[]): Promise<string> {
  // What it said since the last message, before this one resets that (a reply in the middle of its turn included)
  await capture(ctx, true);
  const b = await brief(ctx);
  const h = hash(b);
  const s = state(ctx);
  const cur = s.main ? ctx.sessions.get(s.main) : null;
  const body = blocks.join("\n\n");
  const idle = cur?.status === "idle";
  const cold = !!cur && idle && Date.now() - cur.updatedAt > COLD;
  const r = workflow(ctx).router;
  // Who it runs as (agent, model, effort, mode) is fixed when a session starts: changed in 设置, the next one takes it
  const who = JSON.stringify(r);
  const changed = idle && !!s.who && s.who !== who;
  let id: string;
  if (!cur || cur.status === "error" || cold || changed || (idle && s.handled >= ROTATE)) {
    const past = windowText(ctx);
    const sess = await ctx.sessions.start({
      cwd: ctx.workspace.dir,
      agent: r.agent || undefined,
      model: r.model || undefined,
      effort: r.effort || undefined,
      mode: r.mode || undefined,
      title: "Superagent 秘书",
      prompt: [b, past && `## 最近 7 天你和用户的对话（之前的会话里说的，现在接着）\n\n${past}`, body].filter(Boolean).join("\n\n---\n\n"),
      tags: { superagent: "main" },
      workspace: "none",
      attachments,
    });
    updateState(ctx, (x) => {
      Object.assign(x, { main: sess.id, mains: [...(x.mains ?? []), sess.id], brief: h, handled: blocks.length, who });
    });
    // The one it replaces finished its last turn: let it go (still readable, as every one before it)
    if (cur && cur.status === "idle") await ctx.sessions.close(cur.id).catch(() => {});
    id = sess.id;
  } else {
    const text = h !== s.brief ? `（用户的规则有更新，以这份为准）\n\n${b}\n\n---\n\n${body}` : body;
    await ctx.sessions.send(cur.id, text, attachments?.length ? { attachments } : undefined);
    updateState(ctx, (x) => {
      x.handled = (x.handled ?? 0) + blocks.length;
      x.brief = h;
    });
    id = cur.id;
  }
  updateState(ctx, (x) => {
    const was = x.awaiting;
    x.awaiting = { why: was && RANK[was.why] > RANK[why] ? was.why : why, sent: Date.now() };
  });
  return id;
}

/**
 * What's left to show once its silence markers are taken out: several messages answered in one turn come back with
 * one each, and it sometimes ends a real sentence with one. A whole reply that is only 「（无）」 (the old word, from
 * sessions told before the marker) counts too, until those sessions are replaced.
 */
const unsilenced = (text: string) => {
  const t = text.replace(/<\s*silent\s*\/?\s*>/gi, "").trim();
  return /^([（(]\s*无\s*[）)][。.\s]*)+$/.test(t) ? "" : t;
};
const silent = (text: string) => !unsilenced(text).replace(/[。.\s]/g, "");

/** Gerdr's note at the end of a reply on how the turn ended (lastReply in its workhost.go): not the secretary's words. */
const ENDING = /^(这一轮结束：|Turn ended: |出错：|Error: )/;

/**
 * Takes what the secretary said since it was last sent something into the conversation the page shows (_log.ts),
 * once: when its turn is over, or right before another message goes to it (a reply in the middle of a turn, which
 * that message would otherwise reset). Its silence marker (SILENT) is nothing to show. Called from the page's refreshes, the
 * board's (tasks.list, also on a schedule) and toMain, so a reply lands whether or not anyone has the page open.
 */
export async function capture(ctx: Ctx, beforeSend = false) {
  const s = state(ctx);
  if (!s.main || !s.awaiting) return;
  const m = ctx.sessions.get(s.main);
  if (!m) return;
  const text = m.reply
    .split(/\n\s*\n/)
    .filter((p) => !ENDING.test(p.trim()))
    .join("\n\n")
    .trim();
  // Over: idle or failed (waiting for an approval isn't: the turn goes on after it). Right after a message went in it
  // can still read idle with nothing said yet, before the turn starts: that isn't over until a while has passed.
  const ended = m.status === "idle" || m.status === "error";
  const over = ended && (!!text || Date.now() - s.awaiting.sent > 30_000);
  // Mid-turn, only right before a message goes in (it resets the reply), and only when it has said something
  if (!over && !(beforeSend && text)) return;
  const why = updateState(ctx, (x) => {
    if (!x.awaiting || x.main !== m.id) return null;
    const w = x.awaiting.why;
    // Mid-turn: the turn goes on, and so does what it is for
    if (over) x.awaiting = undefined;
    return w;
  });
  if (!why || !text || silent(text)) return;
  append(ctx, { who: "agent", text: unsilenced(text), kind: why === "user" ? "reply" : why === "brief" ? "brief" : "notice", session: m.id });
}

/**
 * What a task waiting on the user asks of them, with how the secretary hands in the answer, so it can ask the user
 * itself in the conversation and answer for them (the user: "the secretary shouldn't send me to click the question;
 * it should ask me and I answer"). Indented lines under the task's line; "" when it asks nothing answerable.
 */
export function askText(t: any): string {
  const ex = (o: unknown) => `'${JSON.stringify(o)}'`;
  const opts = (o?: string[]) => (o?.length ? `（选项：${o.join(" / ")}）` : "");
  if (t.owner === "human") {
    const qs = (t.questions ?? []).filter((q: any) => !q.dropped && !q.answer);
    if (qs.length)
      return qs
        .map((q: any) => `    - 问题 ${q.id}：${q.title}${opts(q.options)}${q.kind === "value" && q.label ? `（要一个值：${q.label}）` : ""} → tasks.answerQuestion ${ex({ id: t.id, q: q.id, value: "…" })}`)
        .join("\n");
    const k = t.handBack?.kind;
    if (k === "choice") return `    要用户选：${t.title}${opts(t.handBack.options)} → tasks.complete ${ex({ id: t.id, value: "选的那项" })}`;
    if (k === "value") return `    要用户给：${t.handBack.label ?? t.title} → tasks.complete ${ex({ id: t.id, value: "…" })}`;
    if (k === "secret") return `    要用户交一个密钥（${t.handBack.label ?? t.handBack.name ?? ""}）：不能经过对话，请他在看板上 ${t.id} 那里填`;
    return t.steps ? `    要用户亲手做：${t.steps.replace(/\n/g, "\n    ")}\n    他说做完了 → tasks.complete ${ex({ id: t.id })}` : "";
  }
  return t.question ? `    worker 问：${t.question} → tasks.answer ${ex({ id: t.id, answer: "用户的回答" })}` : "";
}

/** Where a task stands, for news: what changes it is a change of status; progress within one isn't. */
const STATUS: Record<string, string> = { todo: "待办", active: "在做", you: "等你", review: "待验收", done: "做完了", dropped: "放弃了" };

/**
 * News for the secretary (DESIGN.md「秘书」「什么时候打扰」): every change of a task's status — started, waiting on
 * the user (a question, a step of theirs, stopped, an approval, an error: a new question counts too), a result to
 * review, done, dropped, going on again. Progress within a status (activity, a new summary) isn't news: the user asked
 * for status changes only. One message per sync with every change in it; the secretary decides whether to tell the
 * user now, keep it for the briefing or say nothing. A task first seen still waiting to be started isn't news (it was
 * just added). The first time there's no record, so where everything stands is taken as known, not sent as a flood.
 * `tasks` is tasks.list's view (columns, questions, live sessions).
 */
export async function notice(ctx: Ctx, tasks: any[]) {
  const waiting = new Map(waitingLines(tasks).map((l) => [l.id, l]));
  const now: Record<string, string> = {};
  const lines: Record<string, string> = {};
  for (const t of tasks) {
    const head = `${t.id}「${t.title}」`;
    if (t.status === "dropped") {
      now[t.id] = "dropped";
      lines[t.id] = `${head} 放弃了${t.dropReason ? `：${t.dropReason}` : ""}`;
    } else if (t.status === "done") {
      now[t.id] = "done";
      const link = (t.links ?? []).at(-1);
      lines[t.id] = `${head} 做完了${t.summary ? `：${t.summary}` : t.handedBack && t.handBack?.kind !== "secret" ? `：${t.handedBack}` : ""}${link ? `（${link.label}：${link.url}）` : ""}`;
    } else if (t.column === "you") {
      const open = (t.questions ?? []).filter((q: any) => !q.dropped && !q.answer).map((q: any) => q.id);
      now[t.id] = `you|${t.question ?? ""}|${t.stopped ? "stopped" : ""}|${t.live?.status === "waiting" || t.live?.status === "error" ? t.live.status : ""}|${open.join(",")}`;
      const l = waiting.get(t.id);
      const ask = askText(t);
      lines[t.id] = l
        ? `${l.title}${ask ? `\n${ask}` : l.body ? `\n  ${l.body.replace(/\n/g, "\n  ")}` : ""}`
        : `${head} 的 worker ${t.live?.status === "error" ? "出错了" : `在等你批准：${t.live?.waiting ?? ""}`}`;
    } else if (t.column === "review") {
      now[t.id] = "review";
      lines[t.id] = `${head} 交了结果，等你验收：${t.summary ?? ""}`;
    } else if (t.session || t.status === "running" || t.status === "delivering") {
      now[t.id] = "active";
      lines[t.id] = `${head} `;
    } else now[t.id] = "todo";
  }
  const fresh = updateState(ctx, (s) => {
    const was = s.states;
    s.states = now;
    if (!was) return [];
    const out: string[] = [];
    for (const [id, key] of Object.entries(now)) {
      const before = was[id];
      if (before === key || key === "todo") continue;
      const from = before ? STATUS[before.split("|")[0]] : "";
      if (key === "active") lines[id] += from === "等你" || from === "待验收" ? "接着做了" : "开始做了";
      out.push(`${lines[id]}${from && key !== "active" ? `（之前：${from}）` : ""}`);
    }
    return out;
  });
  if (!fresh.length) return;
  await toMain(ctx, [`[动态] 这些任务的状态变了（细节用 secretary.status 查）：\n${fresh.map((l) => `- ${l}`).join("\n")}`], "notice");
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
  const related = tasks.filter((t) => follows(t).some((x) => x.source === e.source && x.key === e.key));
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

/**
 * The user's feedback on how a card was handed out, to the main session to rearrange it (superagent.ts boardTask,
 * reroute). The block (the card's workers, what they said, the feedback) is built by tasks.reroute.
 */
export async function rerouteTask(ctx: Ctx, id: string, block: string) {
  const main = await toMain(ctx, [block]);
  return updateTasks(ctx, (s) => {
    const t = find(s, id);
    if (t.reroute) t.reroute.router = main;
    return t;
  });
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
  const unanswered = (t: Task) => !!t.reroute && t.reroute.router === s.main && left(t.reroute.at);
  if (!loadTasks(ctx).store.tasks.some((t) => stuck(t) || unanswered(t))) return;
  updateTasks(ctx, (st) => {
    for (const t of st.tasks) {
      if (unanswered(t)) {
        // Its workers were left as they were: the card goes on, the user can send the feedback again
        activity(st, t, { kind: "stuck", text: "调度这一轮结束了，没重新安排：再说一次，或去它的对话里问问" });
        t.reroute = undefined;
      }
      if (!stuck(t)) continue;
      note(t, "Superagent 这一轮结束了也没派出去：再派一次，或在它的对话里问问");
      Object.assign(t, { routing: undefined, updatedAt: Date.now() });
    }
  });
}
