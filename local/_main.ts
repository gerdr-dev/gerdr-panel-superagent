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
// what it sends with its message tool (board.ts message_user → secretaryMessage, _log.ts), as a worker's feed lines; a turn
// the user waited on that sent nothing gets one reminder (settle). It replaced a
// one-off router per task and the panel's own chat on the right. Every event is logged with where it went
// (user/data/superagent.json items), so "what happened to that message" always has an answer.

import { workflow } from "./_config";
import { forRouter } from "./memory";
import { allAgents } from "./_agents";
import { textOf } from "./playbooks";
import { DATA, migrate } from "./_user";
import { activity, find, load as loadTasks, note, update as updateTasks, type Task } from "./_store";
import { wake } from "./_wake";
import { append, windowText, SECRETARY as SECRETARY_ID } from "./_log";
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

/** Why the secretary is having a turn: the user's words, a briefing (both owe the user a message), its own news, routing. */
export type Why = "user" | "brief" | "notice" | "route";

type State = {
  main?: string;
  /** The tasks the last stuck check reported (secretary.checkStuck): told as "still stuck" next time. */
  stuck?: string[];
  mains: string[];
  brief?: string;
  handled: number;
  next: number;
  items: Item[];
  /**
   * Messages sent since its last turn ended: what the turn is for (the strongest reason wins), for the page's "busy"
   * and for the one reminder when a turn the user (or a briefing) waited on ends without a message to them.
   */
  awaiting?: { why: Why; /** when the last message went in */ sent: number; /** reminded once already */ nudged?: boolean };
  /** When it last sent the user a message (its message tool): a turn that sent one needs no reminder. */
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
  if (!st) return { s: { mains: [], handled: 0, next: 1, items: [] } };
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
      `跟着它们，替用户记着每一件事，该他知道、该他拍板的时候告诉他。要派的活也都先到你这里：用户交给你的、看板上建的任务，和外面来的消息（私信、@、告警……）。`,
    talkText(ctx),
    // How it judges is the user's prose (流程 → my-workflow/references/dispatch.md), theirs to read and change; only the
    // command and the facts below are the code's
    textOf(ctx, DISPATCH) || `判断规则（用户的 dispatch.md）不见了：只分派，不自己动手、不等待；拿不准就问用户。`,
    `## 外面来的消息 [消息 cN]：一条命令给出这一批的决定\n` +
      `gerdr panel run superagent.decide '${ex({ decisions: [{ item: "c3", decision: "accept", title: "十几个字的标题", parts: [{ repo: "/绝对路径" }] }, { item: "c4", decision: "ignore", reason: "道谢" }] })}'\n\n` +
      `- attach：${ex({ item: "c5", decision: "attach", task: "t9" })}；stop：${ex({ item: "c6", decision: "stop", task: "t9", reason: "…" })}\n` +
      (workflow(ctx).inboxWork === "review"
        ? `- decide 的 accept 会替你建任务，但**不派出去**：放进看板的「待办」，用户看过、改好再派（他的设置）。parts 照常写，会成为卡片上的仓库和 agent；拆成几份就是几张卡。` +
          `记下这条消息的去向；回不回原对话、什么时候回，按他的设置自动处理，你不用另外回。\n\n`
        : `- decide 会替你建任务、派出去、记下这条消息的去向；回不回原对话按用户的设置自动处理。\n\n`) +
      `## 看板任务 [任务 tN]：用看板的命令（和用户点按钮是同一套）\n` +
      `- 派出去：gerdr panel run tasks.dispatch '${ex({ id: "t12", parts: [{ repo: "/绝对路径" }] })}'（可加 title）\n` +
      `- 它是在管别的任务：停掉 tasks.drop '${ex({ id: "t9", reason: "…" })}'；转告 tasks.say '${ex({ id: "t9", text: "…" })}'；` +
      `接手一个停掉的任务，派的时候加 "from": "t9"，会带上它的进展和对话；tN 只是条指令、照做完了：tasks.edit '${ex({ id: "t12", status: "done", summary: "停了 t9" })}'\n` +
      `- 用户对某张卡的安排有意见（[重新安排 tN]，比如仓库错了）：用 superagent.decide 照反馈重新安排这张卡，item 就是 tN（它要记下这次安排完了没有）。重新派给 parts（新的完整安排：要留下的已有 worker 那份写 "task": "它的 id"，会收到反馈和这份的 prompt；没留下的停掉；没写 task 的开新 worker，第一份接这张卡，其余各是一张新卡）；只是让现在的 worker 自己改，写 "decision": "attach"；整件事不做了，写 "decision": "stop" 和 reason。\n` +
      `\n## parts（decide 的 accept 和 tasks.dispatch 一样）\n` +
      `- parts 每项一份活：repo 必填；agent、model、effort 不写就用下面的默认，简单的活可以给便宜的模型；worktree 默认 false。\n` +
      `- 只有一份：就是这件事本身，不用写 prompt。拆成几份并行（用户 @ 了几个 agent，或者活明显能分开做）：每份写 title（十几个字）和 prompt（这一份做什么、和别的份怎么配合）；同一个仓库有两份以上时都写 "worktree": true。\n` +
      `- 每份都是一张独立的卡、一个 worker。一份要用另一份的结果（前端接后端的新接口）：先派被依赖的那份，另一份用 tasks.add 建好、带 "blockedBy": ["tN"] 和 "start": true：tN 做完时看板会自动派出它，并把 tN 的结果写进它的交代。\n` +
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
      `[检查] 是定时检查发现了卡住的任务；[简报] 是到了写简报的时间。\n` +
      `- **看板是用户自己盯的，你是辅助**：任务的状态变化不会发给你，你也不去盯、不去推进任务。用户问起、或者定时任务（[检查]、[简报]）交给你时，才去看看板。` +
      `用户交代的才做：他让你催、让你转告，你再用下面的命令去做。\n` +
      `- **对用户说话一律用 message_user 工具**（简报带 \`"brief": true\`）：秘书页上只有它发的消息，你回复里的文字和中间过程用户都看不到。` +
      `没有要告诉他的（派活、分拣）就不调用。他问你的、交代你的，每次都要用 message 回一句。\n` +
      `- 用户问到的、你要说的，先查事实再说：\`gerdr panel run secretary.status\` 给出等他的事（带问题的 id 和选项）、在做的、待验收的、最近完成的。` +
      `不要凭记忆说「做完了」。问到某一件事的细节（做到哪、动态里写了什么、开了哪个 MR、它最后说了什么）：` +
      `\`gerdr panel run tasks.list '${ex({ id: "t12" })}'\` 只给这一件（和它的成员），别不带 id 拉整块看板。\n` +
      `- **说到某个任务的结果、方案、结论时，附上 worker 的原话**：message_user 带 \`"quote": "t12"\`，它 worker 最后一轮的回复会原样显示在你的消息下面，` +
      `用户能展开、能直接回它。你只说一句为什么要他看、要他做什么，不要把内容再缩写一遍（缩写会丢掉他要的细节）。\n` +
      `- **用户追问某个任务里的细节**（方案里为什么这样、某个数字哪来的、它具体改了什么）：别凭你看到的摘要答，转给做它的 worker —— ` +
      `\`gerdr panel run tasks.message '${ex({ id: "t12", text: "用户的原话" })}'\`，` +
      `再用 message_user 带 \`"follow": "t12"\` 说一句「问了 t12，它的回答会接在下面」。它的回答会显示在秘书页上，你不用转述。` +
      `跨需求的、要汇总的（哪些在等他、进度、日报）才由你自己答。\n` +
      `- 用户交给你一件事：是活就派（\`tasks.add\` 带 \`"start": true\`，知道去哪个仓库就给 \`repo\`；不知道就按下面「怎么派」挑，挑不出来就先问他再派）；` +
      `他要亲手做的步骤记成人工任务（\`tasks.add\` 带 \`"owner": "human"\`）。派完一句话告诉他交给了谁。\n` +
      `- 替用户回答 worker：问题 \`tasks.answerQuestion ${ex({ id: "t5", q: "1", value: "选项或他的原话" })}\`；` +
      `验收 \`tasks.accept ${ex({ id: "t5" })}\` / 打回 \`tasks.reject ${ex({ id: "t5", feedback: "…" })}\`；` +
      `他做完了自己的步骤 \`tasks.complete ${ex({ id: "t5", value: "要交回的值（没有就不写）" })}\`；` +
      `转告 worker \`tasks.say ${ex({ id: "t5", text: "…" })}\`；不做了 \`tasks.drop ${ex({ id: "t5", reason: "…" })}\`。\n` +
      `- 不要用你自带的提问工具（AskUserQuestion）：有要问用户的，用 message_user 问，他会在秘书页上答你。` +
      `问了就先不派，这一轮到此为止，他的回答会作为 [用户] 消息到来。\n` +
      `- **仓库拿不准就先问，不要先派了再说明**（包括这件事不属于仓库列表里的任何一个）：带上你的建议问他，怎么挑、怎么建议见「怎么派」。\n` +
      `- **要用户回答的问题会作为卡片出现在秘书页的对话里**（secretary.status 里带着问题、选项和交答案的命令）：` +
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

/** Its message to the user (board.ts message_user, called from the secretary's session): a line on the secretary's page. */
export function secretaryMessage(ctx: Ctx, input: { text: string; files?: { path: string; name?: string }[]; brief?: boolean; quote?: { task: string; at: number; text: string }; follow?: string }) {
  const e = append(ctx, {
    kind: input.brief ? "brief" : "message",
    by: SECRETARY_ID,
    text: input.text,
    ...(input.files?.length ? { files: input.files } : {}),
    ...(input.quote ? { quote: input.quote } : {}),
    ...(input.follow ? { follow: input.follow } : {}),
    session: ctx.caller.session || undefined,
  });
  updateState(ctx, (s) => {
    s.messageAt = e.at;
  });
  return e;
}

/**
 * When a turn is over: what the user (or a briefing) waited on got a message, or the secretary is reminded once to send
 * one — its reply text shows nowhere (the user: a reply taken from the turn can't tell which of several messages it
 * answers, when they come in mid-turn; so the secretary says things with its message tool, as a worker reports).
 * Routing and news turns need no message. Called from the page's refreshes and the board's (tasks.list, also on a
 * schedule), so it happens whether or not anyone has the page open.
 */
export async function settle(ctx: Ctx) {
  const s = state(ctx);
  if (!s.main || !s.awaiting) return;
  const m = ctx.sessions.get(s.main);
  if (!m) return;
  // Right after a message went in it can still read idle, before the turn starts: not over until a while has passed
  const over = (m.status === "idle" || m.status === "error") && (m.updatedAt > s.awaiting.sent + 1000 || Date.now() - s.awaiting.sent > 30_000);
  if (!over) return;
  const a = s.awaiting;
  const owed = (a.why === "user" || a.why === "brief") && (s.messageAt ?? 0) < a.sent && !a.nudged && m.status === "idle";
  const go = updateState(ctx, (x) => {
    if (!x.awaiting || x.main !== m.id || x.awaiting.sent !== a.sent) return false;
    x.awaiting = owed ? { ...x.awaiting, sent: Date.now(), nudged: true } : undefined;
    return owed;
  });
  if (go)
    await ctx.sessions
      .send(
        m.id,
        a.why === "brief"
          ? `[看板] 简报还没发给用户：用 message_user 工具发（带 "brief": true）。你回复里的文字他看不到。`
          : `[看板] 用户在等你回话：用 message_user 工具回他。你回复里的文字他看不到。`,
      )
      .catch(() => {});
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
