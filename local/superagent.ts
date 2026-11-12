// The Superagent's decisions and its log: what the main session calls (decide) and what the page reads (log,
// retry). How it works is in _main.ts; why, in DESIGN.md「Superagent」.

import { ackOrigin, add, dispatch, drop, edit, lastWords, say, start } from "./tasks";
import { activity, find, load, memberName, members, note, update, type Task } from "./_store";
import { evaluate, findItem, followUp, mainId, state, updateState, type Item } from "./_main";
import { workflow } from "./_config";

/** task: on a reroute, an existing worker of the card kept for this part (it is told, not restarted). */
type Part = { repo: string; agent?: string; model?: string; effort?: string; worktree?: boolean; title?: string; prompt?: string; task?: string };
type Decision = { item: string; decision?: "accept" | "attach" | "stop" | "ignore"; title?: string; parts?: Part[]; task?: string; reason?: string; reply?: string; rule?: string };

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
  // Closed by the user from 去向 while it was being judged: nothing left to do, not an error for the secretary
  if (it.dismissed && it.state === "ignored") return { item: it.id, note: "用户已经手动关掉了这条，不用再处理" };
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
          settle({ state: "observed", rule: d.rule.trim(), would: { title: d.title, parts: d.parts }, reason: undefined });
          return { item: it.id, observed: true };
        }
      }
      return accept(ctx, it, d.title, d.parts, d.rule?.trim());
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
 * A board task in a decision: only a card the user asked the router to rearrange (tasks.reroute). That one is the
 * router's to settle, like a message: it has a pending state (reroute) the sweep watches. Any other board task is
 * the board's own: the router uses the board's commands (tasks.dispatch / drop / say / add / edit), the ones the
 * user's buttons use. Until 2026-11-05 decide also sent board tasks out, then also stopped / attached for them
 * (t52: "关闭 t11，新建一个任务来交接"): a second name for each board command, which the user found to be needless
 * concepts.
 */
async function boardTask(d: Decision, ctx: Ctx) {
  const self = find(load(ctx).store, d.item);
  if (self.reroute) return rearrange(d, self, ctx);
  throw new Error(
    `任务面板上的任务不用 decide，用任务面板的命令：派出去 tasks.dispatch {"id":"${self.id}","parts":[…]}；停掉别的任务 tasks.drop {"id":"tN","reason":"…"}；` +
      `转告 tasks.say {"id":"tN","text":"…"}；它只是条指令、照做完了 tasks.edit {"id":"${self.id}","status":"done","summary":"…"}`,
  );
}

/**
 * The user's feedback on a card (tasks.reroute), decided by the router, the way it decides a new task: the user
 * doesn't pick repositories. On the same card, so the requirement keeps its feed and its id:
 * - parts: the new arrangement. A part with task keeps that worker (told the feedback and its part); workers left
 *   out are stopped; parts without task get new workers, the first one taking the lead's place if the lead is out.
 * - attach (task?, the lead by default): the feedback goes to that worker, to adjust itself.
 * - stop (reason): the whole requirement is dropped.
 */
