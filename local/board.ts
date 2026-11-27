// The board's panel tools: what a worker (a session the board started) calls from inside a turn to ask the user,
// take an ask back, or talk to the people its task came from. Gerdr serves them to the worker over MCP;
// ctx.caller.session says which conversation called, so the task is looked up, never taken from the input.

import { activity, find, findAsk, load, newAsk, note, openAsks as open_, reqOf, update, type Ask, type Question, type Store, type Task } from "./_store";
import { handBack, isMain, placeOf, state as mainState, threadsOf } from "./_main";
import { workflow } from "./_config";
import { draftLines, hold, pendingFor, withdraw } from "./_outbox";
import { eventCard } from "./_cards";
import { open } from "./_waits";
import { secAsk, secCancel } from "./_secask";
import { GENERAL, MEMORY, nameOf } from "./_memory";
import { skillFile } from "./_user";
import { replyOrigin } from "./assign";
import { agentText, confirmFor, logDone, NOTE, opens, policyFor } from "./_letgo";
import { newFrom } from "./tasks";

const STEP = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short imperative (在浏览器里授权 meegle 登录飞书项目) or, for a decision, the question" },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Makes it a decision: the choices, each a short line with its trade-off. The user picks one (or writes their own) on the board, maybe days later; you get their answer as a message.",
    },
    multi: {
      type: "boolean",
      description: "With options: the user may pick several (ticks them, then submits). Their answer is the picked options, one per line. Say so here, not in the title or steps — without it a click on one option is the answer.",
    },
    steps: {
      type: "string",
      description:
        "Markdown the user reads without your chat: numbered steps, direct links, codes, values to paste. Something to look at before deciding (a screenshot, sample videos, a recording) MUST be written as ![](/absolute/path) — the board and the chat then show the image / play the video right there. A bare path or a [link](path) only shows as text: the user would have to open it themselves.",
    },
    handBack: {
      type: "object",
      description: "What the user gives back when done. kind none (just mark done) / value (a non-secret value) / secret (stored as a panel secret named name, never shown to anyone; only panel functions can read it through ctx.secrets.get, not you or the code you write). A key your own code / commands need (an API key, a test password): kind none, and the steps say which file to put it in (a git-ignored one like .env, with its absolute path) and under what name; never ask for it in the chat",
      properties: { kind: { type: "string", enum: ["none", "value", "secret"] }, label: { type: "string" }, name: { type: "string" } },
    },
    replaces: {
      type: "array",
      items: { type: "string" },
      description:
        "What you asked before that this replaces (ids as my_task / the earlier result give them: a5, or a5#1 for one question of several): taken back with this one, so the user only sees the current question. Use it whenever the situation moved on since you asked (you talked it over with the user, found something out) and the question changed.",
    },
    pick: {
      type: "string",
      description:
        "With options, only when the policy in effect lets you decide (Let it go: the result of an ask_human without it says so, and my_task's letgo): the option you pick yourself. Then nothing is asked: your pick stands, is recorded on the task for the user to see (and overturn) later, and you carry on with it.",
    },
    why: { type: "string", description: "With pick: why this one, in a sentence the user reads later" },
    verify: { type: "string", description: "How you will check it once the user says it's done" },
    minutes: { type: "number", description: "Roughly how long it takes the user" },
    expires: { type: "number", description: "Minutes until what you ask stops working (a sign-in link, a device code)" },
  },
  required: ["title"],
};

