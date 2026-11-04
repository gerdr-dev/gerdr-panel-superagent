import { workflow } from "./_config";
import { blockersDone, find, load, newTask, note, update, type Store, type Task } from "./_store";
import { applyBlock } from "./_apply";
import { allAgents, mentionsIn } from "./_agents";
import { fileWith } from "./_vars";

export type { Task };

// Task board data: data/tasks.json (read and written through _store.ts). Agent tasks are handed to coding-agent sessions (workers); human tasks are
// things only the user can do (UI clicks, accounts, approvals). Everything here is deterministic: the page, the
// Work agent (`gerdr work run tasks.<fn> '<json>'`) and worker replies all go through these functions.
//
// Workers report through the board's Work tools (board.ts: task_update, ask_human, cancel_human), which Gerdr gives
// them over MCP. Older workers ended replies with a ```gerdr-task``` JSON block instead; `list` still reads those.

// What a worker is told besides its task: short, since it shows in the chat as part of the first message. How to
// use each tool is in the tools' own descriptions (board.ts), the user's way of working in the Work's skills.
// Old sessions may still end replies with a ```gerdr-task``` block: list() keeps reading those.
export const WORKER_PROTOCOL = `

---
This is task {id} on the user's Work board. They follow it there, not in this chat: report through the "work" tools
(task_update, ask_human, cancel_human), and follow the skills from this Work for how they like things done. When you
need the user to decide something, put it on the board with ask_human and its options, then end your turn: they may
answer days later. Your own ask-question tool only while they're talking with you here.
`;

