import { tellInbox } from "./_inbox";
import { DATA, skillFile } from "./_user";
import { workflow } from "./_config";
import { forWorker } from "./memory";
import { activity, blockersDone, find, load, members, newTask, note, reqOf, splitRef, update, type Question, type Store, type Task } from "./_store";
import { applyBlock } from "./_apply";
import { endQuestions, endWaits, isOutside, open, question, syncAgents, syncSessions, wakeText, type Wait } from "./_waits";
import { cutLine, wake } from "./_wake";
import { allAgents, mentionsIn } from "./_agents";
import { isMain, rerouteTask, routeTask, sweep, toMain } from "./_main";

export type { Task };

// Task board data: user/data/reqs/, a file per part (read and written through _store.ts, _parts.ts). Agent tasks are handed to coding-agent sessions (workers); human tasks are
// things only the user can do (UI clicks, accounts, approvals). Everything here is deterministic: the page, the
// panel agent (`gerdr panel run tasks.<fn> '<json>'`) and worker replies all go through these functions.
//
// Workers don't report (2026-11-12): the task panel follows their sessions, and a turn that ends waiting on nothing
// puts the task before the user (待验收). What they still tell it goes through the panel tools (board.ts: wait_for,
// ask_human, cancel_human), which Gerdr gives them over MCP. Older workers ended replies
// with a ```gerdr-task``` JSON block; `list` still reads those.

// What a worker is told besides its task: short, since it shows in the chat as part of the first message. How to
// use each tool is in the tools' own descriptions (board.ts), the user's way of working in the panel's skills — named
// by absolute path (skillFile): "the skill, references/task.md" had the worker search the disk for it.
// Old sessions may still end replies with a ```gerdr-task``` block: list() keeps reading those.
// Not exported: an exported function here is one a page or an agent can call (tasks.<name>).
function workerProtocol(ctx: Ctx, id: string) {
  return `

---
This is task ${id} on the user's Superagent task panel: opening it there opens this chat. Nothing to report: say it
in your replies, conclusion first. How to work on it (waiting on others, asking them, sessions you start) is their
my-workflow skill: read ${skillFile(ctx, "my-workflow/references/task.md")} first.
`;
}

/** A worker's system file (relative to the panel): its task's rules and the user's memory, see start. */
const workerSystemPath = (id: string) => `${DATA}/workers/${id}.md`;

/** Writes task `id`'s worker system file when what it says changed (memory learned since). Returns its path. */
function writeWorkerSystem(ctx: Ctx, id: string, repo: string) {
  const p = workerSystemPath(id);
  const text = (workerProtocol(ctx, id) + forWorker(ctx, repo)).replace(/^\s*-{3,}\s*/, "").trim() + "\n";
  const st = ctx.fs.stat(p);
  if (!st || ctx.fs.read(p) !== text) ctx.fs.write(p, text, st ? { etag: st.etag } : undefined);
  return p;
}

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


// ---- called by the page and the panel's agent ----

/**
 * Every task with its worker's live state, after applying worker replies not seen yet.
 * `column` is where the board shows it: you (needs the user), review, active, done.
 * `{ id: "t12" }`: only that task and what belongs to it (its members, the user's steps they asked for), for an agent
 * asking about one task: the whole board is tens of thousands of characters. Syncing still covers every task.
 */
