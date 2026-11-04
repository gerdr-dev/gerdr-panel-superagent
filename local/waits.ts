// Waiting on someone else: a worker that asked a person outside (a DM to a colleague, a comment on an MR) or started
// something slow (a deploy job) ends its turn with wait_for instead of saying "I'm waiting" in a turn that is over —
// t29 on 2026-11-04 told the board it waited for a colleague to press Retry, stopped, and nothing ever woke it: the
// colleague's DM reply and the job finishing reached nobody, and the user had to ask "are you waiting?".
//
// wait_for makes the waiting real:
// - conversation: the task follows it (threads, like its origin's), so the reply goes to the worker as a follow-up
//   (_main.ts followUp). Gerdr only runs this panel for events a trigger names, and the user may never have turned the
//   source on in 触发器 — so a trigger of its own (user/triggers/follow-*.json → onFollowed) brings that one
//   conversation in, and goes when no live task follows it any more (tick).
// - recheck: in that many minutes the worker is told to look again (tick, every minute: schedules/waits.json).
// Meanwhile the card stays in 进行中 showing what it waits on; the worker running again (woken, or the user writing to
// it) ends the wait — it calls wait_for again if it still waits.

import { load, note, update, type Task } from "./_store";
import { followUp, record, subscribers, compact } from "./_main";
import { mine } from "./board";
import { USER } from "./_user";

const DIR = `${USER}/triggers`;
const PREFIX = "follow-";
const FN = "waits.onFollowed";
const DAY = 86_400_000;

export const tools = {
  wait_for: {
    description:
      "End your turn waiting on someone or something outside, instead of only saying you'll wait (once your turn ends nothing wakes you otherwise). " +
      "conversation: where the answer will come — the Slack channel / DM id you wrote to (D09…, C0…), a Slack message link, or an MR URL; their reply there is sent to you. " +
      "recheck: minutes until you're told to look again yourself (a job, a deploy, anything nobody will write about). Give one or both. " +
      "Your card stays in progress meanwhile, showing `what`. Then end your turn; when woken and still waiting, call it again. When to use: the my-workflow skill, references/board.md.",
    input: {
      type: "object",
      properties: {
        what: { type: "string", description: "What you wait for, for the card: 石石 点 Retry 重跑 deploy_console_tag" },
        conversation: { type: "string", description: "Where the answer comes: a Slack channel / DM id, a Slack message link, or an MR URL" },
        recheck: { type: "number", description: "Minutes until you're woken to check yourself (1 – 1440)" },
      },
      required: ["what"],
    },
  },
};

/** Which conversation a worker means, as events name it: { source, key }, from what has come from it lately. */
function resolve(ctx: Ctx, conv: string): { source: string; key: string } {
  const c = conv.trim();
  const keys = new Set<string>([c]);
  const slack = /\/archives\/([A-Z0-9]+)/.exec(c);
  if (slack) keys.add(slack[1]);
  const mr = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/.exec(c);
  if (mr) keys.add(`${mr[1]}!${mr[2]}`);
  const since = Date.now() - 30 * DAY;
  for (const key of keys) {
    const seen = ctx.events.list({ key, since, limit: 1 });
    if (seen.length) return { source: seen[seen.length - 1].source, key };
  }
  // An MR nobody has commented on yet: its events will come from the GitLab watcher (mrwatch.ts) as gitlab/*
  if (mr) return { source: "gitlab", key: `${mr[1]}!${mr[2]}` };
  throw new Error(
    `没找到「${c}」这个对话：最近 30 天没有它的消息进来（可能这个来源的插件没开，或者写的不是频道 / 私信 id）。` +
      `只等状态变化的（job、发布）用 recheck 定时回来看；要人回话的，换成对方会回复的那个对话的 id 或链接`,
  );
}

export function wait_for(input: { what: string; conversation?: string; recheck?: number }, ctx: Ctx) {
  const what = (input?.what ?? "").trim();
  if (!what) throw new Error("what 写清在等什么");
  const recheck = input.recheck == null ? undefined : Number(input.recheck);
  if (recheck != null && !(recheck >= 1 && recheck <= 1440)) throw new Error("recheck 是 1 到 1440 分钟");
  if (!input.conversation?.trim() && recheck == null) throw new Error("conversation 和 recheck 至少给一个：不然没有什么会叫醒你");
  const th = input.conversation?.trim() ? resolve(ctx, input.conversation) : undefined;
  const t = update(ctx, (s) => {
    const t = mine(s, ctx);
    if (t.status !== "running") throw new Error(`${t.id} 现在不是进行中（${t.status}），不用等`);
    if (th) {
      const cur = t.threads ?? (t.origin?.key ? [{ source: t.origin.source, key: t.origin.key }] : []);
      if (!cur.some((x) => x.source === th.source && x.key === th.key)) t.threads = [...cur, th];
    }
    const now = Date.now();
    t.waiting = { what, since: now, ...th, recheckAt: recheck != null ? now + recheck * 60_000 : undefined };
    note(t, `等：${what}${th ? `（${th.source} ${th.key} 上的回复）` : ""}${recheck != null ? `，${recheck} 分钟后回来看` : ""}`);
    Object.assign(t, { viaTools: true, reportedAt: now, nudges: 0, question: undefined, updatedAt: now });
    return t;
  });
  if (th) ensureTrigger(ctx, th);
  return {
    id: t.id,
    note:
      [th && `${th.source} ${th.key} 上来的回复会发给你`, recheck != null && `${recheck} 分钟后会叫你回来看`].filter(Boolean).join("；") +
      "。现在结束这一轮，不用再等。",
  };
}