/** The last ```gerdr-task``` block in a reply, parsed; null when there's none or it isn't JSON. */
function lastBlock(reply: string): any {
  const re = /```gerdr-task\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(reply))) last = m[1];
  if (!last) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}


// ---- called by the page and the Work agent ----

/**
 * Every task with its worker's live state, after applying worker replies not seen yet.
 * `column` is where the board shows it: you (needs the user), review, active, done.
 */
export async function list(input: unknown, ctx: Ctx) {
  const live: Record<string, any> = {};
  const { store } = load(ctx);
  // Read sessions outside the write: ctx.sessions.get is cheap, but keep the locked part small
  for (const t of store.tasks) if (t.session && t.status !== "done" && t.status !== "dropped") live[t.session] = ctx.sessions.get(t.session);
  const s = update(ctx, (s) => {
    for (const t of s.tasks) {
      const sess = t.session && live[t.session];
      // The worker is at it again: the user answered (in its chat, with whatever they attached) or it carried on.
      // What it was asking, or the result waiting for review, is no longer the state of things.
      if (sess?.status === "running" && (t.question || t.status === "review")) {
        if (t.question) note(t, `问：${t.question}\n（在对话里回复了）`);
        Object.assign(t, { question: undefined, status: t.status === "review" ? "running" : t.status, updatedAt: Date.now() });
      }
      if (!sess || (sess.status !== "idle" && sess.status !== "error")) continue;
      if (t.synced === sess.updatedAt) continue;
      t.synced = sess.updatedAt;
      const b = lastBlock(sess.reply ?? "");
      // The user asked it something in its chat and it answered: they're reading that answer and will carry on, so
      // "review" (come and look) means nothing here; the task stays where it is with the new summary. done /
      // delivering / question / blocked still apply: they say something changed or is needed.
      if (b && sess.byPerson && b.state === "review" && t.status === "running") applyBlock(s, t, { ...b, state: undefined });
      else if (b) applyBlock(s, t, b);
      else if (t.status === "running" && sess.status === "idle" && !t.viaTools) t.question = "Worker 停下了，但没在看板上汇报进展：去对话里看看它说了什么，让它接着做，或者直接「标为完成」";
      t.updatedAt = Date.now();
    }
    dropOrphans(s);
    return s;
  });
  await closeRouters(ctx, live);
  return {
    tasks: s.tasks.map((t) => {
      const sess = t.session ? live[t.session] : null;
      return { ...t, live: sess ? { status: sess.status, waiting: sess.waiting, waitingSince: sess.waitingSince, turnStartedAt: sess.turnStartedAt, updatedAt: sess.updatedAt, error: sess.error, title: sess.title } : null, column: column(s, t, sess), ready: blockersDone(s, t) };
    }),
    at: Date.now(),
  };
}

/**
 * A human step made to unblock other tasks is moot once all of those are finished (done or dropped, e.g. the worker
 * found another way): it leaves "needs you" by itself, with why. One the user added that blocks nothing stays.
 */
function dropOrphans(s: Store) {
  const over = (x?: Task) => !x || x.status === "done" || x.status === "dropped";
  for (const h of s.tasks) {
    if (h.owner !== "human" || over(h)) continue;
    const blocks = s.tasks.filter((t) => t.blockedBy?.includes(h.id));
    if (!blocks.length || !blocks.every((t) => over(t))) continue;
    const why = blocks.map((t) => `${t.id} ${t.status === "done" ? "已完成" : "已放弃"}`).join("、");
    note(h, `${why}，这一步不需要了（自动放弃）`);
    Object.assign(h, { status: "dropped", doneAt: Date.now(), updatedAt: Date.now() });
  }
}

function column(s: Store, t: Task, sess: any): "you" | "review" | "active" | "done" {
  if (t.status === "done" || t.status === "dropped") return "done";
  if (t.status === "review") return "review";
  // delivering: running as far as the user is concerned, until the watcher merges it or says it's stuck (question)
  if (t.owner === "human") return blockersDone(s, t) ? "you" : "active";
  if (t.question || sess?.status === "waiting" || sess?.status === "error") return "you";
  return "active";
}

function firstLine(text?: string) {
  const line = (text ?? "").trim().split("\n")[0].trim();
  return [...line].length > 40 ? [...line].slice(0, 40).join("") + "…" : line;
}

/** A new task. { title, owner?, prompt?, repo?, agent?, model?, effort?, steps?, handBack?, verify?, minutes?, blockedBy?, start? } */
export async function add(input: Partial<Task> & { title?: string; start?: boolean }, ctx: Ctx) {
  // No title given (the board only asks what to do): the first line of the prompt / steps, cut short.
  const title = (input?.title || firstLine(input?.prompt) || firstLine(input?.steps) || (input?.attachments?.length ? `看附件：${input.attachments[0].name}` : "")).trim();
  if (!title) throw new Error("任务要写清楚做什么");
  const { start: go, ...rest } = input;
  // @-mentions in the text (the board's input box, the Work agent writing "@design …"): who the router hands it to.
  // One mention and no agent given is simply the agent.
  if (rest.owner !== "human" && !rest.mentions && rest.prompt?.includes("@")) {
    const m = mentionsIn(rest.prompt, await allAgents(ctx));
    if (m.length) rest.mentions = m;
  }
  if (rest.mentions?.length === 1 && !rest.agent) rest.agent = rest.mentions[0];
  const t = update(ctx, (s) => newTask(s, { ...rest, title, id: undefined } as any));
  if (go && t.owner === "agent") return start({ id: t.id }, ctx);
  return t;
}

/** Changes fields of a task: { id, ...fields }. */
export function edit(input: Partial<Task> & { id: string }, ctx: Ctx) {
  return update(ctx, (s) => {
    const t = find(s, input.id);
    const { id, createdAt, ...rest } = input as any;
    Object.assign(t, rest, { updatedAt: Date.now() });
    return t;
  });
}

/**
 * Hands an agent task to a new worker session: in its repository (or a git worktree of it), told the task and the
 * reply protocol, reporting to the Work agent. { id, prompt?, repo?, agent?, model?, effort?, worktree?, mode? }
 * Agent / model / effort not given: the task's, else the user's worker defaults (skills/…/models.md), else Gerdr's.
 */
export async function start(
  input: { id: string; prompt?: string; repo?: string; agent?: string; model?: string; effort?: string; worktree?: boolean; mode?: string },
  ctx: Ctx,
) {
  const { store } = load(ctx);
  const t = find(store, input.id);
  if (t.owner !== "agent") throw new Error(`${t.id} 是人工任务，不能派给 agent`);
  const prompt = (input.prompt ?? t.prompt ?? "").trim();
  let repo = (input.repo ?? t.repo ?? "").trim();
  if (!prompt && !t.attachments?.length) throw new Error(`${t.id} 还没写要 agent 做什么（prompt）`);
  if (!repo) {
    // The user doesn't pick repositories: the Work agent knows the projects and decides. A second start without a repo
    // (the Work agent itself forgetting it) is an error instead of another round trip.
    if (t.routing) throw new Error(`${t.id} 要给 repo（仓库绝对路径）：tasks.start {"id":"${t.id}","repo":"…"}`);
    return route(t.id, prompt, ctx);
  }
  const st = ctx.dirs.stat(repo);
  if (!st?.dir) throw new Error(`仓库目录不存在：${repo}`);
  repo = st.path;
  let cwd = repo;
  if (input.worktree ?? t.worktree) {
    if (!st.git) throw new Error(`${repo} 不是 git 仓库，开不了 worktree`);
    cwd = `${repo}.worktrees/${t.id}`;
    if (!ctx.dirs.stat(cwd)) {
      const r = await ctx.exec("git", ["-C", repo, "worktree", "add", "-b", `task/${t.id}`, cwd], { timeout: 60_000 });
      if (r.code !== 0) throw new Error(`开 worktree 失败：${r.stderr.trim()}`);
    }
  }
  const who = workerOf(ctx, t, input);
  const sess = await ctx.sessions.start({
    cwd,
    ...who,
    mode: input.mode,
    title: t.title,
    prompt: (prompt || "看附件，照里面的做。") + WORKER_PROTOCOL.split("{id}").join(t.id),
    attachments: (t.attachments ?? []).map((a) => a.path),
    tags: { task: t.id },
    // Followed on the board (its drawer shows the chat), not in Code: no tab of it appears there
    workspace: "none",
    // No reportTo: the user follows the board, not the Work agent, and the worker updates the board itself (Work
    // tools). A report would only have the Work agent repeat the worker's reply to nobody, a turn each time.
  });
  return update(ctx, (s) => {
    const x = find(s, t.id);
    Object.assign(x, { status: "running", routing: undefined, prompt, repo, session: sess.id, sessions: [...(x.sessions ?? []), sess.id], question: undefined, updatedAt: Date.now() });
    if (input.agent) x.agent = input.agent;
    if (input.model) x.model = input.model;
    if (input.effort) x.effort = input.effort;
    return x;
  });
}

/**
 * Which agent / model / effort a worker runs on. The defaults in models.md go with its agent: a model named there is
 * that agent's (a claude model means nothing to codex), so a task on another agent only gets a model it names itself.
 */
function workerOf(ctx: Ctx, t: Task, input: { agent?: string; model?: string; effort?: string }) {
  const w = workflow(ctx).worker;
  const agent = input.agent || t.agent || w.agent;
  const same = agent === w.agent;
  return {
    agent: agent || undefined,
    model: input.model || t.model || (same ? w.model : "") || undefined,
    effort: input.effort || t.effort || (same ? w.effort : "") || undefined,
  };
}

async function tell(ctx: Ctx, t: Task, text: string) {
  if (!t.session) throw new Error(`${t.id} 没有在跑的 agent 会话：先派出去（start）`);
  // Right away even mid-step: a worker running something long in the background still takes the message (DESIGN.md)
  await ctx.sessions.send(t.session, text, { now: true });
}

/** The user accepts the result: done, and the worker is parked (its context kept, a later send wakes it). */
export async function accept(input: { id: string }, ctx: Ctx) {
  const t = update(ctx, (s) => {
    const t = find(s, input.id);
    Object.assign(t, { status: "done", question: undefined, doneAt: Date.now(), updatedAt: Date.now() });
    return t;
  });
  if (t.session && (ctx.sessions as any).close) await (ctx.sessions as any).close(t.session).catch(() => {});
  return t;
}

/**
 * Hands a task's MR to the watcher (mrwatch.ts): from now on review comments and failed pipelines go to its worker
 * and it's merged once it can be. { id, mr? } — mr defaults to the task's MR link. For a task that ended in "review"
 * with an MR (before workers reported "delivering"), or one the user opened the MR for by hand. Comments made before
 * now aren't handed over (the worker has seen them, or they predate the hand-over).
 */
export function deliver(input: { id: string; mr?: string }, ctx: Ctx) {
  return update(ctx, (s) => {
    const t = find(s, input.id);
    const url = input.mr ?? (t.links ?? []).map((l) => l.url).find((u) => MR_RE.test(u));
    const m = url ? MR_RE.exec(url) : null;
    if (!m) throw new Error(`${t.id} 没有 MR 链接：给 mr（MR 地址）`);
    if (!t.session) throw new Error(`${t.id} 没有 worker 会话，没人处理 review 意见`);
    if (!(t.links ?? []).some((l) => l.url === m[0])) t.links = [...(t.links ?? []), { label: `MR !${m[3]}`, url: m[0], at: Date.now() }];
    t.delivery = { kind: "mr", url: m[0], project: m[2], iid: Number(m[3]), since: Date.now(), seen: [], rounds: 0 };
    Object.assign(t, { status: "delivering", question: undefined, updatedAt: Date.now() });
    note(t, `交给 mrwatch：等 MR !${m[3]} 合并`);
    return t;
  });
}

const MR_RE = /^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/;

/** Sends it back with what's wrong. { id, feedback } */
export async function reject(input: { id: string; feedback: string }, ctx: Ctx) {
  if (!input.feedback?.trim()) throw new Error("写一句哪里不对");
  const t = update(ctx, (s) => {
    const t = find(s, input.id);
    note(t, `打回：${input.feedback.trim()}`);
    Object.assign(t, { status: "running", updatedAt: Date.now() });
    return t;
  });
  await tell(ctx, t, `验收没通过：${input.feedback.trim()}\n改完用 task_update 汇报。`);
  return t;
}

/** Answers the worker's question. { id, answer } */
export async function answer(input: { id: string; answer: string }, ctx: Ctx) {
  if (!input.answer?.trim()) throw new Error("回答是空的");
  const t = update(ctx, (s) => {
    const t = find(s, input.id);
    note(t, `问：${t.question ?? ""}\n答：${input.answer.trim()}`);
    Object.assign(t, { question: undefined, updatedAt: Date.now() });
    return t;
  });
  await tell(ctx, t, `关于你的问题，用户的决定：${input.answer.trim()}`);
  return t;
}

/**
 * The user did a human task: { id, value? }. Agent tasks it was blocking and that are now free get told (and woken),
 * with what was handed back; a secret is named, never sent.
 */
export async function complete(input: { id: string; value?: string }, ctx: Ctx) {
  let wake: Task[] = [];
  const h = update(ctx, (s) => {
    const h = find(s, input.id);
    if (h.owner !== "human") throw new Error(`${h.id} 不是人工任务`);
    // Answered already (the chat card and the board both can, and a reloaded card no longer knows): never tell the
    // worker twice
    if (h.status === "done") throw new Error(`${h.id} 已经${h.handBack?.kind === "choice" ? "决定" : "做完"}了${h.handedBack ? `：${h.handedBack}` : ""}`);
    if (h.status === "dropped") throw new Error(`${h.id} 已经不需要了`);
    if ((h.handBack?.kind === "value" || h.handBack?.kind === "choice") && !input.value?.trim()) throw new Error(h.handBack.kind === "choice" ? "选一个，或者写下你的决定" : `要交回：${h.handBack.label || "一个值"}`);
    Object.assign(h, { status: "done", handedBack: input.value?.trim() || undefined, doneAt: Date.now(), updatedAt: Date.now() });
    wake = s.tasks.filter((t) => t.owner === "agent" && t.session && t.status === "running" && t.blockedBy?.includes(h.id) && blockersDone(s, t));
    return h;
  });
  let back = "";
  if (h.handBack?.kind === "value") back = `\n交回的${h.handBack.label || "值"}：${h.handedBack}`;
  if (h.handBack?.kind === "choice") {
    for (const t of wake) await tell(ctx, t, `你问的「${h.title}」（${h.id}），用户的决定：${h.handedBack}\n照这个接着做。`);
    return { task: h, woke: wake.map((t) => t.id) };
  }
  if (h.handBack?.kind === "secret") back = `\n密钥已存为 Work secret「${h.handBack.name}」（只有 Work 的本地函数能读，你看不到值）。`;
  for (const t of wake) await tell(ctx, t, `人工任务「${h.title}」（${h.id}）用户做完了。${back}\n先按你说的方式核验${h.verify ? `（${h.verify}）` : ""}，没问题再继续；核验不过就用 ask_human 再登记一个，说明哪里不对。`);
  return { task: h, woke: wake.map((t) => t.id) };
}

/**
 * A human step whose link / code expired: { id } — drop it and ask the worker that needed it for a fresh one (it
 * answers with a new "blocked", which shows up as a new card).
 */
export async function redo(input: { id: string }, ctx: Ctx) {
  const { store } = load(ctx);
  const h = find(store, input.id);
  const t = store.tasks.find((x) => x.id === h.askedBy) ?? store.tasks.find((x) => x.blockedBy?.includes(h.id) && x.session);
  if (!t?.session) throw new Error(`找不到要 ${h.id} 的那个 worker`);
  update(ctx, (s) => {
    const x = find(s, h.id);
    note(x, "过期了，让 worker 重新生成");
    Object.assign(x, { status: "dropped", doneAt: Date.now(), updatedAt: Date.now() });
  });
  await tell(ctx, t, `人工任务「${h.title}」（${h.id}）过期了，用户还没来得及做。重新生成一个（新的链接 / 验证码），再用 ask_human 登记一次。`);
  return { asked: t.id };
}

/** Sends a task's worker a message (it wakes if parked): { id, text }. For the user or the Work agent steering it. */
export async function say(input: { id: string; text: string }, ctx: Ctx) {
  if (!input.text?.trim()) throw new Error("消息是空的");
  const t = find(load(ctx).store, input.id);
  await tell(ctx, t, input.text.trim());
  return { sent: t.id, session: t.session };
}

/** Drops a task (not doing it). { id, reason? } */
export async function drop(input: { id: string; reason?: string }, ctx: Ctx) {
  const t = update(ctx, (s) => {
    const t = find(s, input.id);
    if (input.reason) note(t, `放弃：${input.reason}`);
    Object.assign(t, { status: "dropped", doneAt: Date.now(), updatedAt: Date.now() });
    return t;
  });
  if (t.session && (ctx.sessions as any).close) await (ctx.sessions as any).close(t.session).catch(() => {});
  return t;
}

/**
 * Picks the repository / agent / model for a task the user dispatched without a repository: a one-off conversation in
 * this Work directory, closed once the task is out (list → closeRouters). Not the Work agent's own chat: the user
 * follows the board, and each of these grew that chat by a turn they never read.
 *
 * Speed is the point: everything it decides by is in its first message (the repositories and how the user picks
 * them, the agents and what each is for, the model rules, who was @-mentioned), and one command (tasks.dispatch)
 * sends the task out, split into parallel parts if need be. It used to read README / skills / code first: three
 * rounds of tools, about 10 of its 22 seconds.
 */
async function route(id: string, prompt: string, ctx: Ctx) {
  // Marked as routing only once the conversation started: a failed start leaves it a plain todo to dispatch again
  const t = update(ctx, (s) => Object.assign(find(s, id), { prompt, updatedAt: Date.now() }));
  const r = workflow(ctx).router;
  const agents = await allAgents(ctx);
  const named = (id: string) => {
    const a = agents.find((x) => x.id === id);
    return a && a.name !== a.id ? `${a.name}（${a.id}）` : id;
  };
  const agentLines = agents.map((a) => {
    const about = a.prompt ? `：${oneLine(a.prompt, 160)}` : "";
    return `- ${a.id}（${a.name}${a.base ? `，基于 ${a.base}` : ""}）${about}`;
  });
  const repoText = fileWith(ctx, ["仓库", "repos"]) || `（用户没写仓库列表）最近用过的目录：\n${repos(null, ctx).map((x) => `- ${x.path}`).join("\n")}`;
  const modelText = fileWith(ctx, ["派活 agent", "干活 agent", "router agent", "worker agent"]);
  const mentions = t.mentions ?? [];
  const who = mentions.length
    ? `用户 @ 了：${mentions.map(named).join("、")}。他点名要这些 agent 做：` +
      (mentions.length > 1 ? `通常每个 agent 一份、并行；能合成一份的也可以只派给其中一个。\n` : `就派给它。\n`)
    : t.agent || t.model
      ? `用户指定了 ${[t.agent && `agent「${t.agent}」`, t.model && `模型「${t.model}」`].filter(Boolean).join("、")}，照用。\n`
      : "";
  const ex = JSON.stringify({ id: t.id, parts: [{ repo: "/绝对路径" }] });
  const sess = await ctx.sessions.start({
    cwd: ctx.workspace.dir,
    agent: r.agent || undefined,
    model: r.model || undefined,
    effort: r.effort || undefined,
    title: `派活：${t.id}`,
    prompt: [
      `看板上新派了任务 ${t.id}「${t.title}」。你只负责把它派出去：派完就结束，不用跟用户汇报（用户看看板）。`,
      `派活要的信息下面都给了，**不要再去读 README、skill 或看板代码**，直接用一条命令派出。只有凭这些真定不了仓库时，才去候选仓库里搜一下；还定不了，用你自带的提问工具问用户。`,
      `## 任务\n${prompt}` +
        (t.attachments?.length ? `\n\n附件（派出时自动带给 worker）：\n${t.attachments.map((a) => `- ${a.name}：${a.path}`).join("\n")}` : ""),
      who.trim(),
      `## 可选的 agent\n${agentLines.join("\n")}`,
      `## 仓库（用户自己写的）\n${repoText}`,
      modelText && `## agent 和模型（用户自己写的）\n${modelText}`,
      `## 派出：一条命令\n` +
        `gerdr work run tasks.dispatch '${ex}'\n\n` +
        `- parts 每项一份活：repo 必填；agent、model、effort 不写就用上面的默认，简单的活可以给便宜的模型；worktree 默认 false。\n` +
        `- 只有一份：就是这个任务本身，不用写 prompt。\n` +
        `- 拆成几份并行（用户 @ 了几个 agent，或者活明显能分开做）：每份写 title（十几个字）和 prompt（这一份做什么、和别的份怎么配合）；同一个仓库有两份以上时都写 "worktree": true。\n` +
        `- 标题是从任务内容第一行截的，不够好就在顶层加 "title"。`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  return update(ctx, (s) => Object.assign(find(s, id), { routing: Date.now(), router: sess.id }));
}

