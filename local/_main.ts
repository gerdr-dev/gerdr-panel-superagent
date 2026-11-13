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
// route, news about tasks that need the user (notice), and the briefing on its schedule. What the user sees of it is
// its own conversation (the 秘书 page is that chat): its replies, and the messages the board sent it. Its rules are
// in its system prompt (a file Gerdr re-reads, SYSTEM), not in the chat; one conversation that is compacted, never
// replaced by time (DESIGN.md「秘书」). It replaced a one-off router per task and the panel's own chat on the right. Every event is logged with where it went
// (user/data/superagent.json items), so "what happened to that message" always has an answer.

import { workflow } from "./_config";
import { forRouter } from "./memory";
import { allAgents } from "./_agents";
import { textOf } from "./playbooks";
import { DATA, migrate } from "./_user";
import { activity, find, load as loadTasks, note, update as updateTasks, type Task } from "./_store";
import { cutLine, wake } from "./_wake";
import { windowText } from "./_log";
import { isOutside, waitingOn } from "./_waits";

const STATE = `${DATA}/superagent.json`;
/**
 * The secretary's rules (the brief): its system prompt, through Gerdr's systemFile, re-read whenever its agent starts
 * again. Kept out of the chat, which is the 秘书 page: every new session used to open with them, the last 7 days of
 * talk and the message, one long first message the user had to scroll past (2026-11-12).
 */
const SYSTEM = `${DATA}/secretary-system.md`;
/** The page's own log of the talk from before the secretary's chat was the page (_log.ts), for it to look up. */
const HISTORY = `${DATA}/secretary-history.md`;
/** Idle this long, its prompt cache is gone: a compaction then costs no more than the next message would. */
const COLD = 3600_000;
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
  /**
   * What was said just before it in the same conversation, oldest first, the user's own words included (a chat source
   * gives them as data.context: only others' messages are events, and a reply alone often means nothing).
   */
  context?: { who: string; me?: boolean; text: string; at?: number }[];
};

/** The conversation before a message, as lines for whoever judges or handles it; "" when the source gave none. */
export function contextLines(e: Ev, only?: (c: NonNullable<Ev["context"]>[number]) => boolean) {
  const l = (e.context ?? []).filter((c) => !only || only(c));
  return l.map((c) => `- ${c.me ? "用户本人" : c.who}${c.at ? `（${new Date(c.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}）` : ""}：${c.text.replace(/\s*\n\s*/g, " ")}`).join("\n");
}

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
  /** Closed by the user in 去向 (superagent.dismiss) instead of decided: a late decision on it is a no-op. */
  dismissed?: boolean;
};

/** Why the secretary is having a turn: the user's words, a briefing (both owe the user a message), its own news, routing. */
export type Why = "user" | "brief" | "notice" | "route";