export async function list(input: unknown, ctx: Ctx) {
  await startUnblocked(ctx);
  const live: Record<string, any> = {};
  const { store } = load(ctx);
  // Read sessions outside the write: ctx.sessions.get is cheap, but keep the locked part small
  // Done ones too: the user may give a finished worker more to do in its chat (below)
  for (const t of store.tasks) if (t.session && t.status !== "dropped") live[t.session] = ctx.sessions.get(t.session);
  // Sessions the workers handed work to (reportTo / parent / a task tag), here or on another computer: waits of their
  // task (_waits.ts syncSessions)
  const all = ctx.sessions.list() as (Session & { parent?: string; reportTo?: string })[];
  const kidsOf = (t: Task) =>
    helpers(t, all).map((k: any) => ({
      id: k.id,
      title: k.title,
      status: k.status,
      waiting: k.waiting,
      waitingKind: k.waitingKind,
      // Waits on the user: an approval, or a question its worker left unanswered
      user: k.status === "waiting" && (k.waitingKind !== "ask" || askLeft(k, t.session ? live[t.session] : null)),
    }));
  const kids: Record<string, ReturnType<typeof kidsOf>> = {};
  for (const t of store.tasks) if (t.owner === "agent" && t.status !== "done" && t.status !== "dropped") kids[t.id] = kidsOf(t);
  const nudge: { session: string; id: string; out: string[]; reply?: boolean }[] = [];
  // Answers to questions the secretary passed on (tasks.message): into its chat, where the user asked
  const answered: { id: string; asked: string; text: string }[] = [];
  const s = update(ctx, (s) => {
    nudge.length = 0; // update retries this function on a write race: decide afresh each time
    answered.length = 0;
    for (const t of s.tasks) {
      const sess = t.session && live[t.session];
      // The user wrote to a finished worker in its chat and it's at it again (t54, 2026-11-05: "把这个做了" after it
      // was done, the card stayed in 已完成): the task is going again. Only the user's own message: code waking a
      // parked worker (a follow-up) decides that itself (wake resume).
      if (t.status === "done" && t.owner === "agent" && sess?.status === "running" && t.doneAt) {
        const said = (sess as any).personSaid as { at: number } | undefined;
        if ((said?.at ?? 0) > t.doneAt || (sess.byPerson && (sess.turnStartedAt ?? 0) > t.doneAt)) {
          Object.assign(t, { status: "running", doneAt: undefined, updatedAt: Date.now() });
          // Its requirement was closed with it: open again, without judging the lead's own (idle) session afresh
          const root = reqOf(s, t);
          if (root && root !== t && root.status === "done") {
            Object.assign(root, { status: "running", doneAt: undefined, updatedAt: Date.now() });
            const rs = root.session && live[root.session];
            if (rs) root.synced = rs.updatedAt;
          }
        }
      }
      // What the user typed in its chat (Gerdr's personSaid): the feed shows it, or the lines after it make no sense
      // (t52: "等扶摇审批" with nothing saying the user asked for 扶摇)
      const ps = (sess as any)?.personSaid as { text: string; at: number } | undefined;
      if (ps?.at && ps.at > (t.heard ?? t.createdAt) && ps.text.trim()) {
        t.heard = ps.at;
        activity(s, t, { kind: "user", by: t.id, text: `你在对话里说：${ps.text.trim()}`, at: ps.at } as any);
      }
      syncSessions(t, kids[t.id] ?? []);
      syncAgents(t, t.session, (sess?.tasks ?? []) as any[]);
      if (sess?.status === "running") {
        // The worker is at it again — the user answered in its chat, something woke it, or it carried on. What it asked
        // the user before this turn, and what it waited on outside, are no longer the state of things; it asks or
        // waits again if it must. A result waiting for review is being reworked.
        const turn = sess.turnStartedAt ?? 0;
        for (const w of endWaits(t, (w) => w.kind === "user" && !w.item && w.since < turn, "在对话里回复了")) note(t, `问：${w.what}\n（在对话里回复了）`);
        endWaits(t, (w) => isOutside(w) && w.since < turn, "接着做了");
        // Only a review reported before this turn: one reported in this very turn (task_update, then a closing line) is
        // the turn's result, not rework — taking it back made the worker report it again and again (t41, 2026-11-10)
        if (t.status === "review" && (t.reportedAt ?? 0) < turn) Object.assign(t, { status: "running", updatedAt: Date.now() });
      }
      // Stopped by the user (or Gerdr restarting): theirs, not a worker that went quiet. No "it stopped without
      // reporting" for them to answer, and no reminder — a reminder would start it again against their stop
      const cancelled = (sess as any)?.stopReason === "cancelled";
      if (cancelled && sess.status === "idle") endWaits(t, (w) => w.kind === "user" && !w.item && w.what.startsWith(STOPPED_ASK), "你停下了它");
      if (!sess || (sess.status !== "idle" && sess.status !== "error")) continue;
      if (t.synced === sess.updatedAt) continue;
      t.synced = sess.updatedAt;
      // The user spoke to it from the feed and its turn ended without a message back: reminded once to answer with
      // the message tool (they read the feed, not its chat); after that it's left to the checks below
      if (t.asked?.relay && sess.status === "idle" && sess.updatedAt > t.asked.at + 1000) {
        // Asked through the secretary: whatever it answered in its reply goes to the secretary's chat as written
        if (!cancelled) answered.push({ id: t.id, asked: t.asked.relay, text: [t.asked.said, String(sess.reply ?? "").trim()].filter(Boolean).join("\n\n") });
        t.asked = undefined;
      } else if (t.asked && sess.status === "idle" && sess.updatedAt > t.asked.at + 1000 && !cancelled) {
        if (!t.asked.nudged) {
          t.asked.nudged = true;
          nudge.push({ session: sess.id, id: t.id, out: [], reply: true });
          t.updatedAt = Date.now();
          continue;
        }
        t.asked = undefined;
      }
      const b = lastBlock(sess.reply ?? "");
      // The user asked it something in its chat and it answered: they're reading that answer and will carry on, so
      // "review" (come and look) means nothing here; the task stays where it is with the new summary. done /
      // question / blocked still apply: they say something changed or is needed.
      if (b && sess.byPerson && b.state === "review" && t.status === "running") applyBlock(s, t, { ...b, state: undefined });
      else if (b) applyBlock(s, t, b);
      else if (t.status === "running" && sess.status === "idle" && !settled(t) && !cancelled && !busyBehind(sess) && t.assigned?.state !== "delivered") {
        // Its turn ended and it waits on nothing: its turn is over, so it's the user's to look at (待验收), with what it
        // said last as the card's line. No reporting (2026-11-12, the user: workers say things in their reply; the
        // task panel reads the session). The one thing it is still reminded of: work it handed to another session
        // with nobody waiting on it (wait_for), which nothing would wake it for.
        const out = open(t).filter((w) => w.kind === "session");
        if (out.length && (t.nudges ?? 0) < 1) {
          t.nudges = (t.nudges ?? 0) + 1;
          nudge.push({ session: sess.id, id: t.id, out: out.map((w) => w.what.replace(/^它派出的/, "")) });
        } else {
          const said = firstWords(String(sess.reply ?? ""));
          Object.assign(t, { status: "review", reportedAt: Date.now(), ...(said ? { summary: said } : {}) });
        }
      }
      t.updatedAt = Date.now();
    }
    dropOrphans(s);
    return s;
  });
  for (const n of nudge) {
    const fold = n.reply ? "[任务面板] 提醒：用户在等你回话" : "[任务面板] 提醒：派出去的活要用 wait_for 等着";
    await ctx.sessions
      .send(
        n.session,
        n.reply
          ? `[任务面板] 用户在等你回话（任务 ${n.id}）：在回复里答他。`
          : `[任务面板] 你把活派出去了，但没有等它（任务 ${n.id}）：${n.out.join("；")}。照 task.md「等别人」用 wait_for 等它（带超时），然后结束这一轮。`,
        { fold } as any,
      )
      .catch(() => {});
  }
  // Workers' system files follow the user's memory (a worker restarted later reads what was learned since)
  for (const t of s.tasks) if (t.owner === "agent" && t.session && t.repo && t.status !== "done" && t.status !== "dropped" && ctx.fs.stat(workerSystemPath(t.id))) writeWorkerSystem(ctx, t.id, t.repo);
  // A reminded worker is running again: its card is back in 进行中 now, not on the next refresh
  for (const n of nudge) live[n.session] = ctx.sessions.get(n.session) ?? live[n.session];
  await closeRouters(ctx, live);
  sweep(ctx);
  const tasks = s.tasks.map((t) => {
      const sess = t.session ? live[t.session] : null;
      const halted = stopped(t, sess);
      // What it last said, for any card that has it stopped (or asking about a stop): its last paragraph, without
      // Gerdr's note on how the turn ended (that's stopWhy)
      const idle = sess && (sess.status === "idle" || sess.status === "error");
      const said = idle && (halted || question(t)?.startsWith(STOPPED_ASK)) ? lastWords(String(sess?.reply ?? "")) : "";
      const ks = kids[t.id] ?? [];
      return {
        ...t,
        // The open waits, each with what wakes it in words (the 在等 list, the card); ended ones stay in t.waits
        waits: open(t).length ? open(t).map((w) => ({ ...w, wake: wakeText(w) })) : undefined,
        // The open question to the user, for the card (a wait too: _waits.ts question)
        question: question(t),
        // The sessions it handed work to, for the card's chips (each is a wait as well)
        helpers: ks.length ? ks.map((k) => ({ id: k.id, title: k.title, status: k.status, waiting: k.waiting, waitingKind: k.waitingKind, left: k.user })) : undefined,
        live: sess ? { status: sess.status, waiting: sess.waiting, waitingSince: sess.waitingSince, turnStartedAt: sess.turnStartedAt, updatedAt: sess.updatedAt, error: sess.error, title: sess.title } : null,
        column: column(s, t, sess),
        ready: blockersDone(s, t),
        // Stopped with nothing to wait on (shown under 等你): what it last said, for the card
        stopped: halted || undefined,
        stopWhy: halted ? stopWhy(t, sess, s) : undefined,
        said: said || undefined,
      };
    });
  // What waits on the user, in Gerdr's inbox too (_inbox.ts): each member and step on its own, as before
  tellInbox(ctx, tasks as any);
  // The secretary's side (_main.ts): its finished reply into the conversation, and news of what newly needs the user.
  // Here because the board's sync runs every minute with or without the page open; a failure mustn't break the board.
  // Task changes aren't sent to the secretary any more (2026-11-11, the user: the board is where they work, the secretary
  // helps; it looks at tasks when a schedule asks it to, secretary.checkStuck)
  for (const a of answered)
    await toMain(ctx, [`[${a.id} 的回答]（用户问的：${a.asked.length > 80 ? a.asked.slice(0, 80) + "…" : a.asked}）\n\n${a.text || "（它这一轮没说话）"}`], "notice", undefined, false).catch((err: any) =>
      ctx.log(`${a.id} 的回答没转给秘书：${err?.message ?? err}`),
    );
  const board = teams(s, tasks);
  const id = (input as { id?: string } | null)?.id;
  if (!id) return { tasks: board, at: Date.now() };
  if (!board.some((t) => t.id === id)) throw new Error(`没有 ${id}`);
  // The task, the requirement it is in, and everything in that requirement
  const root = (board.find((t) => t.id === id) as any)?.in ?? id;
  return { tasks: board.filter((t: any) => t.id === root || t.in === root || t.id === id), at: Date.now() };
}

/**
 * Every agent task is a requirement card (DESIGN.md「需求和队友」), alone or with members: its members and the user's
 * steps they asked for carry `in` (the requirement's id) and the page folds them into its card; the requirement's
 * `teamColumn` is the most pressing of theirs — any of them waiting on the user puts the card under 等你.
 */
function teams<T extends Task & { column: string }>(s: Store, tasks: T[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rank = { you: 3, review: 2, active: 1, done: 0 } as Record<string, number>;
  const out = tasks.map((t) => {
    const root = reqOf(s, t);
    return root && root.id !== t.id ? { ...t, in: root.id } : t;
  });
  return out.map((t: any) => {
    if (t.in || t.owner !== "agent") return t;
    const mine = out.filter((x: any) => x.in === t.id);
    // A member's result for review counts as the card's too: the user judges it either way
    let col = t.column;
    if (col !== "done") for (const x of mine) if ((rank[x.column] ?? 0) > (rank[col] ?? 0)) col = x.column;
    // Its last change: its own, a member's, or its feed's latest line (kept in the members' parts, not on it)
    t.updatedAt = Math.max(t.updatedAt, ...mine.map((x: any) => x.updatedAt ?? 0), ...(t.activity ?? []).map((a: any) => a.at));
    return { ...t, teamColumn: col, members: members(s, byId.get(t.id)!).map((m) => m.id) };
  });
}

/** The board's own question when a worker stops without reporting (older tasks have it): told apart from a real one. */
/** Kept to recognize the question older tasks still have open (before 2026-11-12 a worker stopping unreported got it). */
const STOPPED_ASK = "Worker 停下了，但没在看板上汇报进展";

/** Gerdr's note at the end of a reply on how the turn ended (lastReply in its workhost.go): not the worker's words. */
const ENDING = /^(这一轮结束：|Turn ended: |出错：|Error: )/;

/**
 * A reply's first paragraph, whitespace folded, cut to 200 characters: the card's line for a worker whose turn ended
 * (its conclusion usually leads; Gerdr's note on how the turn ended is skipped).
 */
export function firstWords(reply: string) {
  const p = reply.split(/\n\s*\n/).map((x) => x.replace(/\s+/g, " ").trim()).find((x) => x && !ENDING.test(x)) ?? "";
  return [...p].length > 200 ? [...p].slice(0, 200).join("") + "…" : p;
}

/** The worker's last paragraph, whitespace folded, its end kept when long (the card shows two lines). */
export function lastWords(reply: string) {
  const ps = reply.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p && !ENDING.test(p));
  const p = ps[ps.length - 1] ?? "";
  return [...p].length > 240 ? "…" + [...p].slice(-240).join("") : p;
}

