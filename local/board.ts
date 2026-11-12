// The board's panel tools: what a worker (a session the board started) calls to report on and change its task, from
// inside a turn. Gerdr serves them to the worker over MCP; ctx.caller.session says which conversation called, so the
// task is looked up, never taken from the input. Same rules as the old ```gerdr-task``` block (_apply.ts), plus what a
// block couldn't do: take back a human step the user no longer needs to do, and answer with ids.

import { applyBlock } from "./_apply";
import { activity, find, load, note, reqOf, splitRef, update, type Store, type Task } from "./_store";
import { handBack, isMain } from "./_main";
import { waitCard } from "./waits";
import { eventCard } from "./_cards";
import { endWaits, isOutside, open, question } from "./_waits";
import { GENERAL, MEMORY, nameOf } from "./_memory";
import { skillFile } from "./_user";
import { replyOrigin } from "./assign";

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
  // task_update was taken out on 2026-11-12: the card's line is the reply's first paragraph, links are in the reply.
  // A worker started before that and still calling it gets "no such tool" and says it in its reply instead
  ask_human: {
    description:
      "Put something on the user's task panel that needs them: a step only they can do (give steps), or a decision (give options). Their answer / 'done' comes to you as a message, maybe days later. Decisions and values asked while earlier ones are unanswered go in one item: you get all the answers together once every one is answered. cancel_human takes one back. When and how to ask: the my-workflow skill, references/human.md and task.md.",
    input: STEP,
  },
  cancel_human: {
    description:
      "Take back a step or question you asked the user for with ask_human (t5, or t5#1 for one question of several): they answered it in the chat already, you found another way, or it's moot. It leaves their task panel with your reason. Do it as soon as it's moot — never leave it for the user to answer with \"any is fine\". Asking a changed question instead: ask_human with replaces.",
    input: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"] },
  },
  hand_back: {
    description:
      "Give back a message that reached your task from its conversation (a Slack thread, a DM) but isn't for it: it asks for something beyond your task, or is about another one. The Superagent then decides what it is (a new task, another task's, nothing). Don't answer it yourself. event: the message id given with it.",
    input: { type: "object", properties: { event: { type: "string" }, reason: { type: "string", description: "Why it isn't this task's, in a sentence" } }, required: ["event", "reason"] },
  },
  reply_requester: {
    description:
      "Only for a task someone asked of the user (my_task shows requestedBy): answer whoever asked, through where the task came from (the team panel). deliver false: said to them now (a question for them, how it's going). deliver true: your delivery note — what was done, the result, how to check it — which is NOT sent: it fills the user's 回复并交付 box on their task panel, and they send it after looking at your work (only a person delivers). Write it once your work is done, then end your turn as usual. Never ask the user which channel to report on: this is it.",
    input: {
      type: "object",
      properties: {
        text: { type: "string", description: "Markdown, for the person who asked (they don't see this chat)" },
        deliver: { type: "boolean", description: "true: the delivery note for the user to send; false (default): said to them now" },
      },
      required: ["text"],
    },
  },
  my_task: {
    description: "Your task as the task panel sees it: status, summary, artifacts, the human steps you asked for (open or done, with what was handed back).",
    input: { type: "object", properties: {} },
  },
  message_user: {
    description:
      "Not needed: say it in your reply (opening your task on the task panel opens this chat). Kept for workers started before 2026-11-12.",
    input: {
      type: "object",
      properties: {
        text: { type: "string" },
        files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, name: { type: "string" } }, required: ["path"] }, description: "Files that go with it (absolute paths)" },
      },
      required: ["text"],
    },
  },
  // The old name, kept so a worker started before the two were one (2026-11-10) doesn't fail mid-turn: drop it once
  // none of those is left
  post_progress: {
    description: "Old name of message_user: use message_user.",
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
  return (
    `You are the worker of task ${t.id} ("${t.title}") on the user's Superagent task panel. Opening the task there opens ` +
    `this chat: the user reads it here, so say things in your replies as you normally would, results in full. There is ` +
    `nothing to report: when your turn ends and you wait on nothing, the task goes before the user with what you said. ` +
    `Waiting on someone or something: wait_for; something only the user can decide or do: ask_human. How to work on it ` +
    `is their my-workflow skill, ${skillFile(ctx, "my-workflow/references/task.md")}: read it before you stop. my_task shows the task as the panel sees it. ` +
    `What the user's memory says about this repository and all of them came in your first message; the files are ` +
    `${ctx.fs.root}/${MEMORY}/${t.repo ? nameOf(t.repo) : "…"}.md and ${GENERAL}.md there — add to them with remember ` +
    `(when: ${skillFile(ctx, "my-workflow/references/memory.md")}).` +
    (t.assigned
      ? ` ${t.assigned.by ?? "Someone"} asked the user for this task (through ${t.origin?.source ?? "another panel"}): they ` +
        `don't see this chat. Once the work is done, write the delivery note for them with reply_requester (deliver ` +
        `true): the user looks at it and sends it. Questions for them: reply_requester (deliver false). Don't ask the ` +
        `user where to report.`
      : "")
  );
}