export const tools = {
  ask_human: {
    description:
      "Put something on the user's task panel that needs them: a step only they can do (give steps), or a decision (give options). It shows in this chat as a card with everything you put in it (the title, steps / options, what to hand back), answerable right there, and on their task panel: don't write the question or the steps again in your reply — a line on why you're asking is enough. Their answer / 'done' comes to you as a message, maybe days later. Decisions and values asked while earlier ones are unanswered go in one item: you get all the answers together once every one is answered. cancel_human takes one back. The user may also ignore it (an ✕ on the card, usually because it went moot): you're told at the start of your next turn, and nothing waits on it any more. When and how to ask: the superagent-panel skill, references/human.md and task.md. The secretary uses it too, for anything it asks the user (a decision, a confirmation, a value, a step): its question shows as a card in its own chat and lights the 秘书 button until answered or closed.",
    input: STEP,
  },
  cancel_human: {
    description:
      "Take back a step or question you asked the user for with ask_human (a5, or a5#1 for one question of several): they answered it in the chat already, you found another way, or it's moot. It leaves their task panel with your reason. Do it as soon as it's moot — never leave it for the user to answer with \"any is fine\". Asking a changed question instead: ask_human with replaces.",
    input: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"] },
  },
  hand_back: {
    description:
      "Give back a message that reached your task from its conversation (a Slack thread, a DM) but isn't for it: it asks for something beyond your task, or is about another one. The Superagent then decides what it is (a new task, another task's, nothing). Your task also stops following that conversation: what is said there next goes to the Superagent first, and comes back to you only if it gives you something again. Don't answer it yourself. event: the message id given with it.",
    input: { type: "object", properties: { event: { type: "string" }, reason: { type: "string", description: "Why it isn't this task's, in a sentence" } }, required: ["event", "reason"] },
  },
  reply_message: {
    description:
      "Say something to the people in a chat your task follows (a Slack DM or thread it came from): an answer to them, a question, the result. This is the only way to write to them: never send it with another command-line tool or an API. event: the message id you answer (given with each message passed to you); left out, the message the task came from. The applicable Let it go policy decides first. If none covers this repository, use delivery to choose between sending now with the user's explicit authorization and showing them a draft. When it becomes a draft, carry on without waiting for their choice. Not for a task someone asked of the user through another panel (my_task shows requestedBy): that's reply_requester.",
    input: {
      type: "object",
      properties: {
        text: { type: "string", description: "What they read, as you'd write it in that chat (they don't see your conversation)" },
        event: { type: "string", description: "The message you answer; default: the one the task came from" },
        delivery: {
          type: "string",
          enum: ["send", "review"],
          description:
            "Used when no Let it go policy covers this repository. Choose send only if the user explicitly asked you to send this message to this recipient. Choose review to show a draft for the user to send, which is also the default. An applicable policy takes precedence over either value, including its recipients who always require review.",
        },
        replaces: { type: "string", description: "A draft of yours still waiting for the user (o1) that this one replaces: it is taken back" },
      },
      required: ["text"],
    },
  },
  drop_reply: {
    description:
      "Take back a reply_message draft still waiting for the user to send (o1; the ids come with messages passed to you and in my_task's outbox): the conversation moved on and it no longer fits — the user answered there themselves, the other side asked something else, it's already been said. Do it as soon as you see it's moot, so the user never sends an out-of-date reply. Writing a better one instead: reply_message with replaces.",
    input: { type: "object", properties: { id: { type: "string" }, reason: { type: "string", description: "Why, in a few words (用户已经在 Slack 回过了)" } }, required: ["id", "reason"] },
  },
  reply_requester: {
    description:
      "Only for a task someone asked of the user (my_task shows requestedBy): answer whoever asked, through where the task came from (the team panel). deliver false: said to them now (a question for them, how it's going). deliver true: your delivery note — what was done, the result, how to check it — which is NOT sent: it fills the user's 回复并交付 box on their task panel, and they send it after looking at your work (only a person delivers). Write it once your work is done, then end your turn as usual. What you made that they should see (a screenshot, the HTML, a report) goes in the shared folder my_task names (shareDir): only what is there reaches them, at the same path on their computer, so write that path in your note. Never ask the user which channel to report on: this is it.",
    input: {
      type: "object",
      properties: {
        text: { type: "string", description: "Markdown, for the person who asked (they don't see this chat)" },
        deliver: { type: "boolean", description: "true: the delivery note for the user to send; false (default): said to them now" },
      },
      required: ["text"],
    },
  },
  new_task: {
    description:
      "Only when the user tells you to start a new task / a new agent (\"新建一个 agent 交接给他\", \"另开一个任务做 X\"): a new task on their panel, sent out now with your prompt, its own row in their list; the user then talks to it there. What it is for is only what your prompt says (taking this work over, a side job): this task goes on as it is, the user decides about it. Not for help you need while you carry on yourself: that is a subagent or a helper session (task.md). After it, say in your reply which task it is; don't wait for it.",
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Its first message, for someone who hasn't seen your chat: the goal, the background and what's decided (with the user's rules for this work), how far it got, what's next, where things are (files, links, your conversation id for `gerdr session read` when it carries on your work)" },
        title: { type: "string", description: "Its name; default: worked out from the prompt" },
        repo: { type: "string", description: "Absolute path of the repository it works in; default: this task's" },
        agent: { type: "string", description: "An agent id (gerdr session agents) when the user asked for one; default: the user's worker default" },
        model: { type: "string" },
        effort: { type: "string" },
      },
      required: ["prompt"],
    },
  },
  my_task: {
    description: "Your task as the task panel sees it: the brief you were first given (brief), status, summary, artifacts, what you asked the user for (open or done, with what was handed back).",
    input: { type: "object", properties: {} },
  },
};

/**
 * What Gerdr gives a conversation of this panel with these tools (its MCP instructions). Its system prompt keeps it,
 * so a worker still knows which task it is after /clear or compaction; the brief in its first message is gone by then
 * (t31 after /clear went looking for "question features in taskboard", 2026-11-05). "" for a conversation that
 * isn't a task's worker (a helper a worker started).
 */
