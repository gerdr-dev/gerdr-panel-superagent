// The secretary (DESIGN.md「秘书」): what the 秘书 page calls (open), what the secretary itself and its schedules call
// (status, briefing, checkStuck, compact), and say for the panel's assistant. The page is the secretary's own chat;
// the session behind it is _main.ts.

import { list } from "./tasks";
import { askText, compactMain, ensureMain, state, toMain, updateState } from "./_main";

const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return [...t].length > n ? [...t].slice(0, n).join("") + "…" : t;
};

/**
 * For the page: the secretary's session, opened if there's none yet (it starts with no message; its rules are in its
 * system prompt). { main: its id }.
 */
export async function open(_input: unknown, ctx: Ctx) {
  const { id } = await ensureMain(ctx);
  return { main: id.id };
}

/**
 * Something said to the secretary from elsewhere (the panel's assistant passing on what the user asked it): { text,
 * files? (paths on this machine) }. On the page the user types into the secretary's chat itself.
 */
export async function say(input: { text: string; files?: { path: string; name?: string; mime?: string }[] }, ctx: Ctx) {
  const text = (input?.text ?? "").trim();
  const files = (input?.files ?? []).filter((f) => f?.path);
  if (!text && !files.length) throw new Error("说点什么");
  const id = await toMain(ctx, [`[用户] ${text}`], "user", files.map((f) => f.path));
  return { main: id };
}

/**
 * Compacts the secretary's conversation (schedules/compact.json): see _main.ts compactMain. { force?: true }
 */
export async function compact(input: { force?: boolean } | null, ctx: Ctx) {
  return compactMain(ctx, input ?? undefined);
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
        const ask = askText(t);
        you.push(`- ${head} ${t.handBack?.kind === "choice" ? "待决定" : t.questions?.length ? "待回答" : "要用户亲手做"}${t.askedBy ? `（${t.askedBy} 问的）` : ""}${ask ? `\n${ask}` : ""}`);
      } else {
        const ask = askText(t);
        if (ask && !t.live?.status?.match(/waiting|error/)) {
          you.push(`- ${head} 在等用户回答\n${ask}`);
          continue;
        }
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
    undefined,
    "[简报] 到点了：秘书照看板现状写简报",
  );
  updateState(ctx, (s) => {
    s.briefAt = Date.now();
  });
  return "已交给秘书";
}

/**
 * The stuck check (schedules/stuck.json, every 3 hours by default; DESIGN.md「秘书是辅助」): the board finds what's
 * stuck — waiting on the user for `hours`, no word from its worker for that long, an error, one turn running that
 * long — and only then hands it to the secretary to report. Nothing stuck: the secretary isn't woken (no cost, no
 * message). { hours?: 3, dry?: true — only list them: the secretary isn't told, nothing is remembered }
 */
export async function checkStuck(input: { hours?: number; dry?: boolean } | null, ctx: Ctx) {
  const hours = Number(input?.hours) > 0 ? Number(input!.hours) : 3;
  const since = Date.now() - hours * 3600_000;
  const { tasks } = await list({}, ctx);
  const stuck: { id: string; line: string }[] = [];
  for (const t of tasks as any[]) {
    if (t.status === "done" || t.status === "dropped" || t.remote) continue;
    const head = `${t.id}「${t.title}」`;
    const ago = (ms: number) => when(ms);
    if (t.owner === "human") {
      if (t.ready && t.status === "todo" && t.createdAt < since) stuck.push({ id: t.id, line: `${head} 要你${t.handBack?.kind === "choice" || t.questions?.length ? "决定" : "亲手做"}，${ago(t.createdAt)}就在等${askText(t) ? `\n${askText(t)}` : ""}` });
      continue;
    }
    if (t.status === "todo") continue;
    // Held up by a step of the user's: that step is what's reported (above), not this one again
    if ((t.blockedBy ?? []).some((b: string) => (tasks as any[]).some((h) => h.id === b && h.owner === "human" && h.status === "todo"))) continue;
    const last = Math.max(t.reportedAt ?? 0, t.updatedAt ?? 0, t.live?.updatedAt ?? 0);
    if (t.live?.status === "error") stuck.push({ id: t.id, line: `${head} 的 worker 出错了：${cut(t.live.error ?? "", 120)}` });
    else if (t.live?.status === "waiting" && (t.live.waitingSince ?? last) < since) stuck.push({ id: t.id, line: `${head} 的 worker ${ago(t.live.waitingSince ?? last)}起在等你批准：${t.live.waiting ?? ""}` });
    else if (t.live?.status === "running" && (t.live.turnStartedAt ?? Date.now()) < since) stuck.push({ id: t.id, line: `${head} 这一轮 ${ago(t.live.turnStartedAt)}开始，到现在还没停` });
    else if (t.column === "review" && last < since) stuck.push({ id: t.id, line: `${head} 交了结果，${ago(last)}起等你验收：${cut(t.summary ?? "", 160)}` });
    else if (t.column === "you" && last < since) stuck.push({ id: t.id, line: `${head} ${ago(last)}起在等你：${t.question ? `问：${cut(t.question, 160)}` : t.stopped ? `${t.stopWhy ?? "停下了"}${t.said ? `，它最后说：${cut(t.said, 160)}` : ""}` : "见它的对话"}` });
    else if (t.column === "active" && t.live?.status !== "running" && last < since) {
      const w = (t.waits ?? []).find((x: any) => !x.user);
      stuck.push({ id: t.id, line: `${head} ${ago(last)}之后就没进展了${w ? `，在等：${w.what}` : ""}` });
    }
  }
  if (input?.dry) return stuck.map((x) => x.line);
  const before = new Set(state(ctx).stuck ?? []);
  updateState(ctx, (s) => {
    s.stuck = stuck.map((x) => x.id);
  });
  if (!stuck.length) return `没有卡住的任务（${hours} 小时为界），没叫秘书`;
  const lines = stuck.map((x) => `- ${x.line}${before.has(x.id) ? "（上次检查也报过）" : ""}`).join("\n");
  await toMain(ctx, [`[检查] 定时检查（${hours} 小时为界）发现这些任务卡住了，照「检查卡住的任务」的写法告诉用户：\n${lines}`], "brief", undefined, `[检查] ${stuck.length} 个任务卡住了：${stuck.map((x) => x.id).join("、")}`);
  return `${stuck.length} 个卡住的任务，已交给秘书汇报`;
}
