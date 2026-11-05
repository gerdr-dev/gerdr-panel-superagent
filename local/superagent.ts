// The Superagent's decisions and its log: what the main session calls (decide) and what the page reads (log,
// retry). How it works is in _main.ts; why, in DESIGN.md「Superagent」.

import { add, dispatch, drop, edit, lastWords, say } from "./tasks";
import { find, load, update, type Task } from "./_store";
import { evaluate, findItem, followUp, mainId, state, updateState, type Item } from "./_main";
import { workflow } from "./_config";

type Part = { repo: string; agent?: string; model?: string; effort?: string; worktree?: boolean; title?: string; prompt?: string };
type Decision = { item: string; decision?: "accept" | "attach" | "stop" | "ignore"; title?: string; parts?: Part[]; team?: boolean; task?: string; reason?: string; reply?: string; rule?: string };

/**
 * The main session's decisions on a batch, in one call: { decisions: [{ item, decision?, title?, parts?, task?,
 * reason?, reply? }] }. A board task (item tN) only needs parts. A message (item cN): accept (with parts) / attach
 * (task) / stop (task, reason) / ignore (reason, reply?). Each is applied on its own; the ones that failed are
 * reported together, so it fixes and resends only those.
 */
export async function decide(input: { decisions: Decision[] }, ctx: Ctx) {
  const ds = input?.decisions;
  if (!Array.isArray(ds) || !ds.length) throw new Error(`decisions 至少一条：{"decisions":[{"item":"t12","parts":[{"repo":"/绝对路径"}]}]}`);
  const done: unknown[] = [];
  const errors: string[] = [];
  for (const d of ds) {
    try {
      done.push(await one(d, ctx));
    } catch (e: any) {
      errors.push(`${d?.item ?? "?"}：${e?.message ?? e}`);
    }
  }
  if (errors.length) throw new Error(`${done.length ? `其余 ${done.length} 条已处理。` : ""}没处理成的（改了只重发这几条）：\n${errors.join("\n")}`);
  return done;
}

async function one(d: Decision, ctx: Ctx) {
  if (/^t\d+$/.test(d?.item ?? "")) return boardTask(d, ctx);
  const it = findItem(state(ctx), d?.item ?? "");
  if (it.state !== "pending" && it.state !== "unavailable") throw new Error(`已经处理过了（${it.state}）`);
  const e = it.event;
  const settle = (patch: Partial<Item>) =>
    updateState(ctx, (s) => Object.assign(findItem(s, it.id), { decidedAt: Date.now(), ...patch }));
  switch (d.decision) {
    case "accept": {
      if (!d.parts?.length) throw new Error("accept 要给 parts");
      if (it.inferred) {
        if (!d.rule?.trim()) throw new Error("这条不是找你的：accept 要写 rule（按主动工作的哪条规则），没有对应的规则就 ignore");
        // Observe mode (dsh's default for proactive work): recorded with what it would have done, not done. 去向
        // shows it; the user can have it done (superagent.run) or switch the mode once the judgements look right.
        if (workflow(ctx).proactive !== "on") {
          settle({ state: "observed", rule: d.rule.trim(), would: { title: d.title, parts: d.parts, team: d.team }, reason: undefined });
          return { item: it.id, observed: true };
        }
      }
      return accept(ctx, it, d.title, d.parts, d.rule?.trim(), d.team);
    }
    case "attach": {
      const t = live(ctx, d.task);
      if (e.key)
        update(ctx, (s) => {
          const x = find(s, t.id);
          const th = x.threads ?? (x.origin?.key ? [{ source: x.origin.source, key: x.origin.key }] : []);
          if (!th.some((y) => y.source === e.source && y.key === e.key)) x.threads = [...th, { source: e.source, key: e.key! }];
        });
      await followUp(ctx, t.id, e);
      settle({ state: "attached", tasks: [t.id], reason: d.reason });
      return { item: it.id, tasks: [t.id] };
    }
    case "stop": {
      const t = live(ctx, d.task);
      if (!d.reason) throw new Error("stop 要写 reason");
      await drop({ id: t.id, reason: `${e.who ?? e.source} 说停：${d.reason}` }, ctx);
      settle({ state: "stopped", tasks: [t.id], reason: d.reason });
      answer(ctx, it, `好，${t.id}「${t.title}」停了。`);
      return { item: it.id, stopped: t.id };
    }
    case "ignore": {
      if (!d.reason) throw new Error("ignore 要写 reason");
      settle({ state: "ignored", reason: d.reason });
      if (d.reply?.trim() && !it.inferred) answer(ctx, it, d.reply.trim());
      return { item: it.id, ignored: true };
    }
    default:
      throw new Error(`decision 是 accept / attach / stop / ignore 之一，不是「${d.decision ?? ""}」`);
  }
}