async function rearrange(d: Decision, self: Task, ctx: Ctx) {
  const fb = self.reroute!.feedback;
  const settle = (text: string) =>
    update(ctx, (s) => {
      const t = find(s, self.id);
      t.reroute = undefined;
      activity(s, t, { kind: "join", text });
    });
  const card = members(load(ctx).store, self).filter((m) => m.status !== "dropped" && (m === self || m.status !== "done"));
  const onCard = (id: string) => {
    const m = card.find((x) => x.id === id);
    if (!m) throw new Error(`${id} 不在 ${self.id} 这张卡上（${card.map((x) => x.id).join("、")}）`);
    return m;
  };
  switch (d.decision ?? "accept") {
    case "attach": {
      const t = d.task ? onCard(d.task) : self;
      await say({ id: t.id, text: `用户对这件事的安排有意见，调度转给你，照着调整：${fb}${d.reason ? `\n调度补充：${d.reason}` : ""}` }, ctx);
      settle(`调度把你的意见转给了 ${memberName(t)}，让它自己调整`);
      return { item: self.id, tasks: [t.id] };
    }
    case "stop": {
      if (!d.reason) throw new Error("stop 要写 reason");
      update(ctx, (s) => (find(s, self.id).reroute = undefined));
      await drop({ id: self.id, reason: `调度照你的意见停了：${d.reason}` }, ctx);
      return { item: self.id, stopped: self.id };
    }
    case "accept":
      break;
    default:
      throw new Error(`重新安排的 decision 是 accept（给 parts）/ attach / stop 之一，不是「${d.decision}」`);
  }
  const parts = d.parts ?? [];
  if (!parts.length) throw new Error(`重新派要给 parts（新的完整安排）；只让现在的 worker 自己改就写 "decision": "attach"`);
  const kept = new Map<string, Part>();
  for (const p of parts) {
    if (p.task) {
      onCard(p.task);
      if (kept.has(p.task)) throw new Error(`${p.task} 在 parts 里出现了两次`);
      kept.set(p.task, p);
    } else if (!p.repo?.trim() || !ctx.dirs.stat(p.repo)?.dir) throw new Error(`仓库目录不存在：${p.repo ?? "（没写 repo）"}`);
  }
  const fresh = parts.filter((p) => !p.task);
  if (!kept.has(self.id) && !fresh.length) throw new Error(`负责人 ${self.id} 不留，就要有一份新的（不写 task）接它的位置`);
  if (fresh.length + kept.size > 1 && fresh.some((p) => !p.prompt?.trim())) throw new Error("几份一起做时，新的每份都要写 prompt：这一份做什么、和别的怎么配合");
  const gone = card.filter((m) => !kept.has(m.id));
  const req = self.request ?? self.prompt ?? self.title;
  if (!self.request && self.prompt) edit({ id: self.id, request: self.prompt }, ctx);
  // What the stopped ones got to, read before their conversations close
  const before = gone.map((m) => {
    const said = lastWords(String((m.session && ctx.sessions.get(m.session)?.reply) ?? ""));
    return [`- ${m.id} 在 ${m.repo ?? "（无仓库）"}`, said && `，最后说：${said}`, m.session && `（对话：gerdr session read ${m.session}）`].filter(Boolean).join("");
  });
  for (const m of gone) if (m.session) await ctx.sessions.close(m.session).catch(() => {});
  update(ctx, (s) => {
    for (const m of gone) {
      if (m.id === self.id) continue;
      const x = find(s, m.id);
      note(x, `调度重新安排时停掉了：${fb}`);
      x.droppedFrom = x.status;
      Object.assign(x, { status: "dropped", doneAt: Date.now(), updatedAt: Date.now() });
    }
  });
  const told = `\n\n## 用户对上一次安排的意见\n${fb}` + (before.length ? `\n\n停掉的之前的 worker（有用的结论可以去它的对话里找，但按上面的意见做，别沿用它错的前提）：\n${before.join("\n")}` : "");
  const changes: string[] = [];
  const errors: string[] = [];
  let rest = fresh;
  if (!kept.has(self.id)) {
    const [p, ...r] = fresh;
    rest = r;
    const was = self.repo?.split("/").pop();
    await start({ id: self.id, repo: p.repo, agent: p.agent, model: p.model, effort: p.effort, worktree: p.worktree, prompt: `${p.prompt?.trim() || req}${told}` }, ctx);
    changes.push(`${self.id} 从 ${was ?? "（无）"} 换到 ${p.repo.split("/").pop()}`);
  }
  for (const p of rest) {
    try {
      const t = (await add(
        { title: p.title, prompt: `${p.prompt?.trim() || req}${told}`, repo: p.repo, agent: p.agent, model: p.model, effort: p.effort, worktree: p.worktree, attachments: self.attachments, from: self.id, router: self.router, routerClosed: true, start: true },
        ctx,
      )) as Task;
      changes.push(`加了 ${memberName(t)}`);
    } catch (e: any) {
      errors.push(`${p.title ?? p.repo}：${e?.message ?? e}`);
    }
  }
  for (const m of gone) if (m.id !== self.id) changes.push(`停了 ${memberName(m)}`);
  for (const [id, p] of kept) {
    const m = find(load(ctx).store, id);
    const yours = p.prompt?.trim() ? `\n你这份现在是：${p.prompt.trim()}` : "";
    await say({ id, text: `调度按用户的意见重新安排了这件事。用户说：${fb}${yours}` }, ctx).catch((e: any) => errors.push(`${id}：${e?.message ?? e}`));
    if (p.prompt?.trim()) changes.push(`${memberName(m)} 改做：${p.prompt.trim().slice(0, 40)}`);
  }
  settle(`调度重新安排：${changes.join("；") || "保持不变"}`);
  if (errors.length) throw new Error(`已重新安排 ${self.id}；没成的：\n${errors.join("\n")}`);
  // The card and the cards split off it that are still going
  const now = load(ctx).store.tasks.filter((m) => (m.id === self.id || m.from === self.id) && m.status !== "dropped" && m.status !== "done");
  return { item: self.id, tasks: now.map((m) => m.id) };
}

/**
 * Accepting an event: a task from it, following its conversation, sent out as the parts say, and "taken" said where
 * it came from. Taken under a proactive rule (nobody asked): the worker is told to stay within that rule, and nobody
 * is told it was taken — no one is waiting for an answer.
 */