export function instructions(input: unknown, ctx: Ctx) {
  const who = ctx.caller.session;
  const t = who && load(ctx).store.tasks.find((x) => x.session === who || x.sessions?.includes(who));
  if (!t) return "";
  return (
    `You are the worker of task ${t.id} ("${t.title}") on the user's Superagent task panel. Opening the task there opens ` +
    `this chat: the user reads it here, so say things in your replies as you normally would, results in full. There is ` +
    `nothing to report: when your turn ends and you wait on nothing, the task goes before the user with what you said. ` +
    `Waiting on someone or something: wait_for; something only the user can decide or do: ask_human. How to work on it ` +
    `is their superagent-panel skill, ${skillFile(ctx, "superagent-panel/references/task.md")}: read it before you stop. my_task shows the task as the panel sees it, ` +
    `with the brief your first message gave you (brief): after /clear or a compaction, read it again there instead of guessing what the task was. ` +
    `Your questions and steps for the user have ids (a5, a5#1) for your tools only: the panel doesn't show them, so to ` +
    `the user name the question itself ("套餐商品配置那个问题"), never "卡片 a5" or "a5#1". ` +
    ((ctx as any).repoMemory
      ? `What the user's memory says about this repository is in your system prompt (Repository memory, kept by Gerdr for every ` +
        `session there); what holds for all of them came in your first message, file ${ctx.fs.root}/${MEMORY}/${GENERAL}.md. ` +
        `Add to either with remember `
      : `What the user's memory says about this repository and all of them came in your first message; the files are ` +
        `${ctx.fs.root}/${MEMORY}/${t.repo ? nameOf(t.repo) : "…"}.md and ${GENERAL}.md there — add to them with remember `) +
    `(when: ${skillFile(ctx, "superagent-panel/references/memory.md")}). ` +
    `The user may have a policy in effect (Let it go: policies by the clock, set on their panel) that lets you decide instead of asking ` +
    `and messages may go without them looking first. Before asking them or writing to someone as them, my_task's ` +
    `letgo says what holds right now (absent: nothing is let go, ask as usual); ask_human and reply_message follow it by themselves.` +
    (t.origin?.reply && !t.assigned
      ? ` It came from a chat (${t.origin.source}): to write to the people there, use reply_message, never another ` +
        `tool. If no policy applies, use delivery: send when the user explicitly tells you to send that message to that recipient. Otherwise use review to show a draft and carry on without waiting. An applicable policy takes precedence.`
      : "") +
    (t.assigned
      ? ` ${t.assigned.by ?? "Someone"} asked the user for this task (through ${t.origin?.source ?? "another panel"}): they ` +
        `don't see this chat. Once the work is done, write the delivery note for them with reply_requester (deliver ` +
        `true): the user looks at it and sends it. Questions for them: reply_requester (deliver false). Don't ask the ` +
        `user where to report.` +
        (t.assigned.shareDir
          ? ` What they should see (a screenshot, the page, a report) goes in the shared folder ${t.assigned.shareDir}: ` +
            `copy it or write it there. It is the same path on their computer and is synced to them within seconds; ` +
            `nothing else of yours leaves this computer. Write paths there in your replies and the delivery note.`
          : "")
      : "")
  );
}

/** The task whose worker is the calling conversation. */
export function mine(s: Store, ctx: Ctx): Task {
  const who = ctx.caller.session;
  const t = who && s.tasks.find((x) => x.session === who || x.sessions?.includes(who));
  if (!t) throw new Error("这个对话不是任务面板上任何任务的 worker（只有任务面板派出去的会话能用这些工具）");
  return t;
}

export async function closeSessions(ctx: Ctx, ids: string[]) {
  for (const id of ids) if ((ctx.sessions as any).close) await (ctx.sessions as any).close(id).catch(() => {});
}

/**
 * What ask_human puts on the task: a decision or a value joins the open questions ask (the worker can't go on until
 * the user answered them all: "反正都要我一次性做完了才继续"); a step to do (sign in, a secret) is an ask of its own.
 * Earlier asks stay: the worker takes back what's moot itself (cancel_human, replaces).
 */
function addAsk(s: Store, t: Task, h: any): Ask {
  if (h.handBack?.kind === "choice" || h.handBack?.kind === "value") {
    const q: Omit<Question, "id"> = {
      title: String(h.title || "要你决定"),
      kind: h.handBack.kind,
      options: h.handBack.kind === "choice" ? h.handBack.options : undefined,
      multi: h.handBack.kind === "choice" ? h.handBack.multi : undefined,
      label: h.handBack.kind === "value" ? h.handBack.label : undefined,
      steps: h.steps ? String(h.steps) : undefined,
      // When it was asked: the ask sits in the feed at its newest open question, not where the first one was
      at: Date.now(),
    };
    const open = open_(t).find((x) => x.handBack.kind === "questions");
    if (open) {
      const qs = open.questions ?? [];
      qs.push({ ...q, id: String(qs.length + 1) });
      Object.assign(open, { questions: qs, title: `${t.title}：${qs.filter((x) => !x.dropped).length} 个问题要你定`, updatedAt: Date.now() });
      return open;
    }
    // A decision can wait: it sits under 等你 without a warning mark
    return newAsk(s, t, { title: q.title, handBack: { kind: "questions" }, questions: [{ ...q, id: "1" }], urgent: false });
  }
  return newAsk(s, t, {
    expiresAt: Number(h.expires) > 0 ? Date.now() + Number(h.expires) * 60_000 : undefined,
    title: String(h.title || "人工步骤"),
    steps: h.steps ? String(h.steps) : undefined,
    handBack: h.handBack?.kind ? { kind: h.handBack.kind, name: h.handBack.name, label: h.handBack.label, options: h.handBack.options, multi: h.handBack.multi } : { kind: "none" },
    verify: h.verify ? String(h.verify) : undefined,
    minutes: Number(h.minutes) || undefined,
    urgent: true, // it's holding up a worker
  });
}

