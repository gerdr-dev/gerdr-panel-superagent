// The board's panel tools: what a worker (a session the board started) calls to report on and change its task, from
// inside a turn. Gerdr serves them to the worker over MCP; ctx.caller.session says which conversation called, so the
// task is looked up, never taken from the input. Same rules as the old ```gerdr-task``` block (_apply.ts), plus what a
// block couldn't do: take back a human step the user no longer needs to do, and answer with ids.

import { applyBlock } from "./_apply";
import { activity, find, load, memberName, members, note, reqOf, teamOf, update, type Store, type Task } from "./_store";
import { handBack } from "./_main";
import { waitCard } from "./waits";
import { endWaits, isOutside, open, question } from "./_waits";
import { wake } from "./_wake";
import { add } from "./tasks";
import { GENERAL, MEMORY, nameOf } from "./_memory";

/**
 * Teammate messages in a row with no part done, nothing for review and no word from the user: past this the members
 * are going round (前端说是后端的问题，后端说是前端的), and tell makes them put it to the user instead.
 */
const BOUNCE_LIMIT = 8;

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
        "What you asked before that this replaces (ids as my_task / the earlier result give them: t5, or t5#1 for one question of several): taken back with this one, so the user only sees the current question. Use it whenever the situation moved on since you asked (you talked it over with the user, found something out) and the question changed.",
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
      "Put where your board task stands on the board. state: working (still at it: summary / links), done (finished, nothing for the user to judge), review (the result is for the user to judge). Only you (or the user) say a task is done: a merged MR or a passed pipeline is news for you, not the end. Waiting on an MR, a colleague or a job: wait_for. links are artifacts (MR, docs, pipelines): kept, so add new ones only. When to report: the my-workflow skill, references/board.md.",
    input: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["working", "done", "review"] },
        summary: { type: "string", description: "Where it stands in 1-3 sentences, for the board card" },
        links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["url"] } },
      },
      required: ["state"],
    },
  },
  ask_human: {
    description:
      "Put something on the user's board that needs them: a step only they can do (give steps), or a decision (give options). Their answer / 'done' comes to you as a message, maybe days later. Decisions and values asked while earlier ones are unanswered go in one board item: you get all the answers together once every one is answered. cancel_human takes one back. When and how to ask: the my-workflow skill, references/human.md and board.md.",
    input: STEP,
  },
  cancel_human: {
    description:
      "Take back a step or question you asked the user for with ask_human (t5, or t5#1 for one question of several): they answered it in the chat already, you found another way, or it's moot. It leaves their board with your reason. Do it as soon as it's moot — never leave it for the user to answer with \"any is fine\". Asking a changed question instead: ask_human with replaces.",
    input: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"] },
  },
  hand_back: {
    description:
      "Give back a message that reached your task from its conversation (a Slack thread, a DM) but isn't for it: it asks for something beyond your task, or is about another one. The Superagent then decides what it is (a new task, another task's, nothing). Don't answer it yourself. event: the message id given with it.",
    input: { type: "object", properties: { event: { type: "string" }, reason: { type: "string", description: "Why it isn't this task's, in a sentence" } }, required: ["event", "reason"] },
  },
  my_task: {
    description: "Your board task as the board sees it: status, summary, artifacts, the human steps you asked for (open or done, with what was handed back), and — when you work with teammates on one requirement — who they are, where they stand and the requirement's recent activity.",
    input: { type: "object", properties: {} },
  },
  add_teammate: {
    description:
      "Bring another agent onto your requirement, working in another repository (the frontend for your backend, say), when your work needs changes there. It becomes a member of the same requirement: one card for the user, and you two talk straight with tell — no one relays. One member per repository: if the repository already has one, tell it instead. Picking the repository: the user's repository list (`gerdr panel run tasks.repos`).",
    input: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Absolute path of the repository it works in" },
        title: { type: "string", description: "Its part in a dozen words (前端：登录页接新接口)" },
        prompt: {
          type: "string",
          description: "What it needs that it can't see from your chat: what to do, what's decided, where the contract is (an API doc / MR link, not its text pasted), what you need back from it.",
        },
        agent: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        worktree: { type: "boolean", description: "A git worktree of its own (only when another member already works in that repository)" },
      },
      required: ["repo", "prompt"],
    },
  },
  tell: {
    description:
      "Tell a teammate (another member of your requirement) something it must know now: your part is ready (with the doc / MR link), what failed when you tried theirs (with the error), a change of plan. It gets it right away, even mid-step (a build it should stop). With summary, a line goes in the requirement's activity for the user. Waiting for its answer: wait_for with {type: teammate}.",
    input: {
      type: "object",
      properties: {
        to: { type: "string", description: "The teammate's task id (my_task lists them)" },
        text: { type: "string", description: "The message, complete: what it needs to act on, links rather than pasted contents" },
        summary: { type: "string", description: "A line for the requirement's activity feed, which the user reads. Only when the user's rules say this message belongs there (the my-workflow skill, references/activity.md); left out, the message stays between you two" },
      },
      required: ["to", "text"],
    },
  },
  post_progress: {
    description:
      "A line in your requirement's activity feed, which the user follows instead of your chat. What deserves a line, and what never does, is the user's own rule: the my-workflow skill, references/activity.md — read it before writing one. Finishing (task_update done / review), asking the user and pulling in a teammate add their own lines; don't repeat them here.",
    input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
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
  const t = who && load(ctx).store.tasks.find((x) => x.owner === "agent" && (x.session === who || x.sessions?.includes(who)));
  if (!t) return "";
  const { store } = load(ctx);
  const root = teamOf(store, t);
  const mates = root ? members(store, root).filter((x) => x.id !== t.id && x.status !== "dropped") : [];
  const team = root
    ? ` You are one member of requirement ${root.id} ("${root.title}")${root.id === t.id ? ", and its lead: you say when the whole of it is done" : `, led by ${memberName(root)}`}. ` +
      `Teammates, each in its own repository: ${mates.map((x) => `${memberName(x)} "${x.title}"`).join("; ") || "none yet"}. ` +
      `Talk to them straight with tell (it reaches them at once), wait for them with wait_for {type: teammate}; ` +
      `the user follows the requirement's activity feed, not your chats — what goes in it is their my-workflow skill, references/activity.md.`
    : "";
  return (
    `You are the worker of task ${t.id} ("${t.title}") on the user's Superagent board. They follow it on the board, not in ` +
    `this chat. How to work on it (reporting with these tools, asking them, starting other agents, teammates) is their my-workflow ` +
    `skill, references/board.md: read it before you report or stop. my_task shows the task as the board sees it. ` +
    `What the user's memory says about this repository and all of them came in your first message; the files are ` +
    `${ctx.fs.root}/${MEMORY}/${t.repo ? nameOf(t.repo) : "…"}.md and ${GENERAL}.md there — add to them with remember ` +
    `(when: references/memory.md).` +
    team
  );
}

