// The board's panel tools: what a worker (a session the board started) calls to report on and change its task, from
// inside a turn. Gerdr serves them to the worker over MCP; ctx.caller.session says which conversation called, so the
// task is looked up, never taken from the input. Same rules as the old ```gerdr-task``` block (_apply.ts), plus what a
// block couldn't do: take back a human step the user no longer needs to do, and answer with ids.

import { applyBlock } from "./_apply";
import { find, load, note, update, type Store, type Task } from "./_store";
import { handBack } from "./_main";

const STEP = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short imperative (在浏览器里授权 meegle 登录飞书项目) or, for a decision, the question" },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Makes it a decision: the choices, each a short line with its trade-off. The user picks one (or writes their own) on the board, maybe days later; you get their answer as a message.",
    },
    steps: {
      type: "string",
      description:
        "Markdown the user reads without your chat: numbered steps, direct links, codes, values to paste. Something to look at before deciding (a screenshot, sample videos) goes in as ![](/absolute/path): the board and the chat show the image / play the video right there.",
    },
    handBack: {
      type: "object",
      description: "What the user gives back when done. kind none (just mark done) / value (a non-secret value) / secret (stored as a panel secret named name, never shown to anyone; only panel functions can read it through ctx.secrets.get, not you or the code you write). A key your own code / commands need (an API key, a test password): kind none, and the steps say which file to put it in (a git-ignored one like .env, with its absolute path) and under what name; never ask for it in the chat",
      properties: { kind: { type: "string", enum: ["none", "value", "secret"] }, label: { type: "string" }, name: { type: "string" } },
    },
    verify: { type: "string", description: "How you will check it once the user says it's done" },
    minutes: { type: "number", description: "Roughly how long it takes the user" },
    expires: { type: "number", description: "Minutes until what you ask stops working (a sign-in link, a device code)" },
  },
  required: ["title"],
};

export const tools = {
  task_update: {
    description:
      "Report where your board task stands. Call it when that changes, not every turn. state: working (still at it; just update summary / links), done (finished, nothing for the user to judge), delivering (your change is out and waits on a process: give mr, the MR URL; a watcher then follows it and sends you review comments and failed pipelines), review (the result is for the user to judge: findings, a report). To have the user decide something, don't use this: ask with your own ask-question tool, which shows them a card and puts the task under needs-you until they answer. links are artifacts (MR, docs, pipelines): they're kept, so add new ones only.",
    input: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["working", "done", "delivering", "review"] },
        summary: { type: "string", description: "Where it stands in 1-3 sentences, for the board card" },
        links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["url"] } },
        mr: { type: "string", description: "With delivering: the MR URL" },
      },
      required: ["state"],
    },
  },
  ask_human: {
    description:
      "Put something on the user's board that needs them: a step only they can do (sign in, approve, an account, a secret: give steps), or a decision (give options). They work from the board and may come back to it days later, so after asking, finish your turn with what you could do; don't wait in the chat. You get their answer / 'done' as a message. Decisions and values you ask while earlier ones are still unanswered go in one board item (the user answers them in one sitting): ask each as you find it, and you get all the answers together in one message once every one is answered. Take back ones that became moot with cancel_human. A session you started yourself that asks a question (Gerdr reports it to you) is asking you, not the user: answer what you can with gerdr session send; use ask_human only for what's the user's call, with the options and your recommendation, then send their answer on. (Only when the user is talking with you in this chat right now, a quick question can use your own ask-question tool instead.)",
    input: STEP,
  },
  cancel_human: {
    description:
      "Take back a step you asked the user for with ask_human: they answered it in the chat already, you found another way, or it's superseded. It leaves their board with your reason.",
    input: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"] },
  },
  hand_back: {
    description:
      "Give back a message that reached your task from its conversation (a Slack thread, a DM) but isn't for it: it asks for something beyond your task, or is about another one. The Superagent then decides what it is (a new task, another task's, nothing). Don't answer it yourself. event: the message id given with it.",
    input: { type: "object", properties: { event: { type: "string" }, reason: { type: "string", description: "Why it isn't this task's, in a sentence" } }, required: ["event", "reason"] },
  },
  my_task: {
    description: "Your board task as the board sees it: status, summary, artifacts, and the human steps you asked for (open or done, with what was handed back).",
    input: { type: "object", properties: {} },
  },
};