/** What ask_human tells the worker about the card it made: the user sees it whole, so the reply needn't repeat it. */
const SHOWN = "这一项已经作为卡片显示在这个对话里，内容和你写的一样，用户能直接在卡片上答：回复里不要再把问题、步骤写一遍，一句话说为什么要问就够了。";

export function ask_human(input: any, ctx: Ctx) {
  // The secretary has no task: its questions are its own (_secask.ts), counted on the 秘书 button
  if (isMain(ctx, ctx.caller.session)) return secAsk(input, ctx);
  return update(ctx, (s) => {
    const t = mine(s, ctx);
    // What this one replaces goes first: a question changed since is asked anew, not left beside the old one
    const replaced = (Array.isArray(input.replaces) ? input.replaces : input.replaces ? [input.replaces] : []).map(String);
    for (const id of replaced) takeBack(s, t, id, "换成了新的问题");
    input = { ...input, replaces: undefined };
    const decision = Array.isArray(input.options) && input.options.length > 0;
    // Let it go (decide): the worker's own pick stands and is recorded; nobody is asked
    if (decision && opens(ctx, "decide", t.repo)) return decideAlone(s, t, input, ctx);
    const human = decision ? { ...input, steps: input.steps ?? "", handBack: { kind: "choice", options: input.options.map(String), multi: input.multi === true || undefined, label: "你的决定" } } : input;
    const reviewed = t.status === "review";
    const h = addAsk(s, t, human);
    // Asked right after reporting a result to look at: the result wasn't the end, the choice is. Its feed line stops
    // saying "等你看" (t52, 2026-11-05)
    const root = reqOf(s, t);
    const last = root?.activity?.[root.activity.length - 1];
    if (reviewed && last?.kind === "review" && last.by === t.id) Object.assign(last, { kind: "progress", text: last.text.replace(/^有结论了，等你看：?/, "") || "有结论了" });
    Object.assign(t, { reportedAt: Date.now(), nudges: 0, updatedAt: Date.now() });
    if (h.handBack.kind === "questions") {
      // Joined an ask that still has earlier questions open: say which, so the moot ones are taken back now
      const earlier = (h.questions ?? []).filter((q) => !q.dropped && q.answer == null).slice(0, -1);
      const card = { ...questionCard(h, ctx), note: SHOWN };
      return earlier.length
        ? { ...card, stillOpen: earlier.map((q) => `${h.id}#${q.id}「${q.title}」`), note: `这个问题和还没答的 ${earlier.map((q) => `${h.id}#${q.id}`).join("、")} 在一起等用户。哪个已经不用答了，现在就 cancel_human 它` }
        : card;
    }
    if (decision) h.urgent = false; // a decision can wait: no warning mark, it just sits under 等你
    // gerdrCard: Gerdr draws this result as a card in the chat, so the user sees the step where they are too
    const back = h.handBack.kind === "secret" ? `\n\n做完要交回：密钥「${h.handBack.label || h.handBack.name}」（点对话标题栏上的「等你」里这一项存，不经过对话）` : h.handBack.kind === "value" ? `\n\n做完要交回：${h.handBack.label || "一个值"}` : "";
    const left = h.expiresAt ? `（${Math.round((h.expiresAt - Date.now()) / 60000)} 分钟内有效）` : "";
    return {
      id: h.id,
      title: h.title,
      note: `已放到用户任务面板的「等你」里；做完你会收到消息。${SHOWN}`,
      // ref: the drawer's jump scrolls to this card. choose: answered right in the chat, the same tasks.complete the
      // board calls. A secret isn't: it goes through Gerdr's password box on the board, never the chat.
      // type: drawn by ui/src/cards.tsx (it shows how the step ended once the board has it); the rest is the built-in card
      gerdrCard: decision
        ? {
            type: "task-step",
            ref: h.id,
            project: ctx.workspace.project,
            // One word on every card that needs the person, 等你 (2026-11-24): it was 等你决定 / 要你给 / 要你做 by the kind
            // of thing asked, which the title and the controls under it already say, plus 「不急，之后在任务面板上选也行」
            // on every card, which was noise
            kicker: `等你`,
            title: h.title,
            body: h.steps || undefined,
            tone: "info",
            choose: { project: ctx.workspace.project, fn: "tasks.complete", input: { id: h.id }, field: "value", options: h.handBack.options, multi: h.handBack.multi, other: true },
          }
        : {
            type: "task-step",
            ref: h.id,
            project: ctx.workspace.project,
            kicker: `等你${left}`,
            title: h.title,
            body: `${h.steps ?? ""}${back}${h.handBack.kind === "secret" ? `\n\n做完点对话标题栏上的「等你」里这一项，在弹出的框里存密钥。` : ""}`,
            tone: "warn",
            choose:
              h.handBack.kind === "secret"
                ? undefined
                : h.handBack.kind === "value"
                  ? { project: ctx.workspace.project, fn: "tasks.complete", input: { id: h.id }, field: "value", options: [], other: true }
                  : { project: ctx.workspace.project, fn: "tasks.complete", input: { id: h.id }, field: "value", options: ["做完了"], other: false },
          },
    };
  });
}

/**
 * ask_human with options while the policy in effect opens `decide` for the task's repository: no card. Without a pick the worker is told
 * to choose (by the user's note) and call again with it; with one, it's recorded on the task (decided) and in the feed,
 * shown in the chat as a card the user reads later, and the worker carries on.
 */
function decideAlone(s: Store, t: Task, input: any, ctx: Ctx) {
  const title = String(input.title || "要定的事");
  const options: string[] = input.options.map(String);
  const pick = String(input.pick ?? "").trim();
  if (!pick)
    return {
      asked: false,
      note:
        `用户当前的策略让你自己拍板：这个问题不问他。照策略的说明（my_task 的 letgo；怎么用见 ${skillFile(ctx, NOTE)}）自己从选项里挑你会推荐的那个，` +
        `再调一次 ask_human，原样带上 title 和 options，加上 pick（你选的）和 why（一句理由）：会记在任务上，用户回来能看到、能推翻。然后照你选的接着做。`,
    };
  const why = String(input.why ?? "").trim() || undefined;
  t.decided = [...(t.decided ?? []), { title, options, pick, why, at: Date.now() }];
  note(t, `按策略替用户定了「${title}」：${pick}${why ? `（${why}）` : ""}`);
  activity(s, t, { kind: "progress", by: t.id, text: `按策略替你定了「${title}」：${pick}${why ? `（${why}）` : ""}` });
  t.updatedAt = Date.now();
  logDone(ctx, { kind: "decided", task: t.id, text: `${title}：${pick}` });
  return {
    asked: false,
    note: "记下了，用户回来会看到。照你选的接着做；回复里一句话带过就行。",
    gerdrCard: eventCard(ctx, t.id, "decided", `${title}：${pick}`, { body: [why, `可选的：${options.join(" / ")}`].filter(Boolean).join("\n") }),
  };
}

export function cancel_human(input: { id: string; reason: string }, ctx: Ctx) {
  if (isMain(ctx, ctx.caller.session)) return secCancel(input, ctx);
  return update(ctx, (s) => takeBack(s, mine(s, ctx), String(input.id), input.reason));
}

/** Takes back a step or one question (a5#2) that t asked the user: off their board, a line in the feed. */
function takeBack(s: Store, t: Task, id: string, reason: string) {
  const { t: by, a: h, q: qid } = findAsk(s, id);
  if (by.id !== t.id) throw new Error(`${id} 不是你这个任务问的`);
  // One question of several (a5#2): only it goes; the ask stays for the rest (or goes when nothing is left)
  if (qid && h.questions) {
    const q = h.questions.find((x) => x.id === qid);
    if (!q) throw new Error(`${h.id} 没有第 ${qid} 个问题`);
    if (q.answer != null) throw new Error(`${id} 用户已经答了：${q.answer}`);
    q.dropped = reason || "撤回";
    note(t, `worker 撤回了「${q.title}」：${reason}`);
    activity(s, t, { kind: "join", by: t.id, text: `撤回了要你决定的「${q.title}」${reason ? `：${reason}` : ""}` });
    const left = h.questions.filter((x) => !x.dropped);
    if (!left.length) Object.assign(h, { status: "dropped", doneAt: Date.now() });
    h.updatedAt = Date.now();
    // The rest were answered already (held until all were): this was the last one open, so the answers are the
    // caller's now, in this result — it is the worker, mid-turn
    const answered = left.length > 0 && left.every((x) => x.answer != null);
    if (answered) {
      const sum = left.map((x) => `${x.title}：${x.answer}`).join("；");
      Object.assign(h, { status: "done", handedBack: sum, doneAt: Date.now() });
      for (const x of left) x.sent = true;
      activity(s, t, { kind: "user", by: t.id, of: h.id, text: `你答了 ${left.length} 个问题：${sum}` });
    }
    return {
      id,
      status: "dropped",
      left: left.filter((x) => !x.answer).map((x) => `${h.id}#${x.id}`),
      ...(answered ? { answers: left.map((x) => ({ id: `${h.id}#${x.id}`, title: x.title, answer: x.answer })), note: "其余的问题用户都答了，答案在 answers 里：照这些接着做" } : {}),
      gerdrCard: takenBack(`${h.id}#${q.id}`, q.title, reason),
    };
  }
  if (h.status === "done") throw new Error(`${h.id} 用户已经做完了${h.handedBack ? `（交回：${h.handedBack}）` : ""}`);
  if (h.status !== "dropped") {
    note(t, `worker 撤回了「${h.title}」：${reason}`);
    Object.assign(h, { status: "dropped", doneAt: Date.now(), updatedAt: Date.now(), dropReason: reason });
    // Said in the feed: the item leaving 等你 with no word was all the user saw (t55, 2026-11-05)
    activity(s, t, { kind: "join", by: t.id, text: `撤回了要你做的「${h.title}」${reason ? `：${reason}` : ""}` });
  }
  return { id: h.id, status: "dropped", gerdrCard: takenBack(h.id, h.title, reason) };
}

/**
 * The chat's record of a step / question taken back: one quiet line (ui/src/cards.tsx "task-taken-back"), not a card
 * shaped like a new ask — it read as one more thing to do, next to the ask's own card already saying 已撤回.
 */
function takenBack(id: string, title: string, reason: string) {
  return { type: "task-taken-back", ref: `${id}:taken-back`, title: `撤回了「${title}」`, body: reason || undefined, tone: "info" };
}

/** What t still asks the user, each with when it was asked: whole steps (a5) and open questions (a5#2). */
export function openAsks(t: Task) {
  const out: { id: string; title: string; at: number }[] = [];
  for (const h of open_(t)) {
    if (h.questions) for (const q of h.questions) if (!q.dropped && q.answer == null) out.push({ id: `${h.id}#${q.id}`, title: q.title, at: q.at ?? h.createdAt });
    if (!h.questions) out.push({ id: h.id, title: h.title, at: h.createdAt });
  }
  return out;
}

/**
 * The asks t made before the user last talked to it (in the drawer or its chat): the talk may have settled or changed
 * them, and workers kept leaving them for the user to answer "随便选一个" (t63, 2026-11-05). Said back on its next
 * report, so it takes them back or asks again. "" when there are none.
 */
export function staleAsks(s: Store, t: Task) {
  const root = reqOf(s, t);
  const said = Math.max(0, ...(root?.activity ?? []).filter((a) => a.kind === "user" && a.by === t.id).map((a) => a.at));
  const old = openAsks(t).filter((a) => a.at < said);
  if (!old.length) return "";
  return (
    `你还在问用户 ${old.map((a) => `${a.id}「${a.title}」`).join("、")}，是在你们后来的对话之前问的。` +
    `还要问、问法也没变就不用管；不用答了就 cancel_human（说原因）；问题变了就 ask_human 带 replaces 重新问。别让用户去答一个已经过时的问题。`
  );
}

/** Told with each question: its id is for the tools, the board doesn't show it. */
const noIds = "编号只给工具用，任务面板上不显示：跟用户提起时说问题本身，别写 aN / aN#1。";

export function my_task(input: unknown, ctx: Ctx) {
  const { store } = load(ctx);
  const t = mine(store, ctx);
  const humans = t.asks ?? [];
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    summary: t.summary,
    // What its first message said: /clear or a compaction takes that message away, and the system prompt only names
    // the task (t210, 2026-11-23: the user asked whether a cleared worker could carry on). The chat since may have
    // changed it; the latest words win.
    brief: briefOf(t),
    ...(t.assigned ? { requestedBy: t.assigned.by ?? t.origin?.source, requestState: t.assigned.state, deliveryDraft: t.assigned.draft, shareDir: t.assigned.shareDir } : {}),
    // id: what cancel_wait / wait_for replaces take (one wait_for's items share what and since)
    waits: open(t).map((w) => ({ id: w.id, kind: w.kind, what: w.what, since: new Date(w.since).toISOString() })),
    artifacts: t.links ?? [],
    // The ids are for the tools: the board shows questions without them (2026-11-16), and a worker that wrote
    // "都在卡片 t124 上，t124#1" made the user decode them
    ...(humans.length ? { note: "asks 的 id 只给工具用，任务面板上不显示：跟用户说时用问题本身，别写 a5 / a5#1。" } : {}),
    asks: humans.map((h) => ({
      id: h.id,
      title: h.title,
      status: h.status,
      handedBack: h.handBack.kind === "secret" ? (h.status === "done" ? `secret ${h.handBack.name} saved` : undefined) : h.handedBack,
      ...(h.questions ? { questions: h.questions.filter((q) => !q.dropped).map((q) => ({ id: `${h.id}#${q.id}`, title: q.title, answer: q.answer })) } : {}),
    })),
    // Let it go: what the policy in effect lets this worker do without the user (it changes by the clock, so asked here, not told once)
    ...((lg) => (lg ? { letgo: lg } : {}))(agentText(ctx, "worker", t.repo)),
    // Its reply_message drafts still waiting for the user: drop_reply takes back the ones gone moot
    ...((t.outbox ?? []).some((o) => o.state === "pending")
      ? { outbox: (t.outbox ?? []).filter((o) => o.state === "pending").map((o) => ({ id: o.id, to: o.where, text: o.text, at: new Date(o.at).toISOString() })) }
      : {}),
  };
}