/**
 * A board task. Usually work to send out (parts). Sometimes the user is steering the board itself in it: "关闭 t11，
 * 新建一个任务来交接", "t9 顺便把 X 也做了". Until 2026-11-05 a board task could only be sent out, so the router,
 * told to stop t11, sent out a worker "to take over t11" and left t11 running (t52). Now, as for a message:
 * - stop (task, reason): that task is dropped. With parts this task is sent out as its handover (told what the dropped
 *   one was doing and where its conversation is); without, this task is done (it was only the instruction).
 * - attach (task): this task's words go to that task's worker; this one is done.
 * No ignore: the user wrote it on their own board, so it's meant; what's unclear is asked, not dropped.
 */
async function boardTask(d: Decision, ctx: Ctx) {
  const self = find(load(ctx).store, d.item);
  if (self.status !== "todo") throw new Error(`${self.id} 已经${self.status === "dropped" ? "放弃了" : "派出去了"}`);
  const send = async () => ((await dispatch({ id: self.id, title: d.title, parts: d.parts!, team: d.team }, ctx)) as Task[]).map((t) => t.id);
  const finish = (summary: string) =>
    edit({ id: self.id, status: "done", routing: undefined, summary, doneAt: Date.now(), ...(d.title ? { title: d.title } : {}) }, ctx);
  switch (d.decision ?? "accept") {
    case "accept":
      if (!d.parts?.length) throw new Error("看板上的任务要派出去就给 parts；它是在停 / 并进别的任务就写 decision: stop / attach 和 task");
      return { item: self.id, tasks: await send() };
    case "stop": {
      const t = other(ctx, self, d.task);
      if (!d.reason) throw new Error("stop 要写 reason");
      const said = lastWords(String((t.session && ctx.sessions.get(t.session)?.reply) ?? ""));
      await drop({ id: t.id, reason: `你在 ${self.id} 里说停：${d.reason}` }, ctx);
      if (!d.parts?.length) {
        finish(`停了 ${t.id}「${t.title}」`);
        return { item: self.id, stopped: t.id };
      }
      edit({ id: self.id, from: t.id, prompt: `${self.prompt ?? self.title}\n\n${handover(t, said)}` }, ctx);
      return { item: self.id, stopped: t.id, tasks: await send() };
    }
    case "attach": {
      const t = other(ctx, self, d.task);
      const files = self.attachments?.length ? `\n附件：\n${self.attachments.map((a) => `- ${a.name}：${a.path}`).join("\n")}` : "";
      const text = `用户在看板上补充（${self.id}）：${self.prompt ?? self.title}${files}`;
      if (t.session) await say({ id: t.id, text }, ctx);
      // Not sent out yet: it becomes part of what its worker is told
      else edit({ id: t.id, prompt: `${t.prompt ?? t.title}\n\n${text}`, attachments: [...(t.attachments ?? []), ...(self.attachments ?? [])] }, ctx);
      finish(`并进了 ${t.id}「${t.title}」`);
      return { item: self.id, tasks: [t.id] };
    }
    default:
      throw new Error(`看板上的任务 decision 是 accept / stop / attach 之一，不是「${d.decision}」`);
  }
}

/** The task a board task acts on: another one, still alive. */
function other(ctx: Ctx, self: Task, id?: string) {
  if (id === self.id) throw new Error(`task 是它要停 / 并进的那个任务，不是 ${self.id} 自己`);
  return live(ctx, id);
}