/** The task whose worker is the calling conversation. */
export function mine(s: Store, ctx: Ctx): Task {
  const who = ctx.caller.session;
  const t = who && s.tasks.find((x) => x.owner === "agent" && (x.session === who || x.sessions?.includes(who)));
  if (!t) throw new Error("这个对话不是看板上任何任务的 worker（只有看板派出去的会话能用这些工具）");
  return t;
}

export async function task_update(input: { state: string; summary?: string; links?: { label?: string; url: string }[]; mr?: string }, ctx: Ctx) {
  const sess = ctx.caller.session ? ctx.sessions.get(ctx.caller.session) : null;
  let closing: string[] = [];
  const out = update(ctx, (s) => {
    closing = [];
    const t = mine(s, ctx);
    if (t.status === "done" || t.status === "dropped") throw new Error(`${t.id} 已经${t.status === "done" ? "完成" : "放弃"}了`);
    let state = input.state === "working" ? undefined : input.state;
    // "Come and look" while the user still has to choose something of yours reads as two different asks (t52: a review
    // line "有结论了，等你看" next to the choice it was really waiting on). The choice is what's next.
    const asking = s.tasks.filter((h) => h.owner === "human" && h.status === "todo" && (h.askedBy === t.id || t.blockedBy?.includes(h.id)));
    if ((state === "review" || state === "done") && asking.length)
      throw new Error(`你还有要用户决定 / 做的 ${asking.map((h) => h.id).join("、")}：等他答了再报${state === "review" ? "验收" : "完成"}（答案会发给你）。只是说进展就用 working 或 post_progress`);
    // Answering the user's own question in the chat: they read it there; don't move the task to "come and look"
    if (state === "review" && sess?.byPerson && t.status === "running") state = undefined;
    const before = new Set((t.waits ?? []).map((w) => w.id));
    applyBlock(s, t, { ...input, state });
    // "working" says nothing about what's next: it doesn't reset the reminder count, or a worker that answers each
    // reminder with "still working" and stops would be reminded forever (tasks.ts silentStop)
    Object.assign(t, { viaTools: true, synced: undefined, reportedAt: Date.now(), updatedAt: Date.now() });
    // A new state is what's next: the reminder count starts over, and a wait_for before it no longer says what it waits on.
    // "delivering" (older workers: an MR out) is a wait_for on the MR (_apply.ts), shown in the chat as wait_for's is
    if (state && state !== "delivering") {
      t.nudges = 0;
      endWaits(t, isOutside, "worker 报了新进展");
    }
    const root = reqOf(s, t);
    if (root && (state === "done" || state === "review")) {
      const lead = root.id === t.id;
      const alone = !teamOf(s, t);
      activity(s, t, { by: t.id, kind: state, text: `${state === "review" ? "有结论了，等你看" : alone ? "做完了" : lead ? "整个需求做完了" : "这部分做完了"}${input.summary ? `：${input.summary}` : ""}` });
      // The lead says the whole requirement is done: every member's part with it (DESIGN.md「需求和队友」)
      if (lead && state === "done") closing = finishMembers(s, root, "负责人报了整个需求完成");
    }
    const fresh = open(t).filter((w) => isOutside(w) && !before.has(w.id));
    const stale = staleAsks(s, t);
    return { id: t.id, status: t.status, column: question(t) ? "等你" : t.status, ...(stale ? { reminder: stale } : {}), ...(fresh.length ? { gerdrCard: waitCard(ctx, t, fresh) } : {}) };
  });
  await closeSessions(ctx, closing);
  return out;
}