/** The task's brief as its worker was first sent it, the user's whole request when the prompt is a part of it. */
function briefOf(t: Task) {
  const b: Record<string, unknown> = {};
  if (t.prompt?.trim()) b.prompt = t.prompt.trim();
  if (t.request?.trim() && t.request.trim() !== t.prompt?.trim()) b.request = t.request.trim();
  if (t.remark?.trim()) b.remark = t.remark.trim();
  if (t.attachments?.length) b.attachments = t.attachments.map((a) => a.path);
  if (!Object.keys(b).length) return undefined;
  b.note = "派活时的原话；之后在对话里改过的，以后来的为准。";
  return b;
}

export async function new_task(input: { prompt: string; title?: string; repo?: string; agent?: string; model?: string; effort?: string }, ctx: Ctx) {
  const t = mine(load(ctx).store, ctx);
  const n = await newFrom({ ...input, id: t.id }, ctx);
  return { task: n.id, title: n.title, session: n.session, note: `${n.id} 已经派出去了。在回复里告诉用户是哪个任务，不用等它。` };
}

export async function hand_back(input: { event: string; reason: string }, ctx: Ctx) {
  const { store } = load(ctx);
  const t = mine(store, ctx);
  if (!input?.reason?.trim()) throw new Error("写一句为什么不是这个任务的事");
  const r = await handBack(ctx, t.id, input.event, input.reason.trim(), store.tasks);
  return { ...r, gerdrCard: eventCard(ctx, t.id, "handBack", input.reason.trim()) };
}

