// The Superagent's decisions and its log: what the main session calls (decide) and what the page reads (log,
// retry). How it works is in _main.ts; why, in DESIGN.md「Superagent」.

import { logDone, opens } from "./_letgo";
import { ackOrigin, add, dispatch, drop, edit, lastWords, say, start } from "./tasks";
import { activity, find, load, memberName, members, note, update, type Task } from "./_store";
import { evaluate, findItem, follows, followUp, followWhy, mainId, placeOf, routeOf, state, threadsOf, updateState, type Item } from "./_main";
import { waitingOn } from "./_waits";
import { workflow } from "./_config";
import { secAsks } from "./_secask";

/** task: on a reroute, an existing worker of the card kept for this part (it is told, not restarted). */
type Part = { repo: string; agent?: string; model?: string; effort?: string; worktree?: boolean; title?: string; prompt?: string; task?: string };
type Decision = { item: string; decision?: "accept" | "attach" | "stop" | "ignore" | "wait"; title?: string; parts?: Part[]; task?: string; reason?: string; reply?: string; rule?: string; told?: boolean; ask?: string; prompt?: string };

/**
 * The main session's decisions on a batch, in one call: { decisions: [{ item, decision?, title?, parts?, task?,
 * reason?, reply? }] }. A board task (item tN) only needs parts. A message (item cN): accept (with parts) / attach
 * (task; told: true when the task already has the message, only linked; prompt: a card still in 待办 rewritten with
 * what the message adds) / stop (task, reason) / ignore (reason, reply?) /
 * wait (ask: the open sN its ask_human made, reason: what it asked; decided again once they answer). Each is applied on its own; the ones that failed are
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
  if (it.state !== "pending" && it.state !== "unavailable" && it.state !== "waiting") throw new Error(`已经处理过了（${it.state}）`);
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
      const t = receiver(live(ctx, d.task));
      // Why this task: the user asks "why did that message go there?" and the secretary, asked later, has no memory of
      // it (c700 → t202, 2026-11-25: attached without a word, nobody could say why). 去向 shows it.
      if (!d.reason?.trim()) throw new Error("attach 要写 reason：为什么是这个任务（消息里哪句话、和任务的哪件事对上）");
      // A card still in 待办 is what the user reads before sending it out, and what its worker is sent: the message's
      // material (a trace, the expected value, who said what) is folded into it, not left as a raw "接着说" tail nor
      // promised for later. 2026-11-26, c898: a trace for t341 was judged ignore with "派的时候我一起带上" — the
      // secretary remembers nothing between turns, so it would never have been.
      const todo = t.status === "todo" && !t.session;
      if (todo && !d.told && !d.prompt?.trim())
        throw new Error(
          `${t.id} 还在待办，没派出去：并进时带上 "prompt"，把这条消息带来的材料整理进它的说明（整段新的说明，原来的要求和已有材料都留着，新材料放到对应的地方），用户派之前看的就是它`,
        );
      const linked =
        !!e.key &&
        update(ctx, (s) => {
          const x = find(s, t.id);
          const th = x.threads ?? (x.origin?.key ? [{ source: x.origin.source, key: x.origin.key }] : []);
          if (th.some((y) => y.source === e.source && y.key === e.key)) return false;
          x.threads = [...th, { source: e.source, key: e.key! }];
          return true;
        });
      // told: the task already has it (the secretary asked the user first, then made the task itself): only linked,
      // so the item stops hanging in 去向 and the sender's follow-ups reach the task
      if (!d.told) await followUp(ctx, t.id, e);
      // The rewrite replaces followUp's raw tail (the note it left in the card's history stays)
      // (request, when set, is what the card shows: it gets the same words)
      if (todo && d.prompt?.trim()) {
        const p = d.prompt.trim();
        edit({ id: t.id, prompt: p, ...(find(load(ctx).store, t.id).request ? { request: p } : {}) }, ctx);
      }
      settle({ state: "attached", tasks: [t.id], reason: d.reason.trim(), linked: linked || undefined });
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
    case "wait": {
      // Asked the user first (2026-11-24, c623: "要不要建个任务估排期？"): its own state, not 没判断成, until a later
      // decide settles it
      if (!d.reason?.trim()) throw new Error("wait 要写 reason：问了用户什么");
      // The question must be a card (ask_human), not words in the reply: 2026-11-25, c764 / c765 were put on wait,
      // the question was only a sentence in the secretary's reply ("c764、c765 还在等你回"), nothing lit 等你, and the
      // user, who doesn't read the secretary's chat, never saw it. The card is made by ask_human (its gerdrCard is
      // drawn where the tool was called), so decide can't make it: it only checks one is open and links it.
      const askId = String(d.ask ?? "").split("#")[0].trim();
      const how = `先用 ask_human 问用户（卡片才会出现在对话里、「秘书」那一行才亮「等你」；只写在回复里他看不到），再带上它返回的 id：{"item":"${it.id}","decision":"wait","ask":"s8","reason":"…"}`;
      if (!askId) throw new Error(`wait 要给 ask：${how}`);
      const a = (state(ctx).asks ?? []).find((x) => x.id === askId);
      if (!a) throw new Error(`没有 ${askId} 这个问题：${how}`);
      if (a.status !== "open") throw new Error(`${askId}「${a.title}」已经${a.status === "done" ? `答了（${a.answer ?? "做完了"}），照回答给 ${it.id} decide` : "不在等用户了"}；还要问就重新 ask_human`);
      settle({ state: "waiting", reason: d.reason.trim(), ask: askId });
      return { item: it.id, waiting: true, ask: askId, note: `用户答了 ${askId} 以后再 decide 这一条` };
    }
    case "ignore": {
      if (!d.reason) throw new Error("ignore 要写 reason");
      settle({ state: "ignored", reason: d.reason });
      if (d.reply?.trim() && !it.inferred) answer(ctx, it, d.reply.trim());
      return { item: it.id, ignored: true };
    }
    default:
      throw new Error(`decision 是 accept / attach / stop / ignore / wait 之一，不是「${d.decision ?? ""}」`);
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
  if (self.reroute?.was !== undefined)
    throw new Error(`${self.id} 还没派出去，是让你改卡，不用 decide：tasks.edit {"id":"${self.id}",…} 改好留在待办（拆就 tasks.add，不做就 tasks.drop）`);
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
  // Let it go (inbox): sent out instead of a 待办 card when the policy in effect lets go every part's repository
  const review = !(parts.length > 0 && parts.every((p) => opens(ctx, "inbox", p.repo)));
  const letgo = !review;
  const [first, ...rest] = parts;
  const split = parts.length > 1;
  const named = (split ? first?.title : undefined) || title;
  const t = (await add(
    {
      title: named || firstLine(text) || e.title || `${e.source}/${e.kind}`,
      // Taken by hand without a name: the message's first line stands in until its worker's conversation is named
      ...(named ? {} : { autoTitle: true }),
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
  if (letgo) logDone(ctx, { kind: "dispatched", task: ids.join("、"), text: `${e.who ? `${e.who} 的` : ""}${firstLine(text) || e.title || "消息"}` });
  return { item: it.id, tasks: ids, ...(letgo ? { note: "当前策略放开了外面来的活：没进待办，直接派出去了" } : {}) };
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

/**
 * An attached message must reach someone: a task sent out whose conversation is gone is refused, so the secretary
 * picks another task or ignores it instead of believing it was delivered (2026-11-19, c379: attached to a human task,
 * which had no worker — recorded on it, read by nobody, decide said it was done). A task not sent out yet is fine:
 * the message goes with it when it is (followUp).
 */