/** Every member of `root` still going is done with it (their sessions to close: returned). */
export function finishMembers(s: Store, root: Task, why: string): string[] {
  const out: string[] = [];
  for (const m of members(s, root)) {
    if (m.id === root.id || m.status === "done" || m.status === "dropped") continue;
    note(m, why);
    Object.assign(m, { status: "done", doneAt: Date.now(), updatedAt: Date.now() });
    if (m.session) out.push(m.session);
  }
  return out;
}

export async function closeSessions(ctx: Ctx, ids: string[]) {
  for (const id of ids) if ((ctx.sessions as any).close) await (ctx.sessions as any).close(id).catch(() => {});
}

export function ask_human(input: any, ctx: Ctx) {
  return update(ctx, (s) => {
    const t = mine(s, ctx);
    // What this one replaces goes first: a question changed since is asked anew, not left beside the old one
    const replaced = (Array.isArray(input.replaces) ? input.replaces : input.replaces ? [input.replaces] : []).map(String);
    for (const id of replaced) takeBack(s, t, id, "换成了新的问题");
    input = { ...input, replaces: undefined };
    const decision = Array.isArray(input.options) && input.options.length > 0;
    const human = decision ? { ...input, steps: input.steps ?? "", handBack: { kind: "choice", options: input.options.map(String), multi: input.multi === true || undefined, label: "你的决定" } } : input;
    const reviewed = t.status === "review";
    const h = applyBlock(s, t, { state: "blocked", human, replace: false })!;
    // Asked right after reporting a result to look at: the result wasn't the end, the choice is. Its feed line stops
    // saying "等你看" (t52, 2026-11-05)
    const root = reqOf(s, t);
    const last = root?.activity?.[root.activity.length - 1];
    if (reviewed && last?.kind === "review" && last.by === t.id) Object.assign(last, { kind: "progress", text: last.text.replace(/^有结论了，等你看：?/, "") || "有结论了" });
    Object.assign(t, { viaTools: true, reportedAt: Date.now(), nudges: 0, updatedAt: Date.now() });
    endWaits(t, isOutside, "worker 改成问你了");
    if (h.handBack?.kind === "questions") {
      // Joined an item that still has earlier questions open: say which, so the moot ones are taken back now
      const earlier = (h.questions ?? []).filter((q) => !q.dropped && q.answer == null).slice(0, -1);
      const card = questionCard(h, ctx);
      return earlier.length
        ? { ...card, stillOpen: earlier.map((q) => `${h.id}#${q.id}「${q.title}」`), note: `这个问题和还没答的 ${earlier.map((q) => `${h.id}#${q.id}`).join("、")} 在一起等用户。哪个已经不用答了，现在就 cancel_human 它` }
        : card;
    }
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
            choose: { project: ctx.workspace.project, fn: "tasks.complete", input: { id: h.id }, field: "value", options: (h.handBack as any).options, multi: h.handBack?.multi, other: true },
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
  return update(ctx, (s) => takeBack(s, mine(s, ctx), String(input.id), input.reason));
}

/** Takes back a step or one question (t5#2) that t asked the user: off their board, a line in the feed. */
function takeBack(s: Store, t: Task, id: string, reason: string) {
  const [hid, qid] = id.split("#");
  const h = find(s, hid);
  // One question of several (t5#2): only it goes; the item stays for the rest (or goes when nothing is left)
  if (qid && h.questions) {
    if (h.askedBy !== t.id) throw new Error(`${hid} 不是你这个任务要的`);
    const q = h.questions.find((x) => x.id === qid);
    if (!q) throw new Error(`${hid} 没有第 ${qid} 个问题`);
    if (q.answer != null) throw new Error(`${id} 用户已经答了：${q.answer}`);
    q.dropped = reason || "撤回";
    note(h, `worker 撤回了「${q.title}」：${reason}`);
    activity(s, t, { kind: "join", by: t.id, text: `撤回了要你决定的「${q.title}」${reason ? `：${reason}` : ""}` });
    const left = h.questions.filter((x) => !x.dropped);
    if (!left.length) Object.assign(h, { status: "dropped", doneAt: Date.now() });
    if (!left.length) t.blockedBy = (t.blockedBy ?? []).filter((x) => x !== h.id);
    h.updatedAt = Date.now();
    // The rest were answered already (held until all were): this was the last one open, so the answers are the
    // caller's now, in this result — it is the worker, mid-turn
    const answered = left.length > 0 && left.every((x) => x.answer != null);
    if (answered) {
      const sum = left.map((x) => `${x.title}：${x.answer}`).join("；");
      Object.assign(h, { status: "done", handedBack: sum, doneAt: Date.now() });
      for (const x of left) x.sent = true;
      t.blockedBy = (t.blockedBy ?? []).filter((x) => x !== h.id);
      activity(s, t, { kind: "user", by: t.id, text: `你答了 ${left.length} 个问题：${sum}` });
    }
    return {
      id,
      status: "dropped",
      left: left.filter((x) => !x.answer).map((x) => `${hid}#${x.id}`),
      ...(answered ? { answers: left.map((x) => ({ id: `${hid}#${x.id}`, title: x.title, answer: x.answer })), note: "其余的问题用户都答了，答案在 answers 里：照这些接着做" } : {}),
      gerdrCard: takenBack(`${hid}#${q.id}`, q.title, reason),
    };
  }
  if (h.owner !== "human" || (h.askedBy !== t.id && !t.blockedBy?.includes(h.id))) throw new Error(`${h.id} 不是你这个任务要的人工步骤`);
  if (h.status === "done") throw new Error(`${h.id} 用户已经做完了${h.handedBack ? `（交回：${h.handedBack}）` : ""}`);
  if (h.status !== "dropped") {
    note(h, `worker 撤回了：${reason}`);
    Object.assign(h, { status: "dropped", doneAt: Date.now(), updatedAt: Date.now(), dropReason: reason });
    // Said in the feed: the item leaving 等你 with no word was all the user saw (t55, 2026-11-05)
    activity(s, t, { kind: "join", by: t.id, text: `撤回了要你做的 ${h.id}「${h.title}」${reason ? `：${reason}` : ""}` });
  }
  t.blockedBy = (t.blockedBy ?? []).filter((x) => x !== h.id);
  return { id: h.id, status: "dropped", gerdrCard: takenBack(h.id, h.title, reason) };
}

/**
 * The chat's record of a step / question taken back: one quiet line (ui/src/cards.tsx "task-taken-back"), not a card
 * shaped like a new ask — it read as one more thing to do, next to the ask's own card already saying 已撤回.
 */
function takenBack(id: string, title: string, reason: string) {
  return { type: "task-taken-back", ref: `${id}:taken-back`, title: `撤回了 ${id}「${title}」`, body: reason || undefined, tone: "info" };
}

/** What t still asks the user, each with when it was asked: whole steps (t5) and open questions (t5#2). */
export function openAsks(s: Store, t: Task) {
  const out: { id: string; title: string; at: number }[] = [];
  for (const h of s.tasks) {
    if (h.owner !== "human" || h.status !== "todo" || (h.askedBy !== t.id && !t.blockedBy?.includes(h.id))) continue;
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
  const old = openAsks(s, t).filter((a) => a.at < said);
  if (!old.length) return "";
  return (
    `你还在问用户 ${old.map((a) => `${a.id}「${a.title}」`).join("、")}，是在你们后来的对话之前问的。` +
    `还要问、问法也没变就不用管；不用答了就 cancel_human（说原因）；问题变了就 ask_human 带 replaces 重新问。别让用户去答一个已经过时的问题。`
  );
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
    question: question(t),
    waits: open(t).map((w) => ({ kind: w.kind, what: w.what, since: w.since })),
    artifacts: t.links ?? [],
    humanSteps: humans.map((h) => ({ id: h.id, title: h.title, status: h.status, handedBack: h.handBack?.kind === "secret" ? (h.status === "done" ? `secret ${h.handBack.name} saved` : undefined) : h.handedBack })),
    ...teamView(store, t),
  };
}

function teamView(s: Store, t: Task) {
  const root = teamOf(s, t);
  if (!root) return {};
  return {
    requirement: { id: root.id, title: root.title, lead: root.id, youAreLead: root.id === t.id },
    teammates: members(s, root)
      .filter((x) => x.id !== t.id)
      .map((x) => ({ id: x.id, title: x.title, repo: x.repo, status: x.status, summary: x.summary, waits: open(x).map((w) => w.what) })),
    activity: (root.activity ?? []).slice(-15).map((a) => ({ at: new Date(a.at).toISOString(), by: a.by, to: a.to, text: a.text })),
  };
}

export async function add_teammate(input: { repo: string; title?: string; prompt: string; agent?: string; model?: string; effort?: string; worktree?: boolean }, ctx: Ctx) {
  const prompt = input?.prompt?.trim();
  if (!prompt) throw new Error("prompt 写清它要做什么、已经定了什么、要交回什么");
  const st = ctx.dirs.stat(input.repo?.trim() ?? "");
  if (!st?.dir) throw new Error(`仓库目录不存在：${input.repo}`);
  const { store } = load(ctx);
  const t = mine(store, ctx);
  const root = teamOf(store, t) ?? t;
  if (root.status === "done" || root.status === "dropped") throw new Error(`需求 ${root.id} 已经结束了`);
  const there = members(store, root).find((x) => x.status !== "done" && x.status !== "dropped" && x.repo && ctx.dirs.stat(x.repo)?.path === st.path);
  if (there && !input.worktree) throw new Error(`${memberName(there)} 已经在这个仓库里做「${there.title}」了：用 tell 告诉它要做什么`);
  const m = (await add(
    {
      title: input.title,
      prompt: `${prompt}\n\n（${memberName(t)} 拉你进需求 ${root.id}「${root.title}」：有事直接 tell 它。）`,
      repo: st.path,
      agent: input.agent,
      model: input.model,
      effort: input.effort,
      worktree: input.worktree,
      team: root.id,
      from: t.id,
      router: root.router,
      routerClosed: true,
      start: true,
    } as any,
    ctx,
  )) as Task;
  update(ctx, (s) => activity(s, find(s, m.id), { by: t.id, to: m.id, kind: "join", text: `拉了 ${memberName(m)} 进来：${m.title}` }));
  return { id: m.id, title: m.title, note: `${m.id} 已经开始做了。它会直接 tell 你；你要等它的结果就 wait_for {"type":"teammate","who":"${m.id}"}，然后结束这一轮。` };
}

export async function tell(input: { to: string; text: string; summary?: string }, ctx: Ctx) {
  const text = input?.text?.trim();
  if (!text) throw new Error("text 是空的");
  const r = update(ctx, (s) => {
    const from = mine(s, ctx);
    const root = teamOf(s, from);
    if (!root) throw new Error("你没有队友：要别的仓库一起做，先用 add_teammate 拉一个进来");
    const ms = members(s, root);
    const to = ms.find((x) => x.id === String(input.to).trim());
    if (!to || to.id === from.id) throw new Error(`${input.to} 不是你的队友（队友：${ms.filter((x) => x.id !== from.id).map(memberName).join("、")}）`);
    if (to.status === "dropped") throw new Error(`${to.id} 已经放弃了`);
    if (root.status === "done" || root.status === "dropped") throw new Error(`需求 ${root.id} 已经结束了`);
    if (!to.session) throw new Error(`${to.id} 还没派出去`);
    // Stopped, with a line in the feed: returned rather than thrown, or the write (and the line) would be undone
    if ((root.bounces ?? 0) >= BOUNCE_LIMIT) {
      const last = root.activity?.[root.activity.length - 1];
      if (last?.kind !== "stuck") activity(s, from, { by: from.id, kind: "stuck", text: `和队友来回了 ${root.bounces} 次还没进展，要交给你定` });
      return { stuck: root.bounces };
    }
    root.bounces = (root.bounces ?? 0) + 1;
    // In the feed only when the member says so (its summary, by the user's activity.md): the talk itself is theirs
    const line = input.summary?.trim();
    if (line) activity(s, from, { by: from.id, to: to.id, kind: "tell", text: line });
    Object.assign(from, { viaTools: true, reportedAt: Date.now() });
    return { from, to };
  });
  if ("stuck" in r)
    throw new Error(
      `你们已经来回了 ${r.stuck} 次，没有一部分做完，也没人问过用户：别再来回了。用 ask_human 把分歧交给用户定：` +
        `两边各自的说法和证据（报错、请求和响应），选项，你的建议。用户答了以后才能再 tell。`,
    );
  const { from, to } = r;
  // Right away, like the user's own words (DESIGN.md): it may be in the middle of something the message stops
  await wake(ctx, to.id, {
    how: `${memberName(from)} 发来消息`,
    text: `[队友 ${memberName(from)}，需求 ${to.team ?? to.id}] ${text}\n\n（回它用 tell，to: "${from.id}"）`,
    ends: isOutside,
    resume: true,
  });
  return { sent: to.id, note: `已送到 ${memberName(to)}。要等它回话：wait_for {"type":"teammate","who":"${to.id}"}，然后结束这一轮。` };
}

export function post_progress(input: { text: string }, ctx: Ctx) {
  const text = input?.text?.trim();
  if (!text) throw new Error("text 是空的");
  return update(ctx, (s) => {
    const t = mine(s, ctx);
    const root = teamOf(s, t) ?? t;
    // A feed, not a log: a member's line a minute after its last one replaces it
    const last = root.activity?.[root.activity.length - 1];
    if (last && last.by === t.id && last.kind === "progress" && Date.now() - last.at < 2 * 60_000) root.activity!.pop();
    activity(s, t, { by: t.id, kind: "progress", text });
    Object.assign(t, { viaTools: true, reportedAt: Date.now() });
    const stale = staleAsks(s, t);
    return stale ? { ok: true, reminder: stale } : { ok: true };
  });
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
      choose: { project: ctx.workspace.project, fn: "tasks.answerQuestion", input: { id: h.id, q: q.id }, field: "value", options: q.options ?? [], multi: q.multi, other: true },
    },
  };
}