function oneLine(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return [...t].length > max ? [...t].slice(0, max).join("") + "…" : t;
}

type Part = { repo: string; agent?: string; model?: string; effort?: string; worktree?: boolean; title?: string; prompt?: string };

/**
 * Sends a task out in one go, as the router decided: { id, title?, parts: [{ repo, agent?, model?, effort?, worktree?,
 * title?, prompt? }] }. One part is the task itself. Several run in parallel: the first stays this task (its title /
 * prompt narrowed to that part), each other one becomes a new task split off it (`from`), with the same attachments.
 */
export async function dispatch(input: { id: string; title?: string; parts: Part[] }, ctx: Ctx) {
  const parts = input?.parts ?? [];
  if (!parts.length) throw new Error(`parts 至少一份：{"id":"${input?.id}","parts":[{"repo":"/绝对路径"}]}`);
  for (const p of parts) {
    if (!p?.repo?.trim()) throw new Error("parts 里每一份都要有 repo（仓库绝对路径）");
    if (!ctx.dirs.stat(p.repo)?.dir) throw new Error(`仓库目录不存在：${p.repo}`);
  }
  const split = parts.length > 1;
  if (split && parts.some((p) => !p.prompt?.trim())) throw new Error("拆成几份时每份都要写 prompt：这一份做什么");
  const { store } = load(ctx);
  const t = find(store, input.id);
  const [first, ...rest] = parts;
  const title = (split ? first.title : undefined) || input.title;
  if (title) edit({ id: t.id, title }, ctx);
  const out: Task[] = [await start({ id: t.id, repo: first.repo, agent: first.agent, model: first.model, effort: first.effort, worktree: first.worktree, prompt: split ? first.prompt : undefined }, ctx)];
  const errors: string[] = [];
  for (const p of rest) {
    try {
      out.push(
        (await add(
          { title: p.title, prompt: p.prompt, repo: p.repo, agent: p.agent, model: p.model, effort: p.effort, worktree: p.worktree, attachments: t.attachments, from: t.id, start: true },
          ctx,
        )) as Task,
      );
    } catch (e: any) {
      errors.push(`${p.title ?? p.repo}：${e?.message ?? e}`);
    }
  }
  if (errors.length) throw new Error(`已派出 ${out.map((x) => x.id).join("、")}；没派出去的：\n${errors.join("\n")}`);
  return out;
}

