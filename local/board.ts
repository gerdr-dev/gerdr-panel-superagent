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
    steps: { type: "string", description: "Numbered steps the user can follow without reading your chat: direct links, codes, values to paste" },
    handBack: {
      type: "object",
      description: "What the user gives back when done. kind none (just mark done) / value (a non-secret value) / secret (stored as a panel secret named name, never shown to anyone)",
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
      "Put something on the user's board that needs them: a step only they can do (sign in, approve, an account, a secret: give steps), or a decision (give options). They work from the board and may come back to it days later, so after asking, finish your turn with what you could do; don't wait in the chat. You get their answer / 'done' as a message. Several can be open at once; take back ones that became moot with cancel_human. (Only when the user is talking with you in this chat right now, a quick question can use your own ask-question tool instead.)",
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
    Object.assign(t, { viaTools: true, synced: undefined, updatedAt: Date.now() });
    return { id: t.id, status: t.status, column: t.question ? "等你" : t.status };
  });
}

export function ask_human(input: any, ctx: Ctx) {
  return update(ctx, (s) => {
    const t = mine(s, ctx);
    const decision = Array.isArray(input.options) && input.options.length > 0;
    const human = decision ? { ...input, steps: input.steps ?? "", handBack: { kind: "choice", options: input.options.map(String), label: "你的决定" } } : input;
    const h = applyBlock(s, t, { state: "blocked", human, replace: false })!;
    if (decision) h.urgent = false; // a decision can wait: no warning mark, it just sits under 等你
    Object.assign(t, { viaTools: true, updatedAt: Date.now() });
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
            kicker: `等你决定 · ${h.id} · 不急，在这里选或之后在看板上选`,
            title: h.title,
            body: h.steps || undefined,
            tone: "info",
            choose: { project: ctx.workspace.project, fn: "tasks.complete", input: { id: h.id }, field: "value", options: (h.handBack as any).options, other: true },
          }
        : {
            type: "task-step",
            ref: h.id,
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
    const h = find(s, input.id);
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
