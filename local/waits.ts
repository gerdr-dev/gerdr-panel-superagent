// Waiting on someone else: a worker that asked a person outside (a DM to a colleague, a comment on an MR) or started
// something slow (a deploy job) ends its turn with wait_for instead of saying "I'm waiting" in a turn that is over —
// t29 on 2026-11-04 told the board it waited for a colleague to press Retry, stopped, and nothing ever woke it: the
// colleague's DM reply and the job finishing reached nobody, and the user had to ask "are you waiting?".
//
// wait_for makes the waiting real. Whichever of its conditions comes first wakes the worker (_wake.ts):
// - conversation: the task follows it (threads, like its origin's), so news there — a person's reply, an MR's review /
//   pipeline / merge — goes to the worker as a follow-up (_main.ts followUp). Gerdr only runs this panel for events a
//   trigger names, and the user may never have turned the source on in 触发器 — so a trigger of its own
//   (user/triggers/follow-*.json → onFollowed) brings that one conversation in, and goes when no live task follows it.
// - check: a command the worker wrote that says whether it has happened (a publish approved, a job done), run here every
//   few minutes (tick → runChecks): exit 0 wakes it with the output. Watching a state is no fixed event: each wait has
//   its own, so the worker writes it (2026-11-04: waiting on a colleague to approve a publish, only his DM reply would
//   have woken it — not the approval itself).
// - recheck: woken anyway after that many minutes.
// Meanwhile the card stays in 进行中 showing what it waits on and the latest check; the worker running again (woken, or
// the user writing to it) ends the wait — it calls wait_for again if it still waits.

import { load, note, update, type Task } from "./_store";
import { isOutside, mrConversation, open, waitOn, wakeText, type Wait } from "./_waits";
import { wake } from "./_wake";
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
      "Give what wakes you — any of these, whichever comes first wakes you: " +
      "conversation: where a person will answer — the Slack channel / DM id you wrote to (D09…, C0…), a Slack message link, or an MR URL (its reviews, pipelines, merge come too); " +
      "check: a command that tells whether what you wait for has happened (a publish approved, a job finished, a page live) — the board runs it every `every` minutes, exit 0 = it has (you're woken with its output), any other exit = not yet; print one line saying where things stand, it shows on your card; " +
      "recheck: minutes after which you're woken anyway, as a backstop. " +
      "Waiting on a person to do something you can see (approve, merge, deploy)? Give both the conversation and a check. " +
      "Your card stays in progress meanwhile, showing `what`. Then end your turn; when woken and still waiting, call it again. When to use: the my-workflow skill, references/board.md.",
    input: {
      type: "object",
      properties: {
        what: { type: "string", description: "What you wait for, for the card: 程志鹏审批香港生产发布单 publish-03d1…" },
        conversation: { type: "string", description: "Where a person will answer: a Slack channel / DM id, a Slack message link, or an MR URL" },
        check: {
          type: "object",
          description: "A command run on a timer: exit 0 when what you wait for has happened, else non-zero; print one line of where it stands",
          properties: {
            command: { type: "string", description: "Run with sh -c; 60 s at most per run. Use tools you already used (glab, lb-cli, curl…)" },
            every: { type: "number", description: "Minutes between runs (1 – 60, default 2)" },
            cwd: { type: "string", description: "Absolute directory to run it in (default: the task's repository)" },
          },
          required: ["command"],
        },
        recheck: { type: "number", description: "Minutes until you're woken anyway (1 – 1440)" },
      },
      required: ["what"],
    },
  },
};

/** Which conversation a worker means, as events name it: { source, key }, from what has come from it lately. */
function resolve(ctx: Ctx, conv: string): { source: string; key: string; where: string; url?: string } {
  const c = conv.trim();
  // An MR: its events come from the MR watcher (mrwatch.ts) as gitlab, group/repo!34 — review, pipeline, merge…
  const asMr = mrConversation(c);
  if (asMr) return asMr;
  const keys = new Set<string>([c]);
  const slack = /\/archives\/([A-Z0-9]+)/.exec(c);
  if (slack) keys.add(slack[1]);
  const since = Date.now() - 30 * DAY;
  for (const key of keys) {
    const seen = ctx.events.list({ key, since, limit: 1 });
    if (seen.length) {
      // For the chat's card: where, in words — "Slack 有人私聊我 · 石石 (Yang Lei)", not D09DJBLRF4K
      const e = seen[seen.length - 1];
      const kind = ctx.events.catalog().find((x) => x.on === `${e.source}/${e.kind}`)?.title || e.source;
      const who = compact(e).who;
      return { source: e.source, key, where: who ? `${kind} · ${who}` : `${kind} · ${key}` };
    }
  }
  throw new Error(
    `没找到「${c}」这个对话：最近 30 天没有它的消息进来（可能这个来源的插件没开，或者写的不是频道 / 私信 id）。` +
      `只等状态变化的（job、发布）用 recheck 定时回来看；要人回话的，换成对方会回复的那个对话的 id 或链接`,
  );
}