/** Why a worker stopped with nothing going on, for the card: the user's stop, a restart, an error, or nothing said. */
/**
 * Its last word in the feed is a message to the user, after the user last spoke: it answered and waits for them. Not
 * "stopped without a report" (no reminder); under 等你 as having answered.
 */
function repliedLast(s: Store, t: Task) {
  const feed = reqOf(s, t)?.activity ?? [];
  const mine = feed.filter((a) => a.by === t.id).pop();
  const user = Math.max(0, ...feed.filter((a) => a.kind === "user").map((a) => a.at));
  return mine?.kind === "message" && mine.at >= user;
}

function stopWhy(t: Task, sess: any, s?: Store) {
  if (sess?.status === "error") return `出错了${sess.error ? `：${sess.error}` : ""}`;
  if (sess?.stopReason === "cancelled") {
    const err = String(sess.reply ?? "").split(/\n\s*\n/).reverse().find((p) => /^(出错：|Error: )/.test(p.trim()));
    return err ? err.trim().replace(/^(出错：|Error: )/, "") : "你停下了它";
  }
  if (sess?.stopReason && sess.stopReason !== "end_turn") return `这一轮没正常结束（${sess.stopReason}）`;
  if (!sess) return "对话关掉了";
  if (s && repliedLast(s, t)) return "回了你的话，等你接着说";
  return "停下了";
}

/**
 * Brings the board up to date and tells Gerdr's inbox what waits on the user (list does both; _inbox.ts). On a
 * schedule (schedules/inbox.json), so a task that starts waiting on the user reaches the inbox and the phone without
 * the board being open.
 */
export async function sync(input: unknown, ctx: Ctx) {
  const r = await list(input, ctx);
  return { you: r.tasks.filter((t) => t.column === "you").map((t) => t.id) };
}

/**
 * A worker that reports through the tools stopped, its task still running, with nothing to wait on: whether it reported
 * "working" on the way doesn't matter (t30). A turn the user started in its chat counts too: they say a few words, close
 * the chat and don't come back to it — what the answer left open must be on the board as well.
 */
/**
 * The states a worker may stop in (2026-11-06, the user: an agent that stops is either waiting or done — nothing in
 * between). Done / review are its status; while running, one of:
 * - waiting on the user: a question, a step it asked for, an approval its helper needs (a wait with user);
 * - waiting on something outside with a deadline: wait_for, which always has a time item (waits.ts);
 * - its own subagents / background commands still going: Claude Code wakes it when they finish;
 * - another board task it's blocked by: that one finishing wakes it.
 * Work handed to a session it started is none of these by itself: the session reporting back is all that would wake
 * it, and one stuck or on a computer gone offline never does — the hander waits for it with wait_for, timeout and all.
 */
function settled(t: Task) {
  return open(t).some((w) => w.user || w.kind === "time" || w.kind === "agent" || w.kind === "task");
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
    Object.assign(h, { status: "dropped", orphaned: Date.now(), doneAt: Date.now(), updatedAt: Date.now() });
  }
}

/**
 * Where the board shows a task. For an agent task it follows from its waits (_waits.ts), nothing else: one waiting
 * on the user here (not through a board item of its own) → 等你; the worker running, or anything still awaited → 进行中; neither → it stopped with nothing
 * going on, and that's the user's to look at (等你) — never a card in 进行中 with nothing going on.
 */
function column(s: Store, t: Task, sess: any): "you" | "review" | "active" | "done" {
  if (t.status === "done" || t.status === "dropped") return "done";
  if (t.status === "review") return "review";
  // Asked of the user by someone: theirs to agree to. Delivered: whoever asked has it now
  if (t.assigned?.state === "ask") return "you";
  if (t.assigned?.state === "delivered") return "active";
  if (t.owner === "human") return blockersDone(s, t) ? "you" : "active";
  if (sess?.status === "waiting" || sess?.status === "error") return "you";
  // Waiting on the user right here (a question, a helper's approval): its card is what they act on. A step / question
  // of theirs that's a board item of its own is that item's card under 等你; this task stays in 进行中, "等 tN"
  if (open(t).some((w) => w.user && !w.item)) return "you";
  if (stopped(t, sess)) return "you";
  return "active";
}

/**
 * A command its worker left running in the background (a render, a long build): when it ends the agent is woken with
 * its result, so the worker is waiting on it, not stopped (t47, 2026-11-10: "两条成片正在后台渲染" was put under
 * 等你 as stopped without a report). Once it ends and the worker still says nothing, the usual checks apply.
 */
function busyBehind(sess: any) {
  return !!sess?.tasks?.some((k: any) => k.background && k.status === "running");
}

/** Its worker isn't running and the task waits on nothing. */
function stopped(t: Task, sess: any) {
  if (t.owner !== "agent" || t.status !== "running") return false;
  if (sess && (sess.status === "running" || sess.status === "starting")) return false;
  if (busyBehind(sess)) return false;
  return !open(t).length;
}

/** A helper's question its worker didn't take: it has stopped since the question came, or two minutes went by. */
function askLeft(k: any, sess: any) {
  const since = k.waitingSince ?? 0;
  const workerBusy = sess && (sess.status === "running" || sess.status === "starting");
  if (workerBusy) return false;
  return (sess?.updatedAt ?? 0) > since + 2000 || Date.now() - since > 120_000;
}

/**
 * Sessions a task's workers handed work to that are still going (running, starting, or waiting for the user): the
 * ones reporting back to a worker, started by one, or carrying the task's tag — here or on another computer.
 */
function helpers(t: Task, all: (Session & { parent?: string; reportTo?: string })[]) {
  if (t.owner !== "agent") return [];
  const mine = new Set([t.session, ...(t.sessions ?? [])].filter(Boolean) as string[]);
  return all.filter(
    (x) =>
      !mine.has(x.id) &&
      (x.status === "running" || x.status === "starting" || x.status === "waiting") &&
      ((x.reportTo && mine.has(x.reportTo)) || (x.parent && mine.has(x.parent)) || x.tags?.task === t.id),
  );
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
  // @-mentions in the text (the board's input box, the panel's agent writing "@design …"): who the router hands it to.
  // One mention and no agent given is simply the agent.
  if (rest.owner !== "human" && !rest.mentions && rest.prompt?.includes("@")) {
    const m = mentionsIn(rest.prompt, await allAgents(ctx));
    if (m.length) rest.mentions = m;
  }
  if (rest.mentions?.length === 1 && !rest.agent) rest.agent = rest.mentions[0];
  const t = update(ctx, (s) => newTask(s, { ...rest, title, id: undefined } as any));
  if (go && t.owner === "agent") {
    // Blocked by something still going: started by the board once it's done (startUnblocked), not now
    if (!blockersDone(load(ctx).store, t)) return edit({ id: t.id, startWhenFree: true }, ctx);
    return start({ id: t.id }, ctx);
  }
  return t;
}

/**
 * Tasks added to start once what they're blocked by is done (startWhenFree): started now that it is, with what those
 * came to in the prompt (their summaries and links), so a split's later part picks up from the earlier one.
 */
async function startUnblocked(ctx: Ctx) {
  const { store } = load(ctx);
  for (const t of store.tasks) {
    if (!t.startWhenFree || t.owner !== "agent" || t.status !== "todo" || t.session || !blockersDone(store, t)) continue;
    const before = (t.blockedBy ?? [])
      .map((id) => store.tasks.find((x) => x.id === id))
      .filter((x): x is Task => !!x && x.owner === "agent")
      .map((x) => [`- ${x.id}「${x.title}」${x.status === "dropped" ? "放弃了" : "做完了"}${x.summary ? `：${x.summary}` : ""}`, ...(x.links ?? []).map((l) => `  - ${l.label ?? "链接"}：${l.url}`), x.session ? `  - 它的对话：gerdr session read ${x.session}` : ""].filter(Boolean).join("\n"));
    edit({ id: t.id, startWhenFree: undefined }, ctx);
    const prompt = before.length ? `${t.prompt ?? t.title}\n\n## 你等的任务\n${before.join("\n")}` : undefined;
    await start({ id: t.id, prompt }, ctx).catch((e: any) => {
      ctx.log(`${t.id} 等的任务做完了，但没派出去：${e?.message ?? e}`);
      update(ctx, (s) => note(find(s, t.id), `等的任务做完了，自动派出失败：${e?.message ?? e}`));
    });
  }
}