/**
 * The chat card for the question just asked (one of an item's several, "t5#2"): answered in place through
 * tasks.answerQuestion, like the board. ref is the question, so the drawer's jump and the card's state are per question.
 */
function questionCard(h: Ask, ctx: Ctx) {
  const qs = (h.questions ?? []).filter((x) => !x.dropped);
  const q = qs[qs.length - 1];
  const ref = `${h.id}#${q.id}`;
  const choice = q.kind === "choice";
  return {
    id: ref,
    note: qs.length > 1 ? `和你前面问的 ${qs.length - 1} 个放在同一项 ${h.id} 里；用户都答完，你会一次收到全部答案。${noIds}` : `已放到用户任务面板的「等你」里（${h.id}）；再问的会并进同一项，都答完你一次收到全部答案。${noIds}`,
    gerdrCard: {
      type: "task-step",
      ref,
      project: ctx.workspace.project,
      kicker: `等你`,
      title: q.title,
      body: [q.steps, !choice && q.label ? `要交回：${q.label}` : ""].filter(Boolean).join("\n\n") || undefined,
      tone: "info",
      choose: { project: ctx.workspace.project, fn: "tasks.answerQuestion", input: { id: h.id, q: q.id }, field: "value", options: q.options ?? [], multi: q.multi, other: true },
    },
  };
}