export function wait_for(
  input: { what: string; conversation?: string; check?: { command: string; every?: number; cwd?: string }; recheck?: number },
  ctx: Ctx,
) {
  const what = (input?.what ?? "").trim();
  if (!what) throw new Error("what 写清在等什么");
  const recheck = input.recheck == null ? undefined : Number(input.recheck);
  if (recheck != null && !(recheck >= 1 && recheck <= 1440)) throw new Error("recheck 是 1 到 1440 分钟");
  const cmd = input.check?.command?.trim();
  if (input.check && !cmd) throw new Error("check 要给 command");
  const every = input.check?.every == null ? 2 : Number(input.check.every);
  if (cmd && !(every >= 1 && every <= 60)) throw new Error("check.every 是 1 到 60 分钟");
  if (!input.conversation?.trim() && !cmd && recheck == null) throw new Error("conversation、check、recheck 至少给一个：不然没有什么会叫醒你");
  const th = input.conversation?.trim() ? resolve(ctx, input.conversation) : undefined;
  const { t, ws } = update(ctx, (s) => {
    const t = mine(s, ctx);
    if (t.status !== "running") throw new Error(`${t.id} 现在不是进行中（${t.status}），不用等`);
    const cwd = input.check?.cwd?.trim() || t.repo || "";
    if (cmd && !cwd.startsWith("/")) throw new Error("check.cwd 要是绝对路径（任务没有仓库时必须给）");
    const now = Date.now();
    const ws = waitOn(t, { what, conv: th, check: cmd ? { command: cmd, cwd, every } : undefined, at: recheck != null ? now + recheck * 60_000 : undefined });
    note(t, `等：${what}${th ? `（${th.where} 上的回复）` : ""}${cmd ? `，每 ${every} 分钟检查：${cmd}` : ""}${recheck != null ? `，${recheck} 分钟后回来看` : ""}`);
    Object.assign(t, { viaTools: true, reportedAt: now, nudges: 0, updatedAt: now });
    return { t, ws };
  });
  // The MR watcher's events come in through triggers/mr.json; anything else may need a trigger of its own
  if (th && th.source !== "gitlab") ensureTrigger(ctx, th);
  return {
    id: t.id,
    gerdrCard: waitCard(ctx, t, ws),
    note:
      [th && `${th.where} 上来的消息会发给你`, cmd && `检查命令每 ${every} 分钟跑一次（一分钟内先跑第一次），exit 0 时叫醒你`, recheck != null && `${recheck} 分钟后会叫你回来看`].filter(Boolean).join("；") +
      "。现在结束这一轮，不用再等。",
  };
}

/**
 * A wait shown in the worker's chat (ui/src/cards.tsx "task-wait"): what it waits on, what will wake it, and later how
 * it ended — a turn that just ends after "I'll wait" left the user unsure anything was going on (2026-11-04). Used by
 * wait_for (and older workers' task_update delivering: a wait_for on the MR).
 */
export function waitCard(ctx: Ctx, t: Task, ws: Wait[]) {
  return {
    type: "task-wait",
    ref: `${t.id}:${ws.map((w) => w.id).join(",")}`,
    project: ctx.workspace.project,
    task: t.id,
    waits: ws.map((w) => w.id),
    kicker: `在等 · ${t.id}`,
    title: ws[0]?.what ?? "",
    body: ws.map((w) => wakeText(w)).join("；"),
    url: ws.find((w) => w.url)?.url,
    since: ws[0]?.since,
    tone: "info",
  };
}

/**
 * For the chat's wait card: are these waits still on, and if not, how they ended. { id, waits } — or, from cards made
 * before waits had ids, { id, since, kind? }.
 */