/**
 * The task's artifacts folder (Gerdr's docs/dev/ARTIFACTS.md): where its work leaves what isn't committed — drafts,
 * images, videos, reports, copy to publish — and its records (a PR, a folder made elsewhere, a short text), under
 * ~/Gerdr/<project>/任务/<title>/ where the user finds it in Finder. Created the first time something goes in; the
 * worker gets it as its artifactsDir, the drawer shows it (文件). null on a Gerdr without ctx.artifacts. { id }
 */
export function folder(input: { id: string }, ctx: Ctx): { path: string; exists: boolean } | null {
  const a = (ctx as any).artifacts;
  if (!a) return null;
  const t = find(load(ctx).store, input.id);
  return a.folder({ key: t.id, name: t.title || t.id, under: "任务" });
}

/** Changes fields of a task: { id, ...fields }. */
export function edit(input: Partial<Task> & { id: string }, ctx: Ctx) {
  // Renamed: its folder follows (when it has one and the new name is free), as the user's Annulo content folders do
  if (input.title && (ctx as any).artifacts) {
    const before = find(load(ctx).store, input.id).title;
    if (before !== input.title) {
      try {
        (ctx as any).artifacts.rename(input.id, input.title);
      } catch (err: any) {
        ctx.log(`任务文件夹改名失败：${err?.message ?? err}`);
      }
    }
  }
  return update(ctx, (s) => {
    const t = find(s, input.id);
    const { id, createdAt, ...rest } = input as any;
    // Marked done here (a board task that was only an instruction, carried out): when, as every other way to done does
    if ((rest.status === "done" || rest.status === "dropped") && !t.doneAt) rest.doneAt = Date.now();
    Object.assign(t, rest, { updatedAt: Date.now() });
    return t;
  });
}

/**
 * Hands an agent task to a new worker session: in its repository (or a git worktree of it), told the task and the
 * reply protocol, reporting to the panel's agent. { id, prompt?, repo?, agent?, model?, effort?, worktree?, mode? }
 * Agent / model / effort not given: the task's, else the user's worker defaults (设置), else Gerdr's.
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
    // The user doesn't pick repositories: the panel's agent knows the projects and decides. A second start without a repo
    // (the panel's agent itself forgetting it) is an error instead of another round trip.
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
  // Its rules and the user's memory go to its system prompt (a file Gerdr re-reads when the agent starts again), not
  // its first message: that one is the user's own words, shown whole in the chat they read (2026-11-12, the user: "我肯定
  // 是想要看到我发的消息的，下半段才是我不关心的"). Started empty, so we know whether this Gerdr took the file.
  const sys = writeWorkerSystem(ctx, t.id, repo);
  const sess = await ctx.sessions.start({
    cwd,
    ...who,
    title: t.title,
    systemFile: `${ctx.workspace.dir}/${sys}`,
    // What it makes that isn't committed goes in the task's folder (Gerdr names it in the worker's prompt and lets its
    // sandbox write there); an older Gerdr ignores the option and the worker uses its repository's
    artifactsDir: folder({ id: t.id }, ctx)?.path,
    tags: { task: t.id },
    // Followed on the board (its drawer shows the chat), not in Code: no tab of it appears there
    workspace: "none",
    // No reportTo: the user follows the board, not the panel's agent, and the worker updates the board itself (panel
    // tools). A report would only have the panel's agent repeat the worker's reply to nobody, a turn each time.
  } as any);
  // A Gerdr that took the system file says it back; an older one ignored it, so the rules ride on the message as before
  const took = (sess as any).systemFile === `${ctx.workspace.dir}/${sys}`;
  await ctx.sessions.send(sess.id, (prompt || "看附件，照里面的做。") + (took ? "" : workerProtocol(ctx, t.id) + forWorker(ctx, repo)), {
    attachments: (t.attachments ?? []).map((a) => a.path),
    show: true,
  } as any);
  const out = update(ctx, (s) => {
    const x = find(s, t.id);
    Object.assign(x, { status: "running", routing: undefined, prompt, repo, session: sess.id, sessions: [...(x.sessions ?? []), sess.id], updatedAt: Date.now() });
    endQuestions(x, "重新派出去了");
    if (input.agent) x.agent = input.agent;
    if (input.model) x.model = input.model;
    if (input.effort) x.effort = input.effort;
    return x;
  });
  // Work someone asked of the user (assign.ts): whoever asked hears which conversation does it, for following it there
  // when the user shared it (share) and for their words to it
  if (out.assigned && out.origin?.reply) {
    try {
      (ctx as any).events.reply(out.origin, "", { step: "session", panel: ctx.workspace.project, session: sess.id, ...(out.assigned.share !== undefined ? { share: out.assigned.share } : {}) });
    } catch (err: any) {
      ctx.log(`告诉 ${out.origin.source} 对话 id 失败：${err?.message ?? err}`);
    }
  }
  // Its message's sender hears back now that it's out (设置: 回复对方 → 派出去时)
  if (out.ackOnStart) {
    ackOrigin(ctx, out);
    return edit({ id: out.id, ackOnStart: undefined }, ctx);
  }
  return out;
}

/** Tells the person whose message a task came from that it's taken, in the words of 设置 → 回复对方. */
export function ackOrigin(ctx: Ctx, t: Task) {
  if (!t.origin?.reply) return;
  const text = workflow(ctx).ackText.split("{id}").join(t.id).split("{title}").join(t.title);
  try {
    (ctx as any).events.reply({ ...t.origin, at: 0 }, text);
  } catch (err: any) {
    ctx.log(`回复 ${t.origin.source}/${t.origin.kind} 失败：${err?.message ?? err}`);
  }
}

/**
 * Which agent / model / effort a worker runs on. The defaults (设置 → worker) go with their agent: a model named there is
 * that agent's (a claude model means nothing to codex), so a task on another agent only gets a model it names itself.
 */
function workerOf(ctx: Ctx, t: Task, input: { agent?: string; model?: string; effort?: string; mode?: string }) {
  const w = workflow(ctx).worker;
  const agent = input.agent || t.agent || w.agent;
  const same = agent === w.agent;
  return {
    agent: agent || undefined,
    model: input.model || t.model || (same ? w.model : "") || undefined,
    effort: input.effort || t.effort || (same ? w.effort : "") || undefined,
    // Modes are an agent's own words (claude's acceptEdits means nothing to codex): the setting only goes with its agent
    mode: input.mode || (same ? w.mode : "") || undefined,
  };
}

async function tell(ctx: Ctx, t: Task, text: string) {
  if (!t.session) throw new Error(`${t.id} 没有在跑的 agent 会话：先派出去（start）`);
  // Right away even mid-step: a worker running something long in the background still takes the message (DESIGN.md)
  // The user's words passed on: shown whole in the worker's chat (code's messages fold by default)
  await ctx.sessions.send(t.session, text, { now: true, show: true } as any);
}

/** The user accepts the result: done, and the worker is parked (its context kept, a later send wakes it). */
export async function accept(input: { id: string }, ctx: Ctx) {
  let closing: string[] = [];
  const t = update(ctx, (s) => {
    const t = find(s, input.id);
    Object.assign(t, { status: "done", doneAt: Date.now(), updatedAt: Date.now() });
    // The requirement accepted: every member's part with it. A member marked done alone: only that part.
    closing = members(s, t).filter((m) => m.id !== t.id && m.team === t.id && m.status !== "done" && m.status !== "dropped").map((m) => {
      note(m, "需求标为完成了");
      Object.assign(m, { status: "done", doneAt: Date.now(), updatedAt: Date.now() });
      return m.session;
    }).filter((x): x is string => !!x);
    activity(s, t, { kind: "user", by: t.id, text: t.team ? "你把这部分标为完成" : "你标为完成了" });
    return t;
  });
  for (const id of [t.session, ...closing]) if (id && (ctx.sessions as any).close) await (ctx.sessions as any).close(id).catch(() => {});
  return t;
}