/** The task whose worker is the calling conversation. */
function mine(s: Store, ctx: Ctx): Task {
  const who = ctx.caller.session;
  const t = who && s.tasks.find((x) => x.owner === "agent" && (x.session === who || x.sessions?.includes(who)));
  if (!t) throw new Error("这个对话不是看板上任何任务的 worker（只有看板派出去的会话能用这些工具）");
  return t;
}

export function task_update(input: { state: string; summary?: string; links?: { label?: string; url: string }[]; mr?: string }, ctx: Ctx) {
  const sess = ctx.caller.session ? ctx.sessions.get(ctx.caller.session) : null;
  return update(ctx, (s) => {
    const t = mine(s, ctx);
    if (t.status === "done" || t.status === "dropped") throw new Error(`${t.id} 已经${t.status === "done" ? "完成" : "放弃"}了`);
    let state = input.state === "working" ? undefined : input.state;
    // Answering the user's own question in the chat: they read it there; don't move the task to "come and look"
    if (state === "review" && sess?.byPerson && t.status === "running") state = undefined;
    applyBlock(s, t, { ...input, state });
    Object.assign(t, { viaTools: true, synced: undefined, reportedAt: Date.now(), nudges: 0, updatedAt: Date.now() });
    return { id: t.id, status: t.status, column: t.question ? "等你" : t.status };
  });
}

export function ask_human(input: any, ctx: Ctx) {
  return update(ctx, (s) => {
    const t = mine(s, ctx);
    const decision = Array.isArray(input.options) && input.options.length > 0;
    const human = decision ? { ...input, steps: input.steps ?? "", handBack: { kind: "choice", options: input.options.map(String), label: "你的决定" } } : input;
    const h = applyBlock(s, t, { state: "blocked", human, replace: false })!;
    Object.assign(t, { viaTools: true, reportedAt: Date.now(), nudges: 0, updatedAt: Date.now() });
    if (h.handBack?.kind === "questions") return questionCard(h, ctx);
    if (decision) h.urgent = false; // a decision can wait: no warning mark, it just sits under 等你
    // gerdrCard: Gerdr draws this result as a card in the chat, so the user sees the step where they are too
    const back = h.handBack?.kind === "secret" ? `\n\n做完要交回：密钥「${h.handBack.label || h.handBack.name}」（在看板上存，不经过对话）` : h.handBack?.kind === "value" ? `\n\n做完要交回：${h.handBack.label || "一个值"}` : "";
    const left = h.expiresAt ? `（${Math.round((h.expiresAt - Date.now()) / 60000)} 分钟内有效）` : "";
    return {
      id: h.id,
      title: h.title,
      note: "已放到用户看板的「等你」里；做完你会收到消息",
      // ref: the drawer's "跳到 tN" scrolls to this card. choose: answered right in the chat, the same tasks.complete
      // the board calls. A secret isn't: it goes through Gerdr's password box on the board, never the chat.
      // type: drawn by ui/src/cards.tsx (it shows how the step ended once the board has it); the rest is the built-in card
      gerdrCard: decision
        ? {
            type: "task-step",
            ref: h.id,
            project: ctx.workspace.project,
            kicker: `等你决定 · ${h.id} · 不急，在这里选或之后在看板上选`,
            title: h.title,
            body: h.steps || undefined,
            tone: "info",
            choose: { project: ctx.workspace.project, fn: "tasks.complete", input: { id: h.id }, field: "value", options: (h.handBack as any).options, other: true },
          }
        : {
            type: "task-step",
            ref: h.id,
            project: ctx.workspace.project,
            kicker: `要你做 · ${h.id}${left}`,
            title: h.title,
            body: `${h.steps ?? ""}${back}${h.handBack?.kind === "secret" ? `\n\n做完在看板「等你」里的 ${h.id} 上存密钥。` : ""}`,
            tone: "warn",
            choose:
              h.handBack?.kind === "secret"
                ? undefined
                : h.handBack?.kind === "value"
                  ? { project: ctx.workspace.project, fn: "tasks.complete", input: { id: h.id }, field: "value", options: [], other: true }
                  : { project: ctx.workspace.project, fn: "tasks.complete", input: { id: h.id }, field: "value", options: ["做完了"], other: false },
          },
    };
  });
}