type State = {
  main?: string;
  /** The tasks the last stuck check reported (secretary.checkStuck): told as "still stuck" next time. */
  stuck?: string[];
  mains: string[];
  brief?: string;
  /** Before 2026-11-12, messages since its session started (it was replaced after 150). Unused now. */
  handled?: number;
  /** When it was last compacted (secretary.compact): with compactTokens 0, compacted again once something was said since. */
  compactedAt?: number;
  /** Its session reads its rules from the system file (since 2026-11-12): one from before is replaced once, fresh. */
  system?: boolean;
  next: number;
  items: Item[];
  /** Before 2026-11-12 (when the page drew its own log): what a turn owed the user, and when it last sent a message. Unused now. */
  awaiting?: unknown;
  messageAt?: number;
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

function load(ctx: Ctx): { s: State; etag?: string; text?: string } {
  migrate(ctx);
  const st = ctx.fs.stat(STATE);
  if (!st) return { s: { mains: [], next: 1, items: [] } };
  const text = ctx.fs.read(STATE);
  return { s: JSON.parse(text), etag: st.etag, text };
}

export function state(ctx: Ctx): State {
  return load(ctx).s;
}

export function updateState<T>(ctx: Ctx, fn: (s: State) => T): T {
  for (let i = 0; ; i++) {
    const { s, etag, text } = load(ctx);
    const out = fn(s);
    if (s.items.length > KEEP) s.items = s.items.slice(-KEEP);
    // Nothing changed (tasks.list noting task states that are as they were, mostly): no write. A write tells the
    // board's page to reload (usePanelChange("user/data")), and that reload runs tasks.list again: writing anyway
    // looped once a second for as long as the board was on screen (2026-11-11: ~1 tasks.list and ~2 superagent.log
    // runs a second, about 2 GB allocated a minute in Gerdr's backend).
    const next = JSON.stringify(s, null, 2);
    if (next === text) return out;
    try {
      ctx.fs.write(STATE, next, etag ? { etag } : undefined);
      return out;
    } catch (e) {
      if (i >= 4) throw e;
    }
  }
}

export function compact(e: GerdrEvent): Ev {
  const context = (Array.isArray(e.data?.context) ? e.data.context : [])
    .filter((c: any) => c && typeof c.text === "string")
    .slice(-8)
    .map((c: any) => ({ who: String(c.who ?? ""), me: c.me === true || undefined, text: String(c.text).slice(0, 600), at: typeof c.at === "number" ? c.at : undefined }));
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
    ...(context.length ? { context } : {}),
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
  // An empty list is "none" (handed back: hand_back leaves the conversation), not "its origin's"
  if (t.threads) return t.threads;
  return t.origin?.key ? [{ source: t.origin.source, key: t.origin.key }] : [];
}

/** Every conversation whose news goes to the task: its threads, and those it waits on (wait_for) for now. */
export function follows(t: Task): { source: string; key: string }[] {
  const out = [...threadsOf(t)];
  for (const x of waitingOn(t)) if (!out.some((y) => y.source === x.source && y.key === x.key)) out.push(x);
  return out;
}

/**
 * The tasks a message in this conversation goes to without the secretary: every live task following it. An ended
 * one gets nothing straight: whether a word after it was accepted is more work on it, about something else or just
 * "thanks" is the secretary's to judge (it sees the ended ones: sharers), and attaching it picks the task up again
 * (2026-11-13, the user: "已经完成的任务一律先给秘书判断"). Dropped tasks get nothing either.
 */
export function subscribers(tasks: Task[], e: { source: string; key?: string; actor?: string }): Task[] {
  if (!e.key) return [];
  return tasks.filter((t) => t.status !== "dropped" && t.status !== "done" && follows(t).some((x) => x.source === e.source && x.key === e.key));
}

/**
 * Every task this conversation ever went to (done ones too; not dropped). Only a conversation that is one task's alone
 * (a thread made for it, an MR) can send its messages straight to that worker: in one that holds several (a DM where
 * two things were asked, one of them already accepted and still talked about) a message may be about any of them, and
 * only reading it tells which — the secretary's job (2026-11-13, the user: "还是靠不住…直接发给需求2 也不正确").
 */
export function sharers(tasks: Task[], e: { source: string; key?: string }): Task[] {
  if (!e.key) return [];
  return tasks.filter((t) => t.status !== "dropped" && follows(t).some((x) => x.source === e.source && x.key === e.key));
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
  // its own title.
  const head = e.reply ? `${e.source} 上${by}接着说` : e.title || `${e.source}/${e.kind}`;
  // What the user said there themselves right before (not through you): you'd otherwise answer without it
  const ctxl = e.context ?? [];
  let k = ctxl.length;
  while (k > 0 && ctxl[k - 1].me) k--;
  const mine = contextLines({ ...e, context: ctxl.slice(k) });
  return wake(ctx, id, {
    how: e.reply ? `${by || "有人"}回复了` : e.title || `${e.source}/${e.kind}`,
    fold: `[${e.source}] ${by}${e.reply ? "接着说" : ""}：${cutLine(text, 50)}`,
    text:
      // How to handle it is in task.md「任务面板发给你的消息」(the worker's skill), not repeated in every message
      `[${head}]（任务 ${id}，消息 ${e.id}）\n\n${mine ? `用户本人在那里先说了：\n${mine}\n\n${by || "对方"}接着说：\n` : ""}${text}`,
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
    `model 填下面「可选的模型」里那个 agent 的 id（括号里是界面上显示的名字和版本）；写错了命令会报错并列出可选的。` +
    `用户点名某个模型或版本（「fable 5.2」）：找名字对得上的 id 填；没有对得上的就告诉他有哪些，不要换一个凑合。`;
  // The real list from Gerdr (ids are often aliases: "fable" alone doesn't say it is Fable 5.2)
  const modelLines = agents
    .filter((a) => a.models?.length)
    .map((a) => `- ${a.id}：${a.models!.map((m) => (m.name && m.name !== m.id ? `${m.id}（${m.name}）` : m.id)).join("、")}`);
  // The user's own routing rules (how they pick a repository, when a stronger or cheaper model): their prose, whole
  const rules = textOf(ctx, ROUTING);
  const ex = (o: unknown) => JSON.stringify(o);
  return [
    `你是用户的秘书（Superagent）。用户只跟你一个人说话：什么事都交给你，问进度、要日报也找你。你不亲手做事，把活派给 worker，` +
      `跟着它们，替用户记着每一件事，该他知道、该他拍板的时候告诉他。要派的活也都先到你这里：用户交给你的、任务面板上建的任务，和外面来的消息（私信、@、告警……）。`,
    talkText(ctx),
    // How it judges is the user's prose (流程 → my-workflow/references/dispatch.md), theirs to read and change; only the
    // command and the facts below are the code's
    textOf(ctx, DISPATCH) || `判断规则（用户的 dispatch.md）不见了：只分派，不自己动手、不等待；拿不准就问用户。`,
    `## 外面来的消息 [消息 cN]：一条命令给出这一批的决定\n` +
      `gerdr panel run superagent.decide '${ex({ decisions: [{ item: "c3", decision: "accept", title: "十几个字的标题", parts: [{ repo: "/绝对路径" }] }, { item: "c4", decision: "ignore", reason: "道谢" }] })}'\n\n` +
      `- attach：${ex({ item: "c5", decision: "attach", task: "t9" })}；stop：${ex({ item: "c6", decision: "stop", task: "t9", reason: "…" })}\n` +
      (workflow(ctx).inboxWork === "review"
        ? `- decide 的 accept 会替你建任务，但**不派出去**：放进任务面板的「待办」，用户看过、改好再派（他的设置）。parts 照常写，会成为卡片上的仓库和 agent；拆成几份就是几张卡。` +
          `记下这条消息的去向；回不回原对话、什么时候回，按他的设置自动处理，你不用另外回。\n\n`
        : `- decide 会替你建任务、派出去、记下这条消息的去向；回不回原对话按用户的设置自动处理。\n\n`) +
      `## 任务面板上的任务 [任务 tN]：用任务面板的命令（和用户点按钮是同一套）\n` +
      `- 派出去：gerdr panel run tasks.dispatch '${ex({ id: "t12", parts: [{ repo: "/绝对路径" }] })}'（可加 title）\n` +
      `- 它是在管别的任务：停掉 tasks.drop '${ex({ id: "t9", reason: "…" })}'；转告 tasks.say '${ex({ id: "t9", text: "…" })}'；` +
      `接手一个停掉的任务，派的时候加 "from": "t9"，会带上它的进展和对话；tN 只是条指令、照做完了：tasks.edit '${ex({ id: "t12", status: "done", summary: "停了 t9" })}'\n` +
      `- 用户对某张卡的安排有意见（[重新安排 tN]，比如仓库错了）：用 superagent.decide 照反馈重新安排这张卡，item 就是 tN（它要记下这次安排完了没有）。重新派给 parts（新的完整安排：要留下的已有 worker 那份写 "task": "它的 id"，会收到反馈和这份的 prompt；没留下的停掉；没写 task 的开新 worker，第一份接这张卡，其余各是一张新卡）；只是让现在的 worker 自己改，写 "decision": "attach"；整件事不做了，写 "decision": "stop" 和 reason。\n` +
      `\n## parts（decide 的 accept 和 tasks.dispatch 一样）\n` +
      `- parts 每项一份活：repo 必填；agent、model、effort 不写就用下面的默认，简单的活可以给便宜的模型；worktree 默认 false。\n` +
      `- 只有一份：就是这件事本身，不用写 prompt。拆成几份并行（用户 @ 了几个 agent，或者活明显能分开做）：每份写 title（十几个字）和 prompt（这一份做什么、和别的份怎么配合）；同一个仓库有两份以上时都写 "worktree": true。\n` +
      `- 每份都是一张独立的卡、一个 worker。一份要用另一份的结果（前端接后端的新接口）：先派被依赖的那份，另一份用 tasks.add 建好、带 "blockedBy": ["tN"] 和 "start": true：tN 做完时任务面板会自动派出它，并把 tN 的结果写进它的交代。\n` +
      `- **几份并行之前，先找它们该共用的东西**（同一套组件、风格、规范、规划文档）：在仓库里找到了，就把源码和文档的路径写进每一份的 prompt，写明「用这里的，不要自己另写一套」；` +
      `只给成片、截图、效果图不够，worker 只能照着重画。还没有共用的底子，就先只派一份「打底」（抽出共用组件、写好规范），其余几份照上一条建成等它的卡。` +
      `交代里说清哪些是共用的、并行时只读，要改共用的就在回复里提出来，不要各自复制一份改；别只写「别碰别人的文件」。\n` +
      `- 任务的标题是从内容第一行截的，不够好就加 "title"。\n` +
      `- 命令报错就按错误改了再发那几条。`,
    `## 可选的 agent\n${agentLines.join("\n")}`,
    `## 仓库（用户的设置）\n${repoText}`,
    `## agent 和模型\n${modelText}` +
      (modelLines.length ? `\n\n可选的模型（Gerdr 上次见到的；没列出的 agent 还没在这台电脑上跑过）：\n${modelLines.join("\n")}` : ""),
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
const COMPACT = "my-workflow/references/compact.md";
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
      `- **秘书页就是你这段对话**：用户在这里对你打字，你回复里写的就是他看到的。直接在回复里说，不用任何工具发消息；` +
      `调了哪些命令他也看得见（折起来的一行），所以结论写在回复的正文里。\n` +
      `- 别的消息也会出现在这段对话里，开头标着是什么：[任务 tN] / [消息 cN] / [重新安排 tN] 是要派的活（见下面）；` +
      `[检查] 是定时检查发现了卡住的任务；[简报] 是到了写简报的时间；[tN 的回答] 是你转给 worker 的问题它答了；[任务面板] 是任务面板的提醒；` +
      `[用户] 是用户在面板助手那里说、转给你的。` +
      `用户能看到它们，所以派活、分拣这种不用说话的，回复只写一句结论（「派给了 t12」「没接：道谢」），别把过程再讲一遍。\n` +
      `- **任务面板是用户自己盯的，你是辅助**：任务的状态变化不会发给你，你也不去盯、不去推进任务。用户问起、或者定时任务（[检查]、[简报]）交给你时，才去看任务面板。` +
      `用户交代的才做：他让你催、让你转告，你再用下面的命令去做。\n` +
      `- 用户问到的、你要说的，先查事实再说：\`gerdr panel run secretary.status\` 给出等他的事（带问题的 id 和选项）、在做的、待验收的、最近完成的。` +
      `不要凭记忆说「做完了」。问到某一件事的细节（做到哪、开了哪个 MR、它最后说了什么）：` +
      `\`gerdr panel run tasks.list '${ex({ id: "t12" })}'\` 只给这一件（和它的成员），别不带 id 拉整块任务面板。\n` +
      `- **说到某个任务的结果、方案、结论时，别缩写 worker 的话**（缩写会丢掉他要的细节）：说一句为什么要他看、要他做什么，` +
      `让他在任务面板上打开 tN 看 worker 的原话。\n` +
      `- **用户追问某个任务里的细节**（方案里为什么这样、某个数字哪来的、它具体改了什么）：别凭你看到的摘要答，转给做它的 worker —— ` +
      `\`gerdr panel run tasks.message '${ex({ id: "t12", text: "用户的原话" })}'\`，说一句「问了 t12」就结束这一轮。` +
      `它答完，原话会作为 [t12 的回答] 出现在这段对话里，用户直接看得到：你不用转述，有要补的（下一步要他做什么）再说一句。` +
      `跨需求的、要汇总的（哪些在等他、进度、日报）才由你自己答。\n` +
      `- 用户交给你一件事：是活就派（\`tasks.add\` 带 \`"start": true\`，知道去哪个仓库就给 \`repo\`；不知道就按下面「怎么派」挑，挑不出来就先问他再派）；` +
      `他要亲手做的步骤记成人工任务（\`tasks.add\` 带 \`"owner": "human"\`）。派完一句话告诉他交给了谁。\n` +
      `- 替用户回答 worker：问题 \`tasks.answerQuestion ${ex({ id: "t5", q: "1", value: "选项或他的原话" })}\`；` +
      `验收 \`tasks.accept ${ex({ id: "t5" })}\` / 打回 \`tasks.reject ${ex({ id: "t5", feedback: "…" })}\`；` +
      `他做完了自己的步骤 \`tasks.complete ${ex({ id: "t5", value: "要交回的值（没有就不写）" })}\`；` +
      `转告 worker \`tasks.say ${ex({ id: "t5", text: "…" })}\`；不做了 \`tasks.drop ${ex({ id: "t5", reason: "…" })}\`。\n` +
      `- 不要用你自带的提问工具（AskUserQuestion）：有要问用户的，直接在回复里问，他会在这里答你。` +
      `问了就先不派，这一轮到此为止，他的回答会是他的下一条消息。\n` +
      `- **仓库拿不准就先问，不要先派了再说明**（包括这件事不属于仓库列表里的任何一个）：带上你的建议问他，怎么挑、怎么建议见「怎么派」。\n` +
      `- **worker 要用户回答的问题**（secretary.status 里带着问题、选项和交答案的命令）：页面顶上「等你」那一栏列着，他能点开去答，也可以对你说。` +
      `你问他的时候说清要他决定什么、为什么要紧、有哪几个选项，他答了，你用给出的命令替他交（一个问题一条命令），再告诉他交了。密钥不经过对话：让他在任务面板上那张卡里填。\n` +
      `- 改这个面板本身（设置、流程、触发器、定时任务、页面）不归你：告诉用户去面板右边的面板助手那里说。\n` +
      `- 这段对话一直用下去，长了会被压缩：早先的聊天变成一段摘要，细节会丢。要长期记住的事当场记下 —— 用户交代的活进任务面板（任务），` +
      `他的偏好和规矩用 \`remember\` 记进记忆，做事方式写进流程（skill）。只留在聊天里的，压缩之后就只剩个大概。`,
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

/**
 * Hands the secretary messages: `blocks` are items in the formats the brief describes, `why` what they are (kept for
 * callers). `fold`: the one line its chat shows instead (Gerdr's send fold); without it Gerdr folds a message from
 * code to its first line anyway. false: shown whole, for what the user should read (their own words, a worker's answer). The brief goes to its system file first. One conversation goes on
 * and is compacted (secretary.compact), never replaced by time. A new one only when there's none, it failed, or
 * 设置 changed who runs it: it carries the old one on (continueFrom), so the page still reads as one conversation.
 * When the rules changed while it runs, one line says so: its agent only re-reads the system file when it starts again.
 */
export async function toMain(ctx: Ctx, blocks: string[], why: Why = "route", attachments?: string[], fold?: string | false): Promise<string> {
  void why;
  const body = blocks.join("\n\n");
  const { id, changed, hash: h } = await ensureMain(ctx, body, attachments, fold);
  if (id.fresh) return id.id;
  // The rules changed: a line of its own, folded, so it doesn't sit on top of what the user wrote
  if (changed) await ctx.sessions.send(id.id, `[任务面板] 你的规则有更新：重读一遍 ${abs(ctx, SYSTEM)}，以它为准。`, { fold: "[任务面板] 规则有更新" } as any);
  await ctx.sessions.send(id.id, body, { ...(attachments?.length ? { attachments } : {}), ...(fold ? { fold } : fold === false ? { show: true } : {}) } as any);
  if (changed) updateState(ctx, (x) => void (x.brief = h));
  return id.id;
}

const abs = (ctx: Ctx, p: string) => `${ctx.workspace.dir}/${p}`;

/**
 * The brief, written where Gerdr reads the secretary's system prompt from. Returns whether it changed since the
 * session was told (state.brief).
 */
async function writeSystem(ctx: Ctx): Promise<{ hash: string; changed: boolean }> {
  migrateLog(ctx);
  let b = await brief(ctx);
  if (ctx.fs.stat(HISTORY))
    b += `\n\n## 以前的聊天\n秘书页还是面板自己画的那阵子（2026-11-12 以前）你和用户说过的话，在 ${abs(ctx, HISTORY)}：用户提起那时候的事再去读。`;
  const h = hash(b);
  const st = ctx.fs.stat(SYSTEM);
  if (!st || hash(ctx.fs.read(SYSTEM)) !== h) ctx.fs.write(SYSTEM, b, st ? { etag: st.etag } : undefined);
  return { hash: h, changed: !!state(ctx).brief && state(ctx).brief !== h };
}

/**
 * The secretary's session, started when there's none (or it failed, or 设置 changed who runs it). `first`: what a
 * new one is sent first (nothing: it just opens, for the page). fresh: it was started now, with `first`.
 */
export async function ensureMain(ctx: Ctx, first?: string, attachments?: string[], fold?: string | false): Promise<{ id: { id: string; fresh: boolean }; changed: boolean; hash: string }> {
  const { hash: h, changed } = await writeSystem(ctx);
  const s = state(ctx);
  const cur = s.main ? ctx.sessions.get(s.main) : null;
  const r = workflow(ctx).router;
  // Who it runs as (agent, model, effort, mode) is fixed when a session starts: changed in 设置, the next one takes it
  const who = JSON.stringify(r);
  const idle = cur?.status === "idle" || cur?.status === "error";
  // From before the system file (its rules were its first message): replaced once, not carried on — that chat is
  // the old page's backstage, and what was said is in HISTORY. Only on a Gerdr that takes a system file: sessions
  // carry `context` from the same Gerdr version on, and an older one would start the new session without its rules
  const old = !!cur && !s.system && (cur as any).context !== undefined;
  const replace = !!cur && (old || (idle && (cur.status === "error" || (!!s.who && s.who !== who))));
  if (cur && !replace) return { id: { id: cur.id, fresh: false }, changed, hash: h };
  const sess = await ctx.sessions.start({
    cwd: ctx.workspace.dir,
    agent: r.agent || undefined,
    model: r.model || undefined,
    effort: r.effort || undefined,
    mode: r.mode || undefined,
    title: "Superagent 秘书",
    systemFile: abs(ctx, SYSTEM),
    // The conversation goes on in the new one: its chat above, the agent told what was said
    continueFrom: cur && !old && cur.status !== "running" ? cur.id : undefined,
    tags: { superagent: "main" },
    workspace: "none",
  } as any);
  // A Gerdr that took the system file says so; an older one ignored it, so the rules go in front of the first message
  const system = (sess as any).systemFile === abs(ctx, SYSTEM);
  const lead = system ? first : [await brief(ctx), first].filter(Boolean).join("\n\n---\n\n");
  updateState(ctx, (x) => {
    Object.assign(x, { main: sess.id, mains: [...(x.mains ?? []), sess.id], brief: h, who, compactedAt: undefined, system });
  });
  if (lead || attachments?.length) await ctx.sessions.send(sess.id, lead || "", { ...(attachments?.length ? { attachments } : {}), ...(fold ? { fold } : fold === false ? { show: true } : {}) } as any);
  // The one it replaces finished its last turn: let it go (still readable, as every one before it)
  if (cur && cur.status !== "running") await ctx.sessions.close(cur.id).catch(() => {});
  return { id: { id: sess.id, fresh: true }, changed: false, hash: h };
}

/**
 * The page's own log (_log.ts, before 2026-11-12) to a file the secretary can read when asked about that time: the
 * new conversation starts without it, so its first message isn't a week of pasted talk. Once.
 */
function migrateLog(ctx: Ctx) {
  if (ctx.fs.stat(HISTORY)) return;
  const past = windowText(ctx, Infinity);
  if (past) ctx.fs.write(HISTORY, `# 秘书页上以前的聊天（2026-11-12 以前，面板自己存的那份）\n\n${past}\n`);
}

/**
 * Compacts the secretary's conversation (schedules/compact.json; DESIGN.md「秘书」「一个会话，靠压缩」): only once
 * it has sat idle an hour (its prompt cache is gone, so this costs what its next message would anyway) and its context
 * holds compactTokens or more (设置); compactTokens 0 = by time: whenever this runs and something was said since the
 * last time. What to keep is the user's prose (流程 → compact.md). { force?: true — now, whatever the size and idle time }
 */
export async function compactMain(ctx: Ctx, input?: { force?: boolean }) {
  const s = state(ctx);
  const m = s.main ? ctx.sessions.get(s.main) : null;
  if (!m) return "没有秘书的对话";
  if (m.status !== "idle") return `秘书正在${m.status === "running" ? "忙" : "等人"}，下次再看`;
  const force = !!input?.force;
  if (!force && Date.now() - m.updatedAt < COLD) return "一小时内说过话，先不压缩（提示缓存还在）";
  const limit = workflow(ctx).compactTokens;
  const used = (m as any).context?.tokens as number | undefined;
  if (!force) {
    if (limit > 0 && !(used && used >= limit)) return `上下文 ${used ?? "?"} token，不到 ${limit}，不压缩`;
    if (limit === 0 && s.compactedAt && m.updatedAt <= s.compactedAt) return "上次压缩之后没聊过，不压缩";
  }
  const how = textOf(ctx, COMPACT).replace(/^#.*\n+/, "").trim();
  await ctx.sessions.send(m.id, `/compact ${how}`.trim());
  updateState(ctx, (x) => void (x.compactedAt = Date.now()));
  return `已压缩秘书的对话（压缩前 ${used ?? "?"} token）`;
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
    if (k === "secret") return `    要用户交一个密钥（${t.handBack.label ?? t.handBack.name ?? ""}）：不能经过对话，请他在任务面板上 ${t.id} 那里填`;
    return t.steps ? `    要用户亲手做：${t.steps.replace(/\n/g, "\n    ")}\n    他说做完了 → tasks.complete ${ex({ id: t.id })}` : "";
  }
  return t.question ? `    worker 问：${t.question} → tasks.answer ${ex({ id: t.id, answer: "用户的回答" })}` : "";
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

/** One outside message as the fold line of the chat: "[消息 c21] slack-me · 林刚：好，等我看个线上问题". */
function eventLine(it: Item) {
  const e = it.event;
  return `[消息 ${it.id}] ${e.source}${who(e) ? ` · ${who(e)}` : ""}：${cut(e.text || e.title || "", 40)}`;
}

/** A one-line cut, for fold lines. */
function cut(text: string, n: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return [...t].length > n ? [...t].slice(0, n).join("") + "…" : t;
}

function eventBlock(it: Item, tasks: Task[]) {
  const e = it.event;
  const related = tasks.filter((t) => follows(t).some((x) => x.source === e.source && x.key === e.key));
  // Who and where only by name: the ids (user, conversation) are the board's to match, the secretary decides by item.
  // No list of recent tasks any more (2026-11-12): it hung under every message, a dozen lines under a one-line "ok";
  // the secretary looks tasks up when a message is about one (dispatch: attach / stop)
  return [
    `[消息 ${it.id}]${it.inferred ? "（不是找你的：只按主动工作的规则判断）" : ""} ${e.source}/${e.kind}${who(e) ? ` · ${who(e)}` : ""}`,
    e.context?.length ? `这段对话之前说的（「用户本人」是用户自己说的，判断这条是在回什么）：\n${contextLines(e)}\n\n这一条：` : "",
    e.text || e.title || "",
    e.files?.length ? `附件：\n${e.files.map((f) => `- ${f.name}：${f.path}`).join("\n")}` : "",
    it.handBacks?.length ? `负责它的 worker 交回了：\n${it.handBacks.map((h) => `- ${h.task}：${h.reason}`).join("\n")}` : "",
    related.length ? `这个对话里的任务：${related.map((t) => `${t.id}「${t.title}」(${t.status})`).join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A board task with no repository: to the main session to pick one. Marked routing once it's sent. */
export async function routeTask(ctx: Ctx, id: string) {
  const agents = await allAgents(ctx);
  const t = find(loadTasks(ctx).store, id);
  const main = await toMain(ctx, [taskBlock(t, agents)], "route", undefined, false); // the user's own task, as they wrote it
  return updateTasks(ctx, (s) => Object.assign(find(s, id), { routing: Date.now(), router: main, routerClosed: undefined, updatedAt: Date.now() }));
}

/**
 * The user's feedback on how a card was handed out, to the main session to rearrange it (superagent.ts boardTask,
 * reroute). The block (the card's workers, what they said, the feedback) is built by tasks.reroute.
 */
export async function rerouteTask(ctx: Ctx, id: string, block: string) {
  const main = await toMain(ctx, [block], "route", undefined, false); // the user's feedback
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
    "route",
    undefined,
    items.length === 1 ? eventLine(items[0]) : `${items.length} 条外面来的消息：${items.map((it) => eventLine(it)).join("；")}`,
  );
  updateState(ctx, (x) => {
    for (const id of ids) Object.assign(findItem(x, id), { state: "pending", sentAt: Date.now(), reason: undefined, dismissed: undefined });
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
  // The task stops following that conversation: what's said there next goes to the secretary first again, until it
  // attaches something to this task again (thread or DM alike: some chats have no threads)
  const ev = it.event;
  if (ev.key) {
    updateTasks(ctx, (st) => {
      const t = st.tasks.find((x) => x.id === task);
      if (t) t.threads = threadsOf(t).filter((x) => !(x.source === ev.source && x.key === ev.key));
    });
    tasks = loadTasks(ctx).store.tasks;
  }
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