/** Sends it back with what's wrong. { id, feedback } */
export async function reject(input: { id: string; feedback: string }, ctx: Ctx) {
  if (!input.feedback?.trim()) throw new Error("写一句哪里不对");
  const t = update(ctx, (s) => {
    const t = find(s, input.id);
    note(t, `打回：${input.feedback.trim()}`);
    activity(s, t, { kind: "user", by: t.id, text: `你打回了：${input.feedback.trim()}` });
    Object.assign(t, { status: "running", updatedAt: Date.now() });
    return t;
  });
  await tell(ctx, t, `验收没通过：${input.feedback.trim()}\n改完在回复里说改了什么。`);
  return t;
}

/** Answers the worker's question (the open question to the user on the task). { id, answer } */
export async function answer(input: { id: string; answer: string }, ctx: Ctx) {
  const ans = input.answer?.trim();
  if (!ans) throw new Error("回答是空的");
  const cur = find(load(ctx).store, input.id);
  if (!cur.session) throw new Error(`${cur.id} 没有在跑的 agent 会话：先派出去（start）`);
  const q = question(cur) ?? "";
  return wake(ctx, input.id, {
    how: `你答了：${ans}`,
    // The user's own words: shown whole in the worker's chat
    fold: false,
    text: `关于你的问题，用户的决定：${ans}`,
    ends: (w) => w.kind === "user" && !w.item,
    also: (t) => note(t, `问：${q}\n答：${ans}`),
    feed: `你答了：${ans}`,
  });
}

/**
 * The user did a human task: { id, value? }. Agent tasks it was blocking and that are now free get told (and woken),
 * with what was handed back; a secret is named, never sent.
 */