/**
 * The worker answers whoever asked for its task (assign.ts): said now, or (deliver) its delivery note, kept on the
 * task for the user to send with 回复并交付 — only a person delivers.
 */
export async function reply_requester(input: { text: string; deliver?: boolean }, ctx: Ctx) {
  const t = mine(load(ctx).store, ctx);
  if (!t.assigned || !t.origin?.reply) throw new Error(`${t.id} 不是别人请用户做的任务：结论写在回复里就行`);
  const text = input.text?.trim();
  if (!text) throw new Error("text 不能为空");
  if (input.deliver && t.assigned.unattended) {
    // 无人值守: nobody here to look first — it goes to whoever asked, who accepts or returns it
    if (t.assigned.state !== "agreed") throw new Error(`${t.id} 已经交付过了：要补充就 deliver false 说给对方`);
    await replyOrigin({ id: t.id, text, deliver: true }, ctx);
    return `无人值守：已经交付给 ${t.assigned.by ?? "对方"}，等对方验收；打回的话你会收到消息。`;
  }
  if (input.deliver) {
    if (t.assigned.state !== "agreed") throw new Error(t.assigned.state === "ask" ? "用户还没同意做这件事" : `${t.id} 已经交付过了：要补充就 deliver false 说给对方`);
    update(ctx, (s) => {
      const x = find(s, t.id);
      x.assigned = { ...x.assigned!, draft: text };
      x.updatedAt = Date.now();
    });
    return `交付说明写好了，在用户的「回复并交付」框里等他看过再发；他改了或打回，你会收到消息。`;
  }
  await replyOrigin({ id: t.id, text, byAgent: t.agent || "agent" }, ctx);
  return `已发给 ${t.assigned.by ?? "对方"}。`;
}