// ---- the trigger that brings a followed conversation in ----

function slug(s: string) {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

function ensureTrigger(ctx: Ctx, th: { source: string; key: string }) {
  const p = `${DIR}/${PREFIX}${slug(th.source)}-${slug(th.key)}.json`;
  if (ctx.fs.stat(p)) return;
  ctx.fs.mkdir(DIR);
  ctx.fs.write(p, JSON.stringify({ on: `${th.source}/*`, key: th.key, fn: FN, name: `任务在等的对话：${th.source} ${th.key}` }, null, 2) + "\n");
}

function glob(pat: string, s: string) {
  const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(s);
}

/** Gerdr's event pattern: source/kind with * globs, or a kind alone. */
function matches(on: string, key: string | undefined, e: GerdrEvent) {
  const ok = on.includes("/") ? glob(on, `${e.source}/${e.kind}`) : glob(on, e.kind);
  return ok && (!key || (!!e.key && glob(key, e.key)));
}

/** Whether inbox.onEvent gets this event too (a source turned on in 触发器, the MR trigger): then it delivers it. */
function inboxTakes(ctx: Ctx, e: GerdrEvent) {
  for (const dir of ["triggers", DIR]) {
    if (!ctx.fs.stat(dir)) continue;
    for (const f of ctx.fs.list(dir)) {
      if (f.dir || !f.path.endsWith(".json")) continue;
      try {
        const t = JSON.parse(ctx.fs.read(f.path));
        if (t.fn === "inbox.onEvent" && t.on && matches(t.on, t.key, e)) return true;
      } catch {
        // a broken file is Gerdr's to report
      }
    }
  }
  return false;
}

/** A trigger's run (user/triggers/follow-*.json): a message in a conversation a task follows, to that task's worker. */
export async function onFollowed(input: { event: GerdrEvent }, ctx: Ctx) {
  const e = input?.event;
  if (!e?.id) throw new Error("没有事件（这个函数由 user/triggers/follow-*.json 调用）");
  if (inboxTakes(ctx, e)) return { inbox: true };
  const { store } = load(ctx);
  if (store.tasks.some((t) => t.origin?.id === e.id || t.followups?.includes(e.id))) return { duplicate: true };
  const ev = compact(e);
  const owners = subscribers(store.tasks, ev);
  if (!owners.length) return { nobody: true };
  for (const t of owners) await followUp(ctx, t.id, ev);
  const it = record(ctx, ev, { state: "delivered", tasks: owners.map((t) => t.id) });
  return { item: it.id, delivered: it.tasks };
}

// ---- every minute ----

/** Wakes workers whose recheck time came, and removes follow triggers no live task needs. */
export async function tick(input: unknown, ctx: Ctx) {
  const now = Date.now();
  const due: { id: string; session: string; what: string }[] = [];
  const { store } = update(ctx, (s) => {
    due.length = 0;
    for (const t of s.tasks) {
      const w = t.waiting;
      if (!w?.recheckAt || w.recheckAt > now) continue;
      if (t.status !== "running" || !t.session) {
        t.waiting = undefined;
        continue;
      }
      due.push({ id: t.id, session: t.session, what: w.what });
      t.waiting = w.key ? { ...w, recheckAt: undefined } : undefined;
      t.updatedAt = now;
    }
    return { store: s };
  });
  for (const d of due)
    await ctx.sessions
      .send(d.session, `[看板] 到时间了，回来看一下（任务 ${d.id}）：${d.what}。有结果就照常做、用 task_update 汇报；还没好就再 wait_for。`, { now: true })
      .catch((err: any) => ctx.log(`${d.id} 叫不醒：${err?.message ?? err}`));
  const removed = sweepTriggers(ctx, store.tasks);
  return { woke: due.map((d) => d.id), removed };
}

function sweepTriggers(ctx: Ctx, tasks: Task[]) {
  if (!ctx.fs.stat(DIR)) return [];
  const live = tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
  const out: string[] = [];
  for (const f of ctx.fs.list(DIR)) {
    const name = f.path.split("/").pop() ?? "";
    if (f.dir || !name.startsWith(PREFIX)) continue;
    try {
      const t = JSON.parse(ctx.fs.read(f.path));
      if (t.fn !== FN) continue;
      const source = String(t.on).split("/")[0];
      if (live.some((x) => x.threads?.some((th) => th.source === source && th.key === t.key))) continue;
    } catch {
      continue;
    }
    ctx.fs.trash(f.path);
    out.push(name);
  }
  return out;
}