export async function complete(input: { id: string; value?: string }, ctx: Ctx) {
  let woken: Task[] = [];
  const h = update(ctx, (s) => {
    const h = find(s, input.id);
    if (h.owner !== "human") throw new Error(`${h.id} 不是人工任务`);
    // Answered already (the chat card and the board both can, and a reloaded card no longer knows): never tell the
    // worker twice
    if (h.status === "done") throw new Error(`${h.id} 已经${h.handBack?.kind === "choice" ? "决定" : "做完"}了${h.handedBack ? `：${h.handedBack}` : ""}`);
    if (h.status === "dropped") throw new Error(`${h.id} 已经不需要了`);
    if ((h.handBack?.kind === "value" || h.handBack?.kind === "choice") && !input.value?.trim()) throw new Error(h.handBack.kind === "choice" ? "选一个，或者写下你的决定" : `要交回：${h.handBack.label || "一个值"}`);
    Object.assign(h, { status: "done", handedBack: input.value?.trim() || undefined, doneAt: Date.now(), updatedAt: Date.now() });
    activity(s, h, { kind: "user", by: h.askedBy, of: h.id, text: `${h.handBack?.kind === "choice" || h.handBack?.kind === "questions" ? "你答了" : "你做完了"}「${h.title}」${h.handBack?.kind === "secret" || !h.handedBack ? "" : `：${h.handedBack}`}` });
    woken = s.tasks.filter((t) => t.owner === "agent" && t.session && t.status === "running" && t.blockedBy?.includes(h.id) && blockersDone(s, t));
    return h;
  });
  let back = "";
  if (h.handBack?.kind === "value") back = `\n交回的${h.handBack.label || "值"}：${h.handedBack}`;
  if (h.handBack?.kind === "secret") back = `\n密钥已存为面板密钥「${h.handBack.name}」（只有面板的本地函数能读，你看不到值）。`;
  const text =
    h.handBack?.kind === "choice"
      ? `你问的「${h.title}」（${h.id}），用户的决定：${h.handedBack}\n照这个接着做。`
      : `人工任务「${h.title}」（${h.id}）用户做完了。${back}\n先按你说的方式核验${h.verify ? `（${h.verify}）` : ""}，没问题再继续；核验不过就用 ask_human 再登记一个，说明哪里不对。`;
  // Its wait on h ended in the write above (_waits.ts sync); this only tells the worker, the one way every wake goes
  for (const t of woken) await wake(ctx, t.id, { how: h.handBack?.kind === "choice" ? `你答了：${h.handedBack}` : "你做完了", text, fold: false });
  return { task: h, woke: woken.map((t) => t.id) };
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

/** Sends a task's worker a message (it wakes if parked): { id, text }. For the user or the panel's agent steering it. */
export async function say(input: { id: string; text: string }, ctx: Ctx) {
  if (!input.text?.trim()) throw new Error("消息是空的");
  const t = find(load(ctx).store, input.id);
  await tell(ctx, t, input.text.trim());
  return { sent: t.id, session: t.session };
}

/**
 * 按最新情况更新: a question the user is asked was put before they and its worker talked on, and may be moot or
 * different now. { id: the step / question item (t5) }. Its worker is woken to ask it again as things stand (ask_human
 * with replaces: it then shows at the bottom of the feed) or take it back; the user doesn't scroll up to answer an old
 * version of it.
 */
export async function refreshAsk(input: { id: string }, ctx: Ctx) {
  const { store } = load(ctx);
  const h = find(store, input.id);
  if (h.owner !== "human" || h.status !== "todo") throw new Error(`${h.id} 已经不在等你了`);
  const w = store.tasks.find((x) => x.id === h.askedBy) ?? store.tasks.find((x) => x.blockedBy?.includes(h.id));
  if (!w?.session) throw new Error(`找不到问这个的 worker`);
  const qs = (h.questions ?? []).filter((q) => !q.dropped && q.answer == null);
  const ids = qs.length ? qs.map((q) => `${h.id}#${q.id}「${q.title}」`).join("、") : `${h.id}「${h.title}」`;
  update(ctx, (s) => Object.assign(find(s, h.id), { refreshing: Date.now() }));
  await wake(ctx, w.id, {
    how: "你请它更新问题",
    text:
      `[任务面板] 用户请你把还在问他的 ${ids} 按现在的情况更新：这些是在你们后来的对话之前问的。\n` +
      `- 还要问但问法变了：ask_human 带 replaces（写上旧的 id）重新问，写清现在的情况和选项；\n` +
      `- 已经不用问了：cancel_human，说明原因；\n` +
      `- 还是原样要问：不用改，用 message_user 说一句「这个问题还是要你定」。\n做完就结束这一轮。`,
    resume: true,
    feed: `你请 ${w.repo?.split("/").pop() || w.id} 按最新情况更新 ${h.id}`,
  });
  return { sent: w.id };
}

/**
 * The user writes to members of a requirement from its drawer, as in a chat: { id (any task of the card), to: [member
 * ids], text, attachments?: [{ path, name }] }. Each one gets it right away (now, even mid-step) and picks the task up
 * again if it had ended; the feed has one line for it. Several at once are each told who else got it, so they don't
 * both act on it. With one member, `to` may be left out.
 */
export async function message(input: { id: string; to?: string[]; text: string; attachments?: { path: string; name?: string }[] }, ctx: Ctx) {
  const text = input.text?.trim() ?? "";
  const files = (input.attachments ?? []).filter((a) => a?.path);
  if (!text && !files.length) throw new Error("消息是空的");
  const { store } = load(ctx);
  const root = reqOf(store, find(store, input.id));
  if (!root) throw new Error(`${input.id} 不是 agent 的任务`);
  const all = members(store, root).filter((m) => m.status !== "dropped" && m.session);
  let to = [...new Set(input.to ?? [])];
  if (!to.length) {
    if (all.length !== 1) throw new Error(`这个需求有 ${all.length} 个成员，要 @ 发给谁（${all.map((m) => m.id).join("、")}）`);
    to = [all[0].id];
  }
  const targets = to.map((id) => {
    const m = all.find((x) => x.id === id);
    if (!m) throw new Error(`${id} 不是这个需求里还在的成员（${all.map((x) => x.id).join("、")}）`);
    return m;
  });
  const name = (m: Task) => m.repo?.split("/").pop() || m.id;
  const list = files.length ? `\n附件：\n${files.map((a) => `- ${a.name ?? a.path.split("/").pop()}：${a.path}`).join("\n")}` : "";
  // The files go with the line (feedFiles): the feed shows them under the words, as the chat does
  const feed = `你对 ${targets.map(name).join("、")} 说：${text}`;
  for (const [i, m] of targets.entries()) {
    const others = targets.filter((x) => x !== m);
    await wake(ctx, m.id, {
      how: "你发了消息",
      fold: false, // the user's question, as they asked it
      text:
        `[任务面板] 用户在秘书那里问你：\n\n${text}${list}`,
      files: files.map((a) => a.path),
      resume: true,
      // One line for all of them, written with the first
      feed: i === 0 ? feed : undefined,
      feedFiles: i === 0 ? files : undefined,
    });
  }
  // Each one's next reply goes back to the secretary's chat, where the user asked (tasks.list sync)
  update(ctx, (s) => {
    for (const m of targets) find(s, m.id).asked = { at: Date.now(), relay: text };
  });
  return { sent: targets.map((m) => m.id) };
}

/** Drops a task (not doing it). { id, reason? } */
export async function drop(input: { id: string; reason?: string }, ctx: Ctx) {
  const closing: string[] = [];
  const t = update(ctx, (s) => {
    closing.length = 0;
    const t = find(s, input.id);
    // A requirement dropped: its members with it (each undone with it too: restore)
    const all = t.team ? [t] : members(s, t);
    for (const x of all) {
      if (x.status === "dropped" || (x !== t && x.status === "done")) continue;
      if (input.reason) note(x, `放弃：${input.reason}`);
      // Kept so it can be undone (restore): a click on 放弃 is easy to make by mistake
      x.droppedFrom = x.status;
      Object.assign(x, { status: "dropped", doneAt: Date.now(), updatedAt: Date.now() });
      if (x.session) closing.push(x.session);
    }
    activity(s, t, { kind: "user", by: t.id, text: `你放弃了${t.team ? "这部分" : ""}${input.reason ? `：${input.reason}` : ""}` });
    return t;
  });
  for (const id of closing) if ((ctx.sessions as any).close) await (ctx.sessions as any).close(id).catch(() => {});
  return t;
}

/**
 * The user tells the router what's wrong with how a card was handed out ("仓库错了，应该在 operation"): { id,
 * feedback }. The router decides what to do with it (superagent.ts boardTask, reroute): another repository, several
 * workers, keep or stop the old ones, or only pass it on to the worker. The user doesn't pick repositories here, as
 * they don't when creating a task. The workers keep going until it decides.
 */
export async function reroute(input: { id: string; feedback: string }, ctx: Ctx) {
  const feedback = input.feedback?.trim();
  if (!feedback) throw new Error("写一下哪里不对，调度照这个重新安排");
  const { store } = load(ctx);
  const root = reqOf(store, find(store, input.id));
  if (!root || root.owner !== "agent") throw new Error(`${input.id} 不是派给 agent 的任务`);
  if (root.status === "todo" && !root.session) throw new Error(`${root.id} 还没派出去：直接改任务内容再派`);
  if (root.status === "done" || root.status === "dropped") throw new Error(`${root.id} 已经${root.status === "done" ? "完成" : "放弃"}了`);
  const lines = members(store, root)
    .filter((m) => m.status !== "dropped" && (m === root || m.status !== "done"))
    .map((m) => {
      const sess = m.session ? ctx.sessions.get(m.session) : undefined;
      const said = lastWords(String((sess as any)?.reply ?? ""));
      return [
        `- ${m.id}${m === root ? "（负责人）" : ""}：仓库 ${m.repo ?? "（无）"}，${m.status}${m.agent ? `，agent ${m.agent}` : ""}`,
        m !== root && m.prompt ? `  它这份：${oneLine(m.prompt, 200)}` : "",
        m.summary ? `  进展：${m.summary}` : "",
        said ? `  最后说：${said}` : "",
        m.session ? `  对话：gerdr session read ${m.session}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    });
  const block = [
    `[重新安排 ${root.id}] ${root.title}`,
    `原始需求：${root.request ?? root.prompt ?? root.title}`,
    `现在的安排：\n${lines.join("\n")}`,
    `用户的反馈：${feedback}`,
    `照反馈重新安排这张卡，item 写 "${root.id}"（parts / attach / stop，见上面的说明）。`,
  ].join("\n");
  update(ctx, (s) => {
    const t = find(s, root.id);
    t.reroute = { feedback, at: Date.now() };
    activity(s, t, { kind: "user", by: t.id, text: `你让调度重新安排：${feedback}` });
  });
  try {
    return await rerouteTask(ctx, root.id, block);
  } catch (e) {
    update(ctx, (s) => (find(s, root.id).reroute = undefined));
    throw e;
  }
}

function oneLine(s: string, n: number) {
  const x = s.replace(/\s+/g, " ").trim();
  return [...x].length > n ? [...x].slice(0, n).join("") + "…" : x;
}

/**
 * A handover takes the old task's steps for the user with it: what it asked them to do is still needed, now by the
 * new one. Until 2026-11-05 they went with the old task: t11 was dropped for t52 to take over, its "approve the
 * release" (t51) was dropped as nothing needed it any more, and the user lost it from 等你 while t52 waited on it.
 * Steps the board dropped for that reason (orphaned) in the last hour come back.
 */
function takeOver(ctx: Ctx, id: string, from: string) {
  update(ctx, (s) => {
    const t = find(s, id);
    const old = find(s, from);
    const hour = Date.now() - 3600_000;
    const steps = s.tasks.filter(
      (h) =>
        h.owner === "human" &&
        (h.askedBy === old.id || old.blockedBy?.includes(h.id)) &&
        (h.status === "todo" || (h.status === "dropped" && (h.orphaned ?? 0) > hour)),
    );
    for (const h of steps) {
      if (h.status === "dropped") {
        note(h, `${t.id} 接手了 ${old.id}，这一步还要做`);
        Object.assign(h, { status: "todo", orphaned: undefined, doneAt: undefined });
      }
      Object.assign(h, { askedBy: t.id, updatedAt: Date.now() });
      if (!t.blockedBy?.includes(h.id)) t.blockedBy = [...(t.blockedBy ?? []), h.id];
      old.blockedBy = (old.blockedBy ?? []).filter((x) => x !== h.id);
    }
    // The card's first line: whose work this goes on with (the feed used to start at its first wait)
    activity(s, t, { kind: "join", by: t.id, text: `接手了 ${old.id}「${old.title}」${steps.length ? `，连同要你做的：${steps.map((h) => `${h.id} ${h.title}`).join("；")}` : ""}` });
  });
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
 * Undoes 放弃: { id } — back to where it was (its worker's conversation was only closed: the next message opens it
 * again, and a session it handed work to still reports back to it).
 */
export function restore(input: { id: string }, ctx: Ctx) {
  return update(ctx, (s) => {
    const t = find(s, input.id);
    if (t.status !== "dropped") throw new Error(`${t.id} 没有被放弃`);
    for (const x of t.team ? [t] : members(s, t)) {
      if (x.status !== "dropped" || (x !== t && !x.droppedFrom)) continue;
      note(x, "恢复了（撤销放弃）");
      Object.assign(x, { status: x.droppedFrom ?? (x.owner === "human" ? "todo" : x.session ? "running" : "todo"), droppedFrom: undefined, doneAt: undefined, updatedAt: Date.now() });
    }
    return t;
  });
}

/**
 * No repository given: the Superagent's main session picks one (and the agent, the model, a split into parallel
 * parts) and sends it out with tasks.dispatch. The prompt is saved first, so a failed hand-off leaves a plain
 * todo to dispatch again.
 */
async function route(id: string, prompt: string, ctx: Ctx) {
  update(ctx, (s) => Object.assign(find(s, id), { prompt, updatedAt: Date.now() }));
  return routeTask(ctx, id);
}

type Part = { repo: string; agent?: string; model?: string; effort?: string; worktree?: boolean; title?: string; prompt?: string };

/**
 * Sends a task out in one go, as the router decided: { id, title?, parts: [{ repo, agent?, model?, effort?, worktree?,
 * title?, prompt? }] }. One part is the task itself. Several run in parallel: the first stays this task (its title /
 * prompt narrowed to that part), each other one becomes a new task split off it (`from`), with the same attachments.
 * from: a task this one takes over (usually just dropped with tasks.drop): its progress and conversation go in the prompt.
 */
export async function dispatch(input: { id: string; title?: string; parts: Part[]; from?: string }, ctx: Ctx) {
  const parts = input?.parts ?? [];
  if (!parts.length) throw new Error(`parts 至少一份：{"id":"${input?.id}","parts":[{"repo":"/绝对路径"}]}`);
  for (const p of parts) {
    if (!p?.repo?.trim()) throw new Error("parts 里每一份都要有 repo（仓库绝对路径）");
    if (!ctx.dirs.stat(p.repo)?.dir) throw new Error(`仓库目录不存在：${p.repo}`);
  }
  const split = parts.length > 1;
  if (split && parts.some((p) => !p.prompt?.trim())) throw new Error("拆成几份时每份都要写 prompt：这一份做什么");
  // A handover ("关闭 t11，新建一个任务来交接"): this task takes over `from`, told how far it got — in its prompt, or
  // in the first part's when split (that is what its worker is told then). Once: a retry finds `from` already set.
  if (input?.from) {
    if (input.from === input.id) throw new Error("from 是它要接手的那个任务，不是它自己");
    const old = find(load(ctx).store, input.from);
    const t = find(load(ctx).store, input.id);
    const told = handover(old, lastWords(String((old.session && ctx.sessions.get(old.session)?.reply) ?? "")));
    if (split) parts[0] = { ...parts[0], prompt: `${parts[0].prompt}\n\n${told}` };
    else if (t.from !== old.id) edit({ id: t.id, prompt: `${t.prompt ?? t.title}\n\n${told}` }, ctx);
    edit({ id: t.id, from: old.id }, ctx);
    takeOver(ctx, t.id, old.id);
  }
  const { store } = load(ctx);
  const t = find(store, input.id);
  const [first, ...rest] = parts;
  // Split: the title narrows to the first part (each part is a task of its own)
  const title = (split ? first.title : undefined) || input.title;
  if (title) edit({ id: t.id, title }, ctx);
  const out: Task[] = [await start({ id: t.id, repo: first.repo, agent: first.agent, model: first.model, effort: first.effort, worktree: first.worktree, prompt: split ? first.prompt : undefined }, ctx)];
  const errors: string[] = [];
  for (const p of rest) {
    try {
      out.push(
        (await add(
          { title: p.title, prompt: p.prompt, repo: p.repo, agent: p.agent, model: p.model, effort: p.effort, worktree: p.worktree, attachments: t.attachments, from: t.id, router: t.router, routerClosed: true, start: true },
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

/**
 * Where a task came from and where it went, for an agent looking back (or tuning how work is handed out):
 * { id } → the event it came from, the conversation that dispatched it, its workers' conversations (oldest first),
 * the task it was split off and the ones split off it. Read a conversation with `gerdr session read <id>`. The
 * sessions those workers started in turn (any depth) are in tasks.tree.
 */
export function trace(input: { id: string }, ctx: Ctx) {
  const { store } = load(ctx);
  const t = find(store, input.id);
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    origin: t.origin ? { source: t.origin.source, kind: t.origin.kind, key: t.origin.key, title: t.origin.title, url: t.origin.url } : undefined,
    from: t.from,
    router: t.router,
    workers: t.sessions ?? (t.session ? [t.session] : []),
    splits: store.tasks.filter((x) => x.from === t.id).map((x) => ({ id: x.id, title: x.title, status: x.status })),
    followups: t.followups?.length ?? 0,
  };
}

type TreeNode = {
  /** A session's id; a subagent's is "<session>#<toolCallId>" (SessionChat shows it with sub). */
  id: string;
  title: string;
  agent: string;
  status: string;
  role: "router" | "worker" | "helper" | "subagent";
  children: TreeNode[];
};

/** A session's subagents (Claude Code's, its tasks of type local_agent) as tree nodes, nested by who started whom. */
function subagents(session: any): TreeNode[] {
  const ts = ((session?.tasks ?? []) as any[]).filter((x) => x.type === "local_agent" && x.toolCallId);
  const of = (parent?: string): TreeNode[] =>
    ts
      .filter((x) => (x.parent || undefined) === parent)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      .map((x) => ({
        id: `${session.id}#${x.toolCallId}`,
        title: x.description || x.subagent || "子 agent",
        agent: x.subagent ?? "",
        status: x.status === "running" ? "running" : "idle",
        role: "subagent" as const,
        children: of(x.toolCallId),
      }));
  return of(undefined);
}

/**
 * The conversations behind a task as a tree, any number of levels deep: its router and workers, and every session
 * they started (Gerdr records each session's parent), down to helpers of helpers. `up`: who handed out the task
 * itself (the chain above its router: the panel's agent that called tasks.add, …). For the drawer's 链路.
 */
export function tree(input: { id: string }, ctx: Ctx) {
  const { store } = load(ctx);
  const t = find(store, input.id);
  const all = ctx.sessions.list() as (Session & { parent?: string })[];
  const byId = new Map(all.map((x) => [x.id, x]));
  const kids = new Map<string, string[]>();
  for (const x of all) if (x.parent) kids.set(x.parent, [...(kids.get(x.parent) ?? []), x.id]);
  const workers = new Set(t.sessions ?? (t.session ? [t.session] : []));
  const mainRoot = isMain(ctx, t.router);
  const seen = new Set<string>();
  const node = (id: string, depth: number): TreeNode | null => {
    if (seen.has(id) || depth > 12) return null;
    seen.add(id);
    const x = byId.get(id);
    // The Superagent's main session dispatches every task: under it, only this task's own workers
    const children = (kids.get(id) ?? [])
      .filter((k) => id !== t.router || !mainRoot || workers.has(k))
      .map((k) => node(k, depth + 1))
      .filter((n): n is TreeNode => !!n)
      .sort((a, b) => (byId.get(a.id)?.createdAt ?? 0) - (byId.get(b.id)?.createdAt ?? 0));
    // Its subagents first (the work it does itself, in parallel), then the sessions it handed work to
    return { id, title: x?.title || id, agent: x?.agent ?? "", status: x?.status ?? "gone", role: id === t.router ? "router" : workers.has(id) ? "worker" : "helper", children: [...subagents(x), ...children] };
  };
  // Roots: the router, then any worker not under it (started by the board itself, re-dispatched by hand)
  const roots = [t.router, ...workers].filter((id): id is string => !!id).map((id) => node(id, 0)).filter((n): n is TreeNode => !!n);
  const up: { id: string; title: string }[] = [];
  for (let p = roots[0] && byId.get(roots[0].id)?.parent; p && up.length < 12 && !up.some((u) => u.id === p); p = byId.get(p)?.parent) {
    up.unshift({ id: p, title: byId.get(p)?.title || p });
  }
  return {
    origin: t.origin ? { source: t.origin.source, kind: t.origin.kind, title: t.origin.title, url: t.origin.url } : undefined,
    from: t.from ? { id: t.from, title: store.tasks.find((x) => x.id === t.from)?.title ?? "" } : undefined,
    splits: store.tasks.filter((x) => x.from === t.id).map((x) => ({ id: x.id, title: x.title })),
    up,
    roots,
  };
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
      if (!t.router || t.routerClosed || (t.status === "todo" && t.routing)) continue; // still being routed
      if (isMain(ctx, t.router)) continue; // the Superagent's main session: it stays for the next one
      const r = live[t.router] ?? ctx.sessions.get(t.router);
      if (r && r.status !== "idle" && r.status !== "error") continue; // still finishing its turn
      out.push(t.router);
      // Closed, not forgotten: t.router stays, so the task can always be traced back to the conversation that
      // dispatched it (the drawer's 链路, tasks.trace) — for tuning the rules, and for a look back.
      t.routerClosed = true;
    }
    return out;
  });
  for (const id of done) await ctx.sessions.close(id).catch(() => {});
}

