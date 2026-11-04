// The Superagent's decisions and its log: what the main session calls (decide) and what the page reads (log,
// retry). How it works is in _main.ts; why, in DESIGN.md「Superagent」.

import { add, dispatch, drop } from "./tasks";
import { find, load, update, type Task } from "./_store";
import { evaluate, findItem, followUp, mainId, state, updateState, type Item } from "./_main";

type Part = { repo: string; agent?: string; model?: string; effort?: string; worktree?: boolean; title?: string; prompt?: string };
type Decision = { item: string; decision?: "accept" | "attach" | "stop" | "ignore"; title?: string; parts?: Part[]; task?: string; reason?: string; reply?: string };

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
  if (/^t\d+$/.test(d?.item ?? "")) {
    if (!d.parts?.length) throw new Error("看板上的任务要给 parts");
    const out = (await dispatch({ id: d.item, title: d.title, parts: d.parts }, ctx)) as Task[];
    return { item: d.item, tasks: out.map((t) => t.id) };
  }
  const it = findItem(state(ctx), d?.item ?? "");
  if (it.state !== "pending" && it.state !== "unavailable") throw new Error(`已经处理过了（${it.state}）`);
  const e = it.event;
  const settle = (patch: Partial<Item>) =>
    updateState(ctx, (s) => Object.assign(findItem(s, it.id), { decidedAt: Date.now(), ...patch }));
  switch (d.decision) {
    case "accept": {
      if (!d.parts?.length) throw new Error("accept 要给 parts");
      const text = (e.text ?? "").trim() || e.title || "";
      const from = [e.who && `来自 ${e.who}`, `${e.source}/${e.kind}`].filter(Boolean).join("，");
      const t = (await add(
        {
          title: d.title || firstLine(text) || e.title || `${e.source}/${e.kind}`,
          prompt: `${text}\n\n（${from}${e.url ? `：${e.url}` : ""}）`,
          attachments: e.files,
          origin: { id: e.id, source: e.source, kind: e.kind, key: e.key, title: e.title, url: e.url, reply: e.reply },
          threads: e.key ? [{ source: e.source, key: e.key }] : undefined,
          router: mainId(ctx),
        },
        ctx,
      )) as Task;
      let ids = [t.id];
      try {
        ids = ((await dispatch({ id: t.id, parts: d.parts }, ctx)) as Task[]).map((x) => x.id);
      } catch (err: any) {
        // Accepted all the same: the task is on the board; only sending it out is to redo, as a board task
        settle({ state: "accepted", tasks: ids, reason: undefined });
        throw new Error(`建了任务 ${t.id}，但没派出去：${err?.message ?? err}。改了用 {"item":"${t.id}","parts":[…]} 再派`);
      }
      settle({ state: "accepted", tasks: ids, reason: undefined });
      answer(ctx, it, `收到，建了任务 ${t.id}「${find(load(ctx).store, t.id).title}」，有结果会在这里说。`);
      return { item: it.id, tasks: ids };
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
      if (d.reply?.trim()) answer(ctx, it, d.reply.trim());
      return { item: it.id, ignored: true };
    }
    default:
      throw new Error(`decision 是 accept / attach / stop / ignore 之一，不是「${d.decision ?? ""}」`);
  }
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