export function cancel_human(input: { id: string; reason: string }, ctx: Ctx) {
  return update(ctx, (s) => {
    const t = mine(s, ctx);
    const [hid, qid] = String(input.id).split("#");
    const h = find(s, hid);
    // One question of several (t5#2): only it goes; the item stays for the rest (or goes when nothing is left)
    if (qid && h.questions) {
      if (h.askedBy !== t.id) throw new Error(`${hid} 不是你这个任务要的`);
      const q = h.questions.find((x) => x.id === qid);
      if (!q) throw new Error(`${hid} 没有第 ${qid} 个问题`);
      q.dropped = input.reason || "撤回";
      note(h, `worker 撤回了「${q.title}」：${input.reason}`);
      const left = h.questions.filter((x) => !x.dropped);
      if (!left.length) Object.assign(h, { status: "dropped", doneAt: Date.now() });
      if (!left.length) t.blockedBy = (t.blockedBy ?? []).filter((id) => id !== h.id);
      h.updatedAt = Date.now();
      return { id: input.id, status: "dropped", left: left.filter((x) => !x.answer).map((x) => `${hid}#${x.id}`), gerdrCard: { title: `不用答了：${q.title}`, body: input.reason, tone: "info" } };
    }
    if (h.owner !== "human" || (h.askedBy !== t.id && !t.blockedBy?.includes(h.id))) throw new Error(`${h.id} 不是你这个任务要的人工步骤`);
    if (h.status === "done") throw new Error(`${h.id} 用户已经做完了${h.handedBack ? `（交回：${h.handedBack}）` : ""}`);
    if (h.status !== "dropped") {
      note(h, `worker 撤回了：${input.reason}`);
      Object.assign(h, { status: "dropped", doneAt: Date.now(), updatedAt: Date.now() });
    }
    t.blockedBy = (t.blockedBy ?? []).filter((id) => id !== h.id);
    return { id: h.id, status: "dropped", gerdrCard: { title: `不用做了：${h.id} ${h.title}`, body: input.reason, tone: "info" } };
  });
}

export function my_task(input: unknown, ctx: Ctx) {
  const { store } = load(ctx);
  const t = mine(store, ctx);
  const humans = store.tasks.filter((x) => x.owner === "human" && (x.askedBy === t.id || t.blockedBy?.includes(x.id)));
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    summary: t.summary,
    question: t.question,
    artifacts: t.links ?? [],
    mr: t.delivery?.url,
    humanSteps: humans.map((h) => ({ id: h.id, title: h.title, status: h.status, handedBack: h.handBack?.kind === "secret" ? (h.status === "done" ? `secret ${h.handBack.name} saved` : undefined) : h.handedBack })),
  };
}

export async function hand_back(input: { event: string; reason: string }, ctx: Ctx) {
  const { store } = load(ctx);
  const t = mine(store, ctx);
  if (!input?.reason?.trim()) throw new Error("写一句为什么不是这个任务的事");
  return handBack(ctx, t.id, input.event, input.reason.trim(), store.tasks);
}

/**
 * The chat card for the question just asked (one of an item's several, "t5#2"): answered in place through
 * tasks.answerQuestion, like the board. ref is the question, so the drawer's jump and the card's state are per question.
 */
function questionCard(h: Task, ctx: Ctx) {
  const qs = (h.questions ?? []).filter((x) => !x.dropped);
  const q = qs[qs.length - 1];
  const ref = `${h.id}#${q.id}`;
  const of = qs.length > 1 ? ` · 第 ${qs.length} 个问题` : "";
  const choice = q.kind === "choice";
  return {
    id: ref,
    note: qs.length > 1 ? `和你前面问的 ${qs.length - 1} 个放在同一个看板事项 ${h.id} 里；用户都答完，你会一次收到全部答案` : `已放到用户看板的「等你」里（${h.id}）；再问的会并进同一项，都答完你一次收到全部答案`,
    gerdrCard: {
      type: "task-step",
      ref,
      project: ctx.workspace.project,
      kicker: `${choice ? "等你决定" : "要你给"} · ${h.id}${of} · 不急，在这里答或之后在看板上答`,
      title: q.title,
      body: [q.steps, !choice && q.label ? `要交回：${q.label}` : ""].filter(Boolean).join("\n\n") || undefined,
      tone: "info",
      choose: { project: ctx.workspace.project, fn: "tasks.answerQuestion", input: { id: h.id, q: q.id }, field: "value", options: q.options ?? [], other: true },
    },
  };
}