/** For the board's @-mentions: the agents and roles a task can go to. */
export async function agents(input: unknown, ctx: Ctx) {
  return allAgents(ctx);
}

/** Routing conversations whose task has gone out (or was dropped), now idle: closed, they've done their one job. */
async function closeRouters(ctx: Ctx, live: Record<string, any>) {
  const done = update(ctx, (s) => {
    const out: string[] = [];
    for (const t of s.tasks) {
      if (!t.router || (t.status === "todo" && t.routing)) continue; // still being routed
      const r = live[t.router] ?? ctx.sessions.get(t.router);
      if (r && r.status !== "idle" && r.status !== "error") continue; // still finishing its turn
      out.push(t.router);
      t.router = undefined;
    }
    return out;
  });
  for (const id of done) await ctx.sessions.close(id).catch(() => {});
}

/** Where one task stands, cheaply (the chat's task-step card asks for it): status, and what the user handed back. */
export function status(input: { id: string }, ctx: Ctx) {
  const { store } = load(ctx);
  const t = store.tasks.find((x) => x.id === input.id);
  if (!t) return { status: "missing" };
  const back = t.handBack?.kind === "secret" ? undefined : t.handedBack;
  return { status: t.status, title: t.title, handedBack: back };
}

/**
 * Repositories to pick from: the user's own list (skills/my-workflow/references/repos.md, {{仓库}}), the board's data
 * source, not Code's workspaces. Until they've written one, recently used directories stand in, marked as suggestions.
 */
export function repos(input: unknown, ctx: Ctx) {
  const out: { path: string; name: string; suggested?: boolean }[] = [];
  const seen = new Set<string>();
  const add = (p: string, suggested?: boolean) => {
    if (!p || seen.has(p) || p.includes("/.gerdr/")) return;
    seen.add(p);
    out.push({ path: p, name: p.split("/").pop() || p, ...(suggested ? { suggested } : {}) });
  };
  const mine = workflow(ctx).repos;
  for (const p of mine) add(p);
  if (!mine.length) for (const d of ctx.dirs.recent()) add(d.path, true);
  return out.slice(0, 40);
}