/** The task whose worker is the calling conversation. */
export function mine(s: Store, ctx: Ctx): Task {
  const who = ctx.caller.session;
  const t = who && s.tasks.find((x) => x.owner === "agent" && (x.session === who || x.sessions?.includes(who)));
  if (!t) throw new Error("这个对话不是任务面板上任何任务的 worker（只有任务面板派出去的会话能用这些工具）");
  return t;
}

export async function task_update(input: { state: string; summary?: string; links?: { label?: string; url: string }[]; mr?: string }, ctx: Ctx) {
  const sess = ctx.caller.session ? ctx.sessions.get(ctx.caller.session) : null;
  const out = update(ctx, (s) => {
    const t = mine(s, ctx);
    if (t.status === "done" || t.status === "dropped") throw new Error(`${t.id} 已经${t.status === "done" ? "完成" : "放弃"}了`);
    // Only the user says a task is done (DESIGN.md「只有用户能标完成」): a worker's "done" (older workers, habit) is review
    let state = input.state === "working" ? undefined : input.state === "done" ? "review" : input.state;
    // "Come and look" while the user still has to choose something of yours reads as two different asks (t52: a review
    // line "有结论了，等你看" next to the choice it was really waiting on). The choice is what's next.
    const asking = s.tasks.filter((h) => h.owner === "human" && h.status === "todo" && (h.askedBy === t.id || t.blockedBy?.includes(h.id)));
    if (state === "review" && asking.length)
      throw new Error(`你还有要用户决定 / 做的 ${asking.map((h) => h.id).join("、")}：等他答了再报验收（答案会发给你）。只是说进展就用 working 或 message_user`);
    if (state === "review" && input.summary && questionsIn(input.summary))
      throw new Error(
        `summary 里有要用户回答的问题：写在结论里他没法答，也容易漏。要他定的用 ask_human（每个问题一项，带 options），结论和方案用 message_user 写全；` +
          `等他答完再报验收。如果那些只是陈述、不是问他，改成不带问号的写法再报。`,
      );
    // Answering the user's own question in the chat: they read it there; don't move the task to "come and look"
    if (state === "review" && sess?.byPerson && t.status === "running") state = undefined;
    const before = new Set((t.waits ?? []).map((w) => w.id));
    applyBlock(s, t, { ...input, state });
    // "working" says nothing about what's next: it doesn't reset the reminder count, or a worker that answers each
    // reminder with "still working" and stops would be reminded forever (tasks.ts settled)
    Object.assign(t, { viaTools: true, synced: undefined, reportedAt: Date.now(), updatedAt: Date.now() });
    // A new state is what's next: the reminder count starts over, and a wait_for before it no longer says what it waits on.
    // "delivering" (older workers: an MR out) is a wait_for on the MR (_apply.ts), shown in the chat as wait_for's is
    if (state && state !== "delivering") {
      t.nudges = 0;
      endWaits(t, isOutside, "worker 报了新进展");
    }
    const root = reqOf(s, t);
    if (root && state === "review") activity(s, t, { by: t.id, kind: state, text: `有结论了，等你看${input.summary ? `：${input.summary}` : ""}` });
    const fresh = open(t).filter((w) => isOutside(w) && !before.has(w.id));
    const stale = staleAsks(s, t);
    // One card per call: a wait it just started is what's next, so that one; otherwise what it changed on the card
    const kind = state === "review" ? state : "working";
    const said = input.summary?.trim() || (kind === "review" ? "有结论了，等你看" : "");
    const gerdrCard = fresh.length ? waitCard(ctx, t, fresh) : said || input.links?.length ? eventCard(ctx, t.id, kind, said || "加了链接", { links: input.links }) : undefined;
    return { id: t.id, status: t.status, column: question(t) ? "等你" : t.status, ...(stale ? { reminder: stale } : {}), ...(gerdrCard ? { gerdrCard } : {}) };
  });
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
    const back = h.handBack?.kind === "secret" ? `\n\n做完要交回：密钥「${h.handBack.label || h.handBack.name}」（在任务面板上存，不经过对话）` : h.handBack?.kind === "value" ? `\n\n做完要交回：${h.handBack.label || "一个值"}` : "";
    const left = h.expiresAt ? `（${Math.round((h.expiresAt - Date.now()) / 60000)} 分钟内有效）` : "";
    return {
      id: h.id,
      title: h.title,
      note: "已放到用户任务面板的「等你」里；做完你会收到消息",
      // ref: the drawer's "跳到 tN" scrolls to this card. choose: answered right in the chat, the same tasks.complete
      // the board calls. A secret isn't: it goes through Gerdr's password box on the board, never the chat.
      // type: drawn by ui/src/cards.tsx (it shows how the step ended once the board has it); the rest is the built-in card
      gerdrCard: decision
        ? {
            type: "task-step",
            ref: h.id,
            project: ctx.workspace.project,
            kicker: `等你决定 · ${h.id} · 不急，在这里选或之后在任务面板上选`,
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
            body: `${h.steps ?? ""}${back}${h.handBack?.kind === "secret" ? `\n\n做完在任务面板「等你」里的 ${h.id} 上存密钥。` : ""}`,
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
  const [hid, qid] = splitRef(id);
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
      activity(s, t, { kind: "user", by: t.id, of: h.id, text: `你答了 ${left.length} 个问题：${sum}` });
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
    ...(t.assigned ? { requestedBy: t.assigned.by ?? t.origin?.source, requestState: t.assigned.state, deliveryDraft: t.assigned.draft } : {}),
    question: question(t),
    waits: open(t).map((w) => ({ kind: w.kind, what: w.what, since: w.since })),
    artifacts: t.links ?? [],
    humanSteps: humans.map((h) => ({ id: h.id, title: h.title, status: h.status, handedBack: h.handBack?.kind === "secret" ? (h.status === "done" ? `secret ${h.handBack.name} saved` : undefined) : h.handedBack })),
  };
}

/**
 * A message to the user (DESIGN.md「消息」): the one way an agent says anything to the user — an answer, a result,
 * where things stand — a feed line drawn in its chat too, so the feed stays a part of the chat. The secretary
 * doesn't use it: its chat is the page. Answers the user's words in the feed (asked is cleared). It was two tools until
 * 2026-11-10 (post_progress for progress, this for answers); to the user both were the agent talking, and the agent
 * had to pick one each time.
 */
export function message_user(input: { text: string; files?: { path: string; name?: string }[] }, ctx: Ctx) {
  const text = input?.text?.trim();
  if (!text) throw new Error("text 是空的");
  const files = (input.files ?? []).filter((f) => f?.path);
  // The secretary's page is its chat (2026-11-12): what it writes in its reply is what the user reads
  if (isMain(ctx, ctx.caller.session)) return { ok: false, note: "秘书不用这个工具：用户看的就是你的对话，直接在回复里说。" };
  return update(ctx, (s) => {
    const t = mine(s, ctx);
    activity(s, t, { by: t.id, kind: "message", text, ...(files.length ? { files } : {}) });
    // A question passed on by the secretary stays open: the answer goes to its chat when the turn ends (tasks.ts),
    // with this message in it
    const asked = t.asked?.relay ? { ...t.asked, said: [t.asked.said, text].filter(Boolean).join("\n\n") } : undefined;
    Object.assign(t, { asked, viaTools: true, reportedAt: Date.now() });
    const stale = staleAsks(s, t);
    const gerdrCard = eventCard(ctx, t.id, "message", text);
    return stale ? { ok: true, reminder: stale, gerdrCard } : { ok: true, gerdrCard };
  });
}



/**
 * Questions for the user in a result's summary (t74, 2026-11-11: "要你定的四件事", four questions as prose under
 * review): they get lost there, unanswerable. Two or more question marks outside links and code are counted as that.
 */
function questionsIn(text: string) {
  const plain = text.replace(/`[^`]*`/g, "").replace(/https?:\/\/\S+/g, "");
  return (plain.match(/[?？]/g) ?? []).length >= 2;
}

/** The old name of message_user (see tools). */
export function post_progress(input: { text: string }, ctx: Ctx) {
  return message_user(input, ctx);
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
function questionCard(h: Task, ctx: Ctx) {
  const qs = (h.questions ?? []).filter((x) => !x.dropped);
  const q = qs[qs.length - 1];
  const ref = `${h.id}#${q.id}`;
  const of = qs.length > 1 ? ` · 第 ${qs.length} 个问题` : "";
  const choice = q.kind === "choice";
  return {
    id: ref,
    note: qs.length > 1 ? `和你前面问的 ${qs.length - 1} 个放在同一个任务面板事项 ${h.id} 里；用户都答完，你会一次收到全部答案` : `已放到用户任务面板的「等你」里（${h.id}）；再问的会并进同一项，都答完你一次收到全部答案`,
    gerdrCard: {
      type: "task-step",
      ref,
      project: ctx.workspace.project,
      kicker: `${choice ? "等你决定" : "要你给"} · ${h.id}${of} · 不急，在这里答或之后在任务面板上答`,
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
