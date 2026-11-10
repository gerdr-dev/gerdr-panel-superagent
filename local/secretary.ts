// The secretary (DESIGN.md「秘书」): what the 秘书 page calls (feed, say) and what the secretary itself and its
// briefing schedule call (status, briefing). The session behind it, and how its replies are taken, are _main.ts.

import { list } from "./tasks";
import { append, entries, type Entry } from "./_log";
import { capture, mainId, state, toMain, updateState, type Item } from "./_main";

/** A line the page folds: what happened to an outside message (the 去向 log), drawn between the messages. */
type Note = { id: string; at: number; who: "note"; text: string; state: Item["state"]; tasks?: string[] };

const STATE: Partial<Record<Item["state"], string>> = {
  accepted: "接了",
  attached: "并进",
  stopped: "停掉",
  ignored: "没接",
  delivered: "交给",
  unavailable: "没判断成",
  observed: "只记录",
};

const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return [...t].length > n ? [...t].slice(0, n).join("") + "…" : t;
};

/**
 * The conversation for the page: { entries (oldest first: the user's and the secretary's messages, and the outside
 * messages it handled as notes), main (its session now: running / waiting) }. Takes a finished reply in first.
 */
export async function feed(input: { limit?: number }, ctx: Ctx) {
  await capture(ctx);
  const all = entries(ctx);
  const log = all.slice(-(input?.limit ?? 300));
  // Outside messages only from when the secretary began (state.since, set the first time), and not older than the
  // oldest message shown when the conversation is cut
  const since = state(ctx).since ?? updateState(ctx, (s) => (s.since ??= Math.min(Date.now(), all[0]?.at ?? Infinity)));
  const from = Math.max(since, log.length < all.length ? log[0].at : 0);
  const notes: Note[] = state(ctx)
    .items.filter((it) => STATE[it.state] && (it.decidedAt ?? it.at) >= from)
    .map((it) => {
      const e = it.event;
      const who = e.who || e.actor || "";
      return {
        id: it.id,
        at: it.decidedAt ?? it.at,
        who: "note" as const,
        state: it.state,
        tasks: it.tasks,
        text: `${e.source}${who ? ` · ${who}` : ""}：${cut(e.text || e.title || "", 60)} → ${STATE[it.state]}${it.tasks?.length ? ` ${it.tasks.join("、")}` : ""}${it.reason ? `（${cut(it.reason, 40)}）` : ""}`,
      };
    });
  const merged: (Entry | Note)[] = [...log, ...notes].sort((a, b) => a.at - b.at);
  const id = mainId(ctx);
  const m = id ? ctx.sessions.get(id) : null;
  const s = state(ctx);
  return {
    entries: merged,
    main: m ? { id: m.id, status: m.status, waiting: m.waiting, waitingKind: m.waitingKind, error: m.error } : null,
    // Its turn is about the user's words: the page shows it "typing"
    busy: !!s.awaiting,
  };
}

/** The user says something to the secretary: { text, files? (paths on this machine) }. */
export async function say(input: { text: string; files?: { path: string; name?: string; mime?: string }[] }, ctx: Ctx) {
  const text = (input?.text ?? "").trim();
  const files = (input?.files ?? []).filter((f) => f?.path);
  if (!text && !files.length) throw new Error("说点什么");
  const e = append(ctx, { who: "user", text, ...(files.length ? { files } : {}) });
  await toMain(ctx, [`[用户] ${text}`], "user", files.map((f) => f.path));
  return e;
}

function when(ms?: number) {
  if (!ms) return "";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${Math.max(m, 0)} 分钟前`;
  if (m < 24 * 60) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
}

/**
 * The facts, for the secretary to talk from (it must not tell the user from memory): what waits on the user (with
 * question ids and options, for tasks.answerQuestion), results to review, work in progress, not dispatched yet, and
 * what finished since `since` (ms; default the last 24 hours). Text, as the secretary reads it.
 */
export async function status(input: { since?: number }, ctx: Ctx) {
  const since = input?.since ?? Date.now() - 24 * 3600_000;
  const { tasks } = await list({}, ctx);
  // Members of a requirement are listed under it in the board; here every task stands on its own, flat
  const flat = tasks as any[];
  const you: string[] = [];
  const review: string[] = [];
  const active: string[] = [];
  const todo: string[] = [];
  const done: string[] = [];
  for (const t of flat) {
    const head = `${t.id}「${t.title}」`;
    if (t.status === "dropped") continue;
    if (t.status === "done") {
      if ((t.doneAt ?? t.updatedAt) >= since) done.push(`- ${head} ${when(t.doneAt ?? t.updatedAt)}${t.summary ? `：${cut(t.summary, 200)}` : t.handedBack ? `：${cut(t.handedBack, 200)}` : ""}`);
      continue;
    }
    if (t.column === "you") {
      if (t.owner === "human") {
        const qs = (t.questions ?? []).filter((q: any) => !q.dropped && !q.answer);
        const asks = qs.length
          ? qs.map((q: any) => `    - 问题 ${q.id}：${q.title}${q.options?.length ? `（选项：${q.options.join(" / ")}）` : ""}`).join("\n")
          : t.steps
            ? `    步骤：${cut(t.steps, 400)}`
            : "";
        you.push(`- ${head} ${t.handBack?.kind === "choice" ? "待决定" : qs.length ? "待回答" : "要用户亲手做"}${t.askedBy ? `（${t.askedBy} 问的）` : ""}\n${asks}`);
      } else {
        const why = t.live?.status === "waiting" ? `worker 在等批准：${t.live.waiting ?? ""}` : t.live?.status === "error" ? "worker 出错了" : t.question ? `问：${t.question}` : t.stopped ? `${t.stopWhy ?? "停下了"}${t.said ? `，它最后说：${cut(t.said, 200)}` : ""}` : "在等用户";
        you.push(`- ${head} ${why}`);
      }
    } else if (t.column === "review") review.push(`- ${head} ${cut(t.summary ?? "", 300)}`);
    else if (t.session || t.status === "running" || t.status === "delivering") active.push(`- ${head} ${when(t.updatedAt)}更新${t.summary ? `：${cut(t.summary, 160)}` : ""}`);
    else todo.push(`- ${head}${t.blockedBy?.length ? `（等 ${t.blockedBy.join("、")}）` : t.routing ? "（正在派）" : ""}`);
  }
  const sec = (title: string, l: string[]) => `## ${title}（${l.length}）\n${l.join("\n") || "无"}`;
  return [
    sec("等用户的", you),
    sec("待用户验收的", review),
    sec("在做的", active),
    sec("还没派出去的", todo),
    sec(`完成的（${when(since)}到现在）`, done),
  ].join("\n\n");
}

/**
 * The briefing (schedules/briefing.json, at the times the user set): the facts since the last one, to the secretary
 * to write up as the user's secretary.md says. Its reply lands in the conversation as a briefing.
 */
export async function briefing(input: unknown, ctx: Ctx) {
  const last = state(ctx).briefAt;
  const facts = await status({ since: last }, ctx);
  await toMain(
    ctx,
    [`[简报] 到了写简报的时间${last ? `（上一次是 ${when(last)}）` : ""}。照「简报」的写法写给用户；下面是现在的事实，「完成的」是上次简报以来的。\n\n${facts}`],
    "brief",
  );
  updateState(ctx, (s) => {
    s.briefAt = Date.now();
  });
  return "已交给秘书";
}