function receiver(t: Task): Task {
  if (!t.session && t.status !== "todo") throw new Error(`${t.id} 没有 worker 对话，消息送不到；并进别的任务，或者 ignore`);
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

/**
 * For the page's 去向: every event and where it went, newest first, and the main session. { limit?, id?, q? }: id is
 * one item (cN) whole, q keeps the items whose sender / text / place has every word — what the secretary runs when the
 * user asks why a message went somewhere.
 */
export function log(input: { limit?: number; id?: string; q?: string }, ctx: Ctx) {
  const s = state(ctx);
  if (input?.id) return { item: findItem(s, input.id) };
  const m = s.main ? ctx.sessions.get(s.main) : null;
  return {
    main: s.main ? { id: s.main, status: m?.status ?? "gone", waiting: m?.waiting } : null,
    // Its own questions to the user (_secask.ts): the 秘书 button counts the open ones, their cards read the states
    asks: secAsks(ctx),
    items: (input?.q ? s.items.filter((it) => hasAll(it, input.q!)) : s.items)
      .slice(-(input?.limit ?? 200))
      .reverse()
      .map((it) => ({ ...it, event: { ...it.event, text: (it.event.text ?? "").slice(0, 600) } })),
  };
}

/**
 * Closes events by hand: { ids } — pending (still being judged), waiting or unavailable ones the user doesn't want handled.
 * They become 没接 with the user as the reason, so they leave the board's alert and can still be judged again.
 */
export function dismiss(input: { ids: string[] }, ctx: Ctx) {
  const ids = input?.ids ?? [];
  updateState(ctx, (s) => {
    for (const id of ids) {
      const it = findItem(s, id);
      if (it.state !== "pending" && it.state !== "unavailable" && it.state !== "waiting") throw new Error(`${id} 已经处理过了（${it.state}）`);
    }
    for (const id of ids) Object.assign(findItem(s, id), { state: "ignored", dismissed: true, reason: "你手动关掉了", decidedAt: Date.now() });
  });
  return { closed: ids };
}

/**
 * Sends events to the main session again: { ids, hint? } — ignored / filtered / unavailable ones, by a person's
 * say-so. hint is what the person wants done differently ("this is work, give it to the X repo"), passed with them.
 */
export async function retry(input: { ids: string[]; hint?: string }, ctx: Ctx) {
  const ids = input?.ids ?? [];
  const s = state(ctx);
  for (const id of ids) {
    const it = findItem(s, id);
    if (it.state === "accepted" || it.state === "attached" || it.state === "delivered") throw new Error(`${id} 已经交给任务了（${it.tasks?.join("、")}）`);
  }
  await evaluate(ctx, ids, load(ctx).store.tasks, input?.hint);
  return { sent: ids };
}

function hasAll(it: Item, q: string) {
  const e = it.event;
  const hay = [e.who, e.actor, e.place, e.title, e.text, e.source, it.reason, ...(it.tasks ?? [])].filter(Boolean).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

type Conv = {
  source: string;
  key: string;
  /** "slack-me · 私聊 · Liber", from the newest message seen there; the key when none is in the log. */
  place: string;
  url?: string;
  lastAt?: number;
  /** The newest message there in 去向. */
  last?: string;
  tasks: { id: string; title: string; status: string; why: "thread" | "wait" }[];
  /** Where the next message there goes: straight to these tasks, or the secretary (why). */
  straight: boolean;
  to: string[];
  why: string;
};

/**
 * 去向's 对话: every conversation some task follows (its threads, and those it waits on for now), which tasks, and where
 * the next message there goes. This table is what sends a message past the secretary, and it was shown nowhere: the
 * user couldn't see why a DM went to t229, or that it would go to t202 from then on (c700, 2026-11-25).
 * { q? }: only conversations whose place / task has every word. Ended tasks are listed too (dropped ones aren't): a
 * conversation they're in goes to the secretary, which sees them.
 */
export function threads(input: { q?: string }, ctx: Ctx) {
  const tasks = load(ctx).store.tasks;
  const s = state(ctx);
  const convs = new Map<string, Conv>();
  for (const t of tasks) {
    if (t.status === "dropped") continue;
    for (const c of follows(t)) {
      const k = `${c.source}\u0000${c.key}`;
      let v = convs.get(k);
      if (!v) {
        const seen = s.items.filter((x) => x.event.source === c.source && x.event.key === c.key).pop();
        const ev = seen?.event ?? (t.origin?.source === c.source && t.origin?.key === c.key ? t.origin : undefined);
        const r = routeOf(ctx, tasks, c);
        v = {
          source: c.source,
          key: c.key,
          place: ev ? placeOf(ev) || c.key : c.key,
          url: ev?.url,
          lastAt: seen?.at,
          last: seen ? firstLine(seen.event.text || seen.event.title || "") : undefined,
          tasks: [],
          straight: r.straight,
          to: r.straight ? r.owners.map((x) => x.id) : [],
          why: r.why,
        };
        convs.set(k, v);
      }
      v.tasks.push({ id: t.id, title: t.title, status: t.status, why: followWhy(t, c) });
    }
  }
  let out = [...convs.values()];
  if (input?.q) {
    const ws = input.q.toLowerCase().split(/\s+/).filter(Boolean);
    out = out.filter((c) => {
      const hay = [c.place, c.key, c.last, ...c.tasks.flatMap((t) => [t.id, t.title])].join(" ").toLowerCase();
      return ws.every((w) => hay.includes(w));
    });
  }
  // Where messages go past the secretary first, then the newest talk
  out.sort((a, b) => Number(b.straight) - Number(a.straight) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
  return { conversations: out };
}

/**
 * A task stops following a conversation: { task, source, key }. What is said there next goes to the secretary first
 * (unless another task still follows it). A wait (it waits on an answer there) is the worker's own and stays: tell it
 * (tasks.say) to take it back.
 */
export function unfollow(input: { task: string; source: string; key: string }, ctx: Ctx) {
  const { task, source, key } = input ?? ({} as any);
  if (!task || !source || !key) throw new Error(`要给 task、source、key：{"task":"t12","source":"slack-me","key":"…"}（gerdr panel run superagent.threads 里有）`);
  const t = find(load(ctx).store, task);
  const had = threadsOf(t).some((x) => x.source === source && x.key === key);
  if (had)
    update(ctx, (s) => {
      const x = find(s, task);
      x.threads = threadsOf(x).filter((y) => !(y.source === source && y.key === key));
    });
  const waits = waitingOn(t).some((x) => x.source === source && x.key === key);
  if (!had && !waits) throw new Error(`${task} 没有跟着这段对话`);
  return {
    unfollowed: had,
    note: waits ? `${task} 还在等这段对话里的回复（wait_for），等到之前那里的消息仍会给它；要它别等了用 tasks.say 告诉它` : `之后那里的消息先给秘书判断`,
  };
}