async function accept(ctx: Ctx, it: Item, title: string | undefined, parts: Part[], rule?: string) {
  const e = it.event;
  const w = workflow(ctx);
  const settle = (patch: Partial<Item>) => updateState(ctx, (s) => Object.assign(findItem(s, it.id), { decidedAt: Date.now(), ...patch }));
  const text = (e.text ?? "").trim() || e.title || "";
  const from = [e.who && `来自 ${e.who}`, `${e.source}/${e.kind}`].filter(Boolean).join("，");
  const source = `（${from}${e.url ? `：${e.url}` : ""}）`;
  const scope = it.inferred && rule ? `\n\n这件事没人找你做，是按主动工作的规则接的：「${rule}」。只做这条规则允许的，超出的用 ask_human 问用户。` : "";
  // Taken under a proactive rule nobody asked: no one to tell. Otherwise when 设置 → 回复对方 says
  const ack = it.inferred ? "never" : w.ack;
  const review = w.inboxWork === "review";
  const [first, ...rest] = parts;
  const split = parts.length > 1;
  const t = (await add(
    {
      title: (split ? first?.title : undefined) || title || firstLine(text) || e.title || `${e.source}/${e.kind}`,
      prompt: `${split && first?.prompt?.trim() ? first.prompt.trim() : text}\n\n${source}${scope}`,
      attachments: e.files,
      origin: { id: e.id, source: e.source, kind: e.kind, key: e.key, title: e.title, url: e.url, reply: it.inferred ? undefined : e.reply },
      threads: e.key ? [{ source: e.source, key: e.key }] : undefined,
      router: mainId(ctx),
      // To review (设置 → 外面来的消息): where the secretary would send it, already on the card for 派出去
      ...(review && first ? { repo: first.repo, agent: first.agent, model: first.model, effort: first.effort, worktree: first.worktree } : {}),
      ...(review && ack === "dispatch" ? { ackOnStart: true } : {}),
    } as any,
    ctx,
  )) as Task;
  let ids = [t.id];
  if (review) {
    // A card per part, each to look at, change and send out on its own
    for (const p of rest)
      ids.push(((await add({ title: p.title, prompt: `${p.prompt?.trim() || text}\n\n${source}${scope}`, repo: p.repo, agent: p.agent, model: p.model, effort: p.effort, worktree: p.worktree, attachments: e.files, from: t.id, router: mainId(ctx) } as any, ctx)) as Task).id);
    settle({ state: "accepted", tasks: ids, rule, reason: "放进待办，等你过目再派" });
    if (ack === "accept") ackOrigin(ctx, find(load(ctx).store, t.id));
    return { item: it.id, tasks: ids, review: "放进了待办，用户看过、改好再派出去" };
  }
  try {
    ids = ((await dispatch({ id: t.id, parts }, ctx)) as Task[]).map((x) => x.id);
  } catch (err: any) {
    // Accepted all the same: the task is on the board; only sending it out is to redo, as a board task
    settle({ state: "accepted", tasks: ids, rule, reason: undefined });
    throw new Error(`建了任务 ${t.id}，但没派出去：${err?.message ?? err}。改了用 tasks.dispatch {"id":"${t.id}","parts":[…]} 再派`);
  }
  settle({ state: "accepted", tasks: ids, rule, reason: undefined });
  if (ack !== "never") ackOrigin(ctx, find(load(ctx).store, t.id));
  return { item: it.id, tasks: ids };
}

/** 照做: what the main session would have done with an observed event, done now by the user's say-so. { id } */
export async function execute(input: { id: string }, ctx: Ctx) {
  const it = findItem(state(ctx), input?.id ?? "");
  if (it.state !== "observed" || !it.would) throw new Error(`${it.id} 不是「只记录」下记的（${it.state}）`);
  return accept(ctx, it, it.would.title, it.would.parts as Part[], it.rule);
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

/**
 * Closes events by hand: { ids } — pending (still being judged) or unavailable ones the user doesn't want handled.
 * They become 没接 with the user as the reason, so they leave the board's alert and can still be judged again.
 */
export function dismiss(input: { ids: string[] }, ctx: Ctx) {
  const ids = input?.ids ?? [];
  updateState(ctx, (s) => {
    for (const id of ids) {
      const it = findItem(s, id);
      if (it.state !== "pending" && it.state !== "unavailable") throw new Error(`${id} 已经处理过了（${it.state}）`);
    }
    for (const id of ids) Object.assign(findItem(s, id), { state: "ignored", dismissed: true, reason: "你手动关掉了", decidedAt: Date.now() });
  });
  return { closed: ids };
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