/**
 * The active policy for the repository decides how to deliver a reply. Without one, the worker can send a message
 * explicitly authorized by the user, or leave a draft.
 */
export async function reply_message(input: { text: string; event?: string; replaces?: string; delivery?: "send" | "review" }, ctx: Ctx) {
  const t = mine(load(ctx).store, ctx);
  if (t.assigned) throw new Error(`${t.id} 是别人通过另一个面板请用户做的任务：回发起人用 reply_requester`);
  const text = input?.text?.trim();
  if (!text) throw new Error("text 不能为空");
  if (input.delivery !== undefined && input.delivery !== "send" && input.delivery !== "review")
    throw new Error("delivery 必须是 send 或 review");
  const to = replyTarget(ctx, t, input.event?.trim());
  const where = placeOf(to);
  const ev = (ctx as any).events;
  if (!ev?.reply) throw new Error("这个 Gerdr 还没有事件功能：升级 Gerdr 后再用");
  const msg = { id: to.id, source: to.source, kind: to.kind, key: to.key, actor: to.actor, title: to.title, url: to.url, reply: to.reply };
  // Taken back first: whether this one goes at once or waits, the old draft must not be sent after it
  const replaced = input.replaces?.trim();
  if (replaced) withdraw(ctx, t.id, replaced, "换成了新写的");
  const policy = policyFor(ctx, t.repo);
  const kept = confirmFor(policy, to);
  const policySends = policy?.gates.includes("message");
  const send = policySends ?? (input.delivery === "send");
  if (!kept && send) {
    ev.reply(msg, text);
    if (policySends) logDone(ctx, { kind: "sent", task: t.id, text: `${where}：${text}` });
    update(ctx, (s) => {
      const x = find(s, t.id);
      note(x, `发给了 ${where}：${text}`);
      x.updatedAt = Date.now();
    });
    return { note: `已发给 ${where}。`, gerdrCard: eventCard(ctx, t.id, "reply", `${where}：${text}`) };
  }
  const o = hold(ctx, t.id, text, msg, where);
  // Earlier drafts to the same conversation still waiting: the user would see two answers to one question (t202)
  const others = pendingFor(find(load(ctx).store, t.id), msg).filter((x) => x.id !== o.id);
  return {
    note:
      (kept ? `当前策略里「${kept}」仍要用户过目，所以这条没直接发。` : "") +
      "交给用户过目了：他决定发不发，你不会收到结果。不用等、不用问，接着做你的事；这段话也不用在回复里再写一遍。" +
      (others.length ? `\n同一段对话里你还有没发的草稿：\n${draftLines(others)}\n被这条取代或已经过时的，现在就 drop_reply 撤掉。` : ""),
    gerdrCard: { type: "task-outgoing", ref: `${t.id}~${o.id}`, project: ctx.workspace.project, task: t.id, where, text },
  };
}

/** The worker takes back a draft of its own still waiting for the user (_outbox.ts withdraw). */
export function drop_reply(input: { id: string; reason: string }, ctx: Ctx) {
  const t = mine(load(ctx).store, ctx);
  const id = input?.id?.trim().replace(/^.*~/, "");
  const reason = input?.reason?.trim();
  if (!id) throw new Error("id 不能为空（草稿的编号，比如 o1）");
  if (!reason) throw new Error("reason 不能为空");
  const o = withdraw(ctx, t.id, id, reason);
  return `撤回了要发给 ${o.where} 的草稿 ${id}。`;
}

/** The message a reply answers: the one named (from a conversation the task follows), else the one it came from. */
function replyTarget(ctx: Ctx, t: Task, id?: string) {
  const items = mainState(ctx).items;
  const known = (eid: string) => items.filter((x) => x.event.id === eid).pop()?.event;
  if (id) {
    const e = known(id);
    if (!e) throw new Error(`没有消息 ${id}（看给你的消息里写的消息 id）`);
    if (!e.reply) throw new Error(`消息 ${id} 没有可以回的地方`);
    if (e.key && !threadsOf(t).some((x) => x.source === e.source && x.key === e.key) && e.id !== t.origin?.id)
      throw new Error(`消息 ${id} 不在你这个任务跟着的对话里`);
    return e;
  }
  if (!t.origin?.reply) throw new Error(`${t.id} 不是从一段对话来的，没有可以回的人：结论写在回复里就行`);
  return known(t.origin.id) ?? { ...t.origin, who: undefined as string | undefined, actor: undefined as string | undefined };
}