/** What a handover worker is told about the task it takes over: what it was for, how far it got, where to read more. */
function handover(t: Task, said: string) {
  return [
    `## 交接：接手 ${t.id}「${t.title}」（它已停掉）`,
    `它要做的：${t.request ?? t.prompt ?? t.title}`,
    t.repo && `它的仓库：${t.repo}${t.worktree ? "（在 worktree 里，改动可能还在那个分支上）" : ""}`,
    t.summary && `它最后的进展：${t.summary}`,
    t.links?.length && `它的产物：\n${t.links.map((l) => `- ${l.label}：${l.url}`).join("\n")}`,
    said && `它最后说：${said}`,
    t.session && `它做到哪、试过什么，读它的对话：gerdr session read ${t.session}。先接着它的进度做，别从头再来。`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Accepting an event: a task from it, following its conversation, sent out as the parts say, and "taken" said where
 * it came from. Taken under a proactive rule (nobody asked): the worker is told to stay within that rule, and nobody
 * is told it was taken — no one is waiting for an answer.
 */
async function accept(ctx: Ctx, it: Item, title: string | undefined, parts: Part[], rule?: string, team?: boolean) {
  const e = it.event;
  const settle = (patch: Partial<Item>) => updateState(ctx, (s) => Object.assign(findItem(s, it.id), { decidedAt: Date.now(), ...patch }));
  const text = (e.text ?? "").trim() || e.title || "";
  const from = [e.who && `来自 ${e.who}`, `${e.source}/${e.kind}`].filter(Boolean).join("，");
  const scope = it.inferred && rule ? `\n\n这件事没人找你做，是按主动工作的规则接的：「${rule}」。只做这条规则允许的，超出的用 ask_human 问用户。` : "";
  const t = (await add(
    {
      title: title || firstLine(text) || e.title || `${e.source}/${e.kind}`,
      prompt: `${text}\n\n（${from}${e.url ? `：${e.url}` : ""}）${scope}`,
      attachments: e.files,
      origin: { id: e.id, source: e.source, kind: e.kind, key: e.key, title: e.title, url: e.url, reply: it.inferred ? undefined : e.reply },
      threads: e.key ? [{ source: e.source, key: e.key }] : undefined,
      router: mainId(ctx),
    },
    ctx,
  )) as Task;
  let ids = [t.id];
  try {
    ids = ((await dispatch({ id: t.id, parts, team }, ctx)) as Task[]).map((x) => x.id);
  } catch (err: any) {
    // Accepted all the same: the task is on the board; only sending it out is to redo, as a board task
    settle({ state: "accepted", tasks: ids, rule, reason: undefined });
    throw new Error(`建了任务 ${t.id}，但没派出去：${err?.message ?? err}。改了用 {"item":"${t.id}","parts":[…]} 再派`);
  }
  settle({ state: "accepted", tasks: ids, rule, reason: undefined });
  if (!it.inferred) answer(ctx, it, `收到，建了任务 ${t.id}「${find(load(ctx).store, t.id).title}」，有结果会在这里说。`);
  return { item: it.id, tasks: ids };
}

/** 照做: what the main session would have done with an observed event, done now by the user's say-so. { id } */
export async function execute(input: { id: string }, ctx: Ctx) {
  const it = findItem(state(ctx), input?.id ?? "");
  if (it.state !== "observed" || !it.would) throw new Error(`${it.id} 不是「只记录」下记的（${it.state}）`);
  return accept(ctx, it, it.would.title, it.would.parts as Part[], it.rule, (it.would as any).team);
}

function live(ctx: Ctx, id?: string): Task {
  if (!id) throw new Error("要给 task（tN）");
  const t = find(load(ctx).store, id);
  if (t.status === "dropped") throw new Error(`${id} 已经放弃了`);
  return t;
}

function answer(ctx: Ctx, it: Item, text: string) {
  if (!it.event.reply) return;
  try {
    (ctx as any).events.reply({ ...it.event, at: 0 }, text);
  } catch (err: any) {
    ctx.log(`回复失败：${err?.message ?? err}`);
  }
}

function firstLine(text: string) {
  const line = text.split("\n")[0].trim();
  return [...line].length > 40 ? [...line].slice(0, 40).join("") + "…" : line;
}

/** For the page's 去向: every event and where it went, newest first, and the main session. { limit? } */
export function log(input: { limit?: number }, ctx: Ctx) {
  const s = state(ctx);
  const m = s.main ? ctx.sessions.get(s.main) : null;
  return {
    main: s.main ? { id: s.main, status: m?.status ?? "gone", waiting: m?.waiting, handled: s.handled } : null,
    items: s.items
      .slice(-(input?.limit ?? 200))
      .reverse()
      .map((it) => ({ ...it, event: { ...it.event, text: (it.event.text ?? "").slice(0, 600) } })),
  };
}

/** Sends events to the main session again: { ids } — ignored / filtered / unavailable ones, by a person's say-so. */
export async function retry(input: { ids: string[] }, ctx: Ctx) {
  const ids = input?.ids ?? [];
  const s = state(ctx);
  for (const id of ids) {
    const it = findItem(s, id);
    if (it.state === "accepted" || it.state === "attached" || it.state === "delivered") throw new Error(`${id} 已经交给任务了（${it.tasks?.join("、")}）`);
  }
  await evaluate(ctx, ids, load(ctx).store.tasks);
  return { sent: ids };
}