/** Where one task stands, cheaply (the chat's task-step card asks for it): status, and what the user handed back. */
export function status(input: { id: string }, ctx: Ctx) {
  const { store } = load(ctx);
  // "t5#2": one question of a task asking several (the chat has a card per question)
  const [tid, qid] = splitRef(String(input?.id ?? ""));
  const t = store.tasks.find((x) => x.id === tid);
  if (!t) return { status: "missing" };
  if (qid) {
    const q = t.questions?.find((x) => x.id === qid);
    if (!q) return { status: "missing" };
    const status = q.dropped || t.status === "dropped" ? "dropped" : q.answer ? "done" : "todo";
    return { status, title: q.title, handedBack: q.answer, kind: q.kind, reason: q.dropped };
  }
  const back = t.handBack?.kind === "secret" ? undefined : t.handedBack;
  return { status: t.status, title: t.title, handedBack: back, kind: t.handBack?.kind, reason: t.dropReason };
}

/**
 * Answers one question of a task asking several: { id, q, value }. The answers wait on the task until every question
 * has one; then the task is done and the worker hears them all in one message. Answering one again changes it: before
 * the rest are answered nobody has acted on it yet; after, the worker is told what changed.
 */
export async function answerQuestion(input: { id: string; q: string; value: string }, ctx: Ctx) {
  const value = input?.value?.trim();
  if (!value) throw new Error("选一个，或者写下你的答案");
  let changed: { q: Question; old: string } | null = null;
  let finished = false;
  const h = update(ctx, (s) => {
    const h = find(s, input.id);
    const q = h.questions?.find((x) => x.id === String(input.q));
    if (!q) throw new Error(`${h.id} 没有第 ${input.q} 个问题`);
    if (h.status === "dropped" || q.dropped) throw new Error(`${h.id} 的这个问题已经不需要了`);
    const old = q.answer;
    if (old === value) return h;
    q.answer = value;
    if (h.status === "done" && old) {
      changed = { q, old };
      note(h, `改了「${q.title}」的答案：${old} → ${value}`);
    } else if (asked(h).every((x) => x.answer)) {
      finished = true;
      finish(s, h);
    }
    if (h.status === "done") h.handedBack = summary(h);
    h.updatedAt = Date.now();
    return h;
  });
  const { store } = load(ctx);
  const workers = store.tasks.filter((t) => t.owner === "agent" && t.session && t.status !== "dropped" && t.status !== "done" && (t.id === h.askedBy || t.blockedBy?.includes(h.id)));
  if (finished) {
    await deliver(ctx, h);
  } else if (changed) {
    const c = changed as { q: Question; old: string };
    for (const t of workers) await tell(ctx, t, `用户改了「${c.q.title}」（${h.id}）的答案：原来是「${c.old}」，现在是「${value}」。\n按新的来；已经照旧答案做了的，改过来。`).catch(() => {});
  }
  return { task: h, done: h.status === "done" };
}