export function status(input: { id: string; waits?: string[]; since?: number; kind?: string }, ctx: Ctx) {
  const t = load(ctx).store.tasks.find((x) => x.id === input?.id);
  if (!t) return { state: "gone" };
  const all = t.waits ?? [];
  const ws = input.waits?.length
    ? all.filter((w) => input.waits!.includes(w.id))
    : all.filter((w) => w.since === input.since && isOutside(w));
  const on = ws.filter((w) => !w.end);
  if (on.length) {
    const woke = on.find((w) => w.woke)?.woke;
    const last = on.find((w) => w.check?.last)?.check?.last;
    return { state: "waiting", body: on.map((w) => wakeText(w)).join("；"), woke, check: last };
  }
  const end = ws.map((w) => w.end).filter(Boolean).sort((a, b) => a!.at - b!.at)[0];
  if (end) return { state: "ended", how: end.how, at: end.at };
  return { state: "ended", how: t.status === "done" ? "任务完成了" : t.status === "dropped" ? "任务放弃了" : "接着做了" };
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

/**
 * Every minute: wakes workers whose time to look again came, runs the due check commands (the one wake path: _wake.ts),
 * and removes follow triggers no live task needs.
 */
export async function tick(input: unknown, ctx: Ctx) {
  const now = Date.now();
  const due = load(ctx)
    .store.tasks.filter((t) => t.status === "running")
    .flatMap((t) => open(t).filter((w) => w.kind === "time" && (w.at ?? 0) <= now).map((w) => ({ t, w })));
  const woke: string[] = [];
  for (const { t, w } of due) {
    try {
      await wake(ctx, t.id, {
        how: "到点了，回来看",
        text: `[看板] 到时间了，回来看一下（任务 ${t.id}）：${w.what}。有结果就照常做、用 task_update 汇报；还没好就再 wait_for。`,
        // The whole wait_for ends: it looks again and waits again if it must
        ends: isOutside,
      });
      woke.push(t.id);
    } catch (err: any) {
      ctx.log(`${t.id} 叫不醒：${err?.message ?? err}`);
    }
  }
  woke.push(...(await runChecks(ctx)));
  const removed = sweepTriggers(ctx, load(ctx).store.tasks);
  return { woke, removed };
}

const OUT_MAX = 1500;

/**
 * Runs the check commands that are due (wait_for check). Exit 0: what it waits for happened — the worker is woken with
 * the output. Other exits: not yet; the output's last line goes on the card. Three broken runs in a row (timeout,
 * couldn't start): woken with the error, so a bad command doesn't sit there for ever.
 */
async function runChecks(ctx: Ctx): Promise<string[]> {
  const now = Date.now();
  const due = load(ctx)
    .store.tasks.filter((t) => t.status === "running")
    .flatMap((t) => open(t).filter((w) => w.kind === "check" && w.check && w.check.next <= now).map((w) => ({ t, w })));
  const woke: string[] = [];
  for (const { t, w } of due) {
    const c = w.check!;
    let code = -1;
    let out = "";
    let broke = "";
    try {
      // cwd can't leave the panel's directory (ctx.exec): the shell goes there itself
      const r = await ctx.exec("sh", ["-c", 'cd "$1" && eval "$2"', "_", c.cwd, c.command], { timeout: 60_000 });
      code = r.code;
      out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
    } catch (err: any) {
      broke = String(err?.message ?? err);
    }
    const tail = (out || broke).slice(-OUT_MAX);
    const fails = broke ? (c.fails ?? 0) + 1 : 0;
    const last = { at: Date.now(), code, out: lastLine(tail) };
    if (code === 0 || fails >= 3) {
      const how = code === 0 ? `检查到了：${last.out || "exit 0"}` : `检查命令连着 3 次出错：${lastLine(broke)}`;
      try {
        await wake(ctx, t.id, {
          how,
          text:
            code === 0
              ? `[看板] 你等的「${w.what}」检查到了（任务 ${t.id}）。检查命令的输出：\n\n${tail || "（没有输出）"}\n\n照常接着做、用 task_update 汇报；还要等别的就再 wait_for。`
              : `[看板] 你为「${w.what}」写的检查命令连着 3 次没跑成（任务 ${t.id}）：\n\n${tail}\n\n看看命令哪里不对，改好再 wait_for。`,
          ends: isOutside,
          also: (x) => {
            const ww = (x.waits ?? []).find((y) => y.id === w.id);
            if (ww?.check) ww.check.last = last;
          },
        });
        woke.push(t.id);
      } catch (err: any) {
        ctx.log(`${t.id} 叫不醒：${err?.message ?? err}`);
      }
      continue;
    }
    update(ctx, (s) => {
      const ww = (s.tasks.find((x) => x.id === t.id)?.waits ?? []).find((y) => y.id === w.id);
      if (!ww?.check || ww.end) return;
      Object.assign(ww.check, { last, fails, next: Date.now() + ww.check.every * 60_000 });
    });
  }
  return woke;
}

function lastLine(s: string) {
  const line = s.trim().split("\n").filter((x) => x.trim()).pop() ?? "";
  return [...line].length > 200 ? [...line].slice(0, 200).join("") + "…" : line;
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