/** All of h's questions are answered or set aside: it's done, and the feed says what the user answered. */
function finish(s: Store, h: Task) {
  Object.assign(h, { status: "done", handedBack: summary(h), doneAt: Date.now() });
  for (const q of asked(h)) q.sent = true;
  activity(s, h, { kind: "user", by: h.askedBy, of: h.id, text: `你答了 ${asked(h).length} 个问题：${summary(h)}` });
}

/** The answers of a finished item go to its worker (and anyone it held up), with the questions the user set aside. */
async function deliver(ctx: Ctx, h: Task) {
  const { store } = load(ctx);
  const workers = store.tasks.filter((t) => t.owner === "agent" && t.session && t.status !== "dropped" && t.status !== "done" && (t.id === h.askedBy || t.blockedBy?.includes(h.id)));
  const skipped = (h.questions ?? []).filter((q) => q.skipped);
  const text =
    `你问的问题（${h.id}），用户${asked(h).length ? "答了" : "都没答"}：\n${asked(h).map((q, i) => `${i + 1}. ${q.title}\n   → ${q.answer}`).join("\n")}` +
    (skipped.length ? `\n用户说不用答了（已经过时，别再按它们做）：${skipped.map((q) => `「${q.title}」`).join("、")}` : "") +
    `\n照这些接着做。`;
  for (const t of workers.filter((t) => blockersDone(store, t) || t.id === h.askedBy)) await wake(ctx, t.id, { how: `你答了 ${h.id}`, text, fold: false }).catch(() => {});
}

/**
 * The user sets a question aside (不用答了): it went moot and the worker didn't take it back (t63#1, 2026-11-05).
 * { id, q }. When the rest are answered, everything goes to the worker now, saying this one was set aside.
 */
export async function skipQuestion(input: { id: string; q: string }, ctx: Ctx) {
  let finished = false;
  update(ctx, (s) => {
    const h = find(s, input.id);
    const q = h.questions?.find((x) => x.id === String(input.q));
    if (!q) throw new Error(`${h.id} 没有第 ${input.q} 个问题`);
    if (h.status !== "todo" || q.dropped) throw new Error(`${h.id} 的这个问题已经不在等你了`);
    if (q.answer != null) throw new Error(`这个问题你已经答了：${q.answer}`);
    Object.assign(q, { dropped: "你说不用答了", skipped: true });
    note(h, `用户说「${q.title}」不用答了`);
    activity(s, h, { kind: "user", by: h.askedBy, of: h.id, text: `你说「${q.title}」不用答了` });
    const left = asked(h);
    if (!left.length) {
      // Nothing left to ask: the item goes, and its worker hears that none of it is needed
      Object.assign(h, { status: "dropped", doneAt: Date.now() });
      for (const t of s.tasks) if (t.blockedBy?.includes(h.id)) t.blockedBy = t.blockedBy.filter((x) => x !== h.id);
      finished = true;
    } else if (left.every((x) => x.answer != null)) {
      finished = true;
      finish(s, h);
    }
    h.updatedAt = Date.now();
  });
  if (finished) await deliver(ctx, find(load(ctx).store, input.id));
  return { ok: true };
}

/**
 * 先把已答的发给它: the answers given so far go to the worker now, the rest stay on the board for later. { id }.
 * Answering all at once stays the default (the worker usually needs them together); this is for going on meanwhile.
 */
export async function sendAnswered(input: { id: string }, ctx: Ctx) {
  let fresh: Question[] = [];
  let rest: Question[] = [];
  const h = update(ctx, (s) => {
    const h = find(s, input.id);
    if (h.status !== "todo" || !h.questions) throw new Error(`${h.id} 已经不在等你了`);
    fresh = asked(h).filter((q) => q.answer != null && !q.sent);
    rest = asked(h).filter((q) => q.answer == null);
    if (!fresh.length) throw new Error("还没有答了没发的");
    for (const q of fresh) q.sent = true;
    activity(s, h, { kind: "user", by: h.askedBy, of: h.id, text: `你先发了答案：${fresh.map((q) => `${q.title}：${q.answer}`).join("；")}` });
    h.updatedAt = Date.now();
    return h;
  });
  const w = h.askedBy;
  if (w)
    await wake(ctx, w, {
      how: `你先发了 ${h.id} 已答的`,
      fold: false,
      text:
        `用户先把答了的发给你（${h.id}）：\n${fresh.map((q) => `- ${q.title}\n  → ${q.answer}`).join("\n")}\n` +
        `还没答、之后再答的：${rest.map((q) => `${h.id}#${q.id}「${q.title}」`).join("、")}（答了会再发给你）。能照已答的先做的就先做；还没答的里已经不用问的，cancel_human 它。`,
      resume: true,
    }).catch(() => {});
  return { sent: fresh.length };
}

/** The questions still asked (not taken back). */
function asked(h: Task) {
  return (h.questions ?? []).filter((q) => !q.dropped);
}

function summary(h: Task) {
  return asked(h)
    .map((q) => `${q.title}：${q.answer ?? "（没答）"}`)
    .join("；");
}

/**
 * Changes an answer already given: { id, value } — a decision picked or a value handed back by mistake. The card's
 * own undo only lasts the seconds before it's sent; after that the worker is already acting on it, so it's told
 * what changed (old → new) right away, and is expected to redo what depended on the old one. Not a secret: those are
 * set again in Gerdr's dialog on the board.
 */
export async function reanswer(input: { id: string; value: string }, ctx: Ctx) {
  const value = input?.value?.trim();
  if (!value) throw new Error("写下新的答案");
  let old = "";
  const h = update(ctx, (s) => {
    const h = find(s, input.id);
    if (h.owner !== "human" || h.status !== "done") throw new Error(`${h.id} 还没答，直接答就行`);
    if (h.handBack?.kind !== "choice" && h.handBack?.kind !== "value") throw new Error(`${h.id} 没有可以改的答案`);
    old = h.handedBack ?? "";
    if (old === value) return h;
    note(h, `改了答案：${old} → ${value}`);
    Object.assign(h, { handedBack: value, updatedAt: Date.now() });
    return h;
  });
  if (old === value) return { task: h, changed: false };
  const { store } = load(ctx);
  // Who acted on the old answer: the worker that asked, and any task it was holding up
  const told = store.tasks.filter((t) => t.owner === "agent" && t.session && t.status !== "dropped" && (t.id === h.askedBy || t.blockedBy?.includes(h.id)));
  const what = h.handBack?.kind === "choice" ? "决定" : h.handBack?.label || "交回的值";
  for (const t of told)
    await tell(ctx, t, `用户改了「${h.title}」（${h.id}）的${what}：原来是「${old}」，现在是「${value}」。\n按新的来；已经照旧答案做了的，改过来（改不了的用 ask_human 说明）。`).catch(() => {});
  return { task: h, changed: true, told: told.map((t) => t.id) };
}

/**
 * Repositories to pick from: the user's own list (设置 → 仓库, local/_config.ts), the board's data
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
  const mine = workflow(ctx).repos.map((r) => r.path);
  for (const p of mine) add(p);
  if (!mine.length) for (const d of ctx.dirs.recent()) add(d.path, true);
  return out.slice(0, 40);
}

// Work asked of the user by someone (assign.ts), as the board's actions: tasks.agree / decline / replyOrigin
export { agree, decline, replyOrigin } from "./assign";
