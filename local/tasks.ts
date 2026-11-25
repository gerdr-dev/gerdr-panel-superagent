import { tellInbox } from "./_inbox";
import { tellBadge } from "./_badge";
import { DATA, skillFile } from "./_user";
import { workflow } from "./_config";
import { forWorker } from "./memory";
import { activity, blockersDone, going, draftOf, find, findAsk, ignoredLead, load, noteIgnored, members, newTask, note, reqOf, update, type Ask, type Question, type Store, type Task } from "./_store";
import { open, syncAgents, syncSessions, wakeText } from "./_waits";
import { cutLine, wake } from "./_wake";
import { askState, cardStates } from "./_cardstate";
import { closeSec, isSecAsk, secretaryIgnored, secStatus } from "./_secask";
import { allAgents, mentionsIn } from "./_agents";
import { archived as archivedGroups, archivedCount, archiveOld, latest, revive, unarchive as bringBack } from "./_archive";
import { isMain, mains, rerouteTask, routeTask, sweep, toMain } from "./_main";
import { textOf } from "./playbooks";
import { liveTasks, said } from "./_clues";

export type { Task };

// Task board data: user/data/reqs/, a file per part (read and written through _store.ts, _parts.ts). Every task is
// handed to a coding-agent session (its worker); what only the user can do (UI clicks, accounts, approvals) is an ask
// on the task whose worker needs it (_store.ts Ask). Everything here is deterministic: the page, the
// panel agent (`gerdr panel run tasks.<fn> '<json>'`) and worker replies all go through these functions.
//
// Workers don't report (2026-11-12): the task panel follows their sessions, and a turn that ends waiting on nothing
// puts the task before the user (待验收). What they still tell it goes through the panel tools (board.ts: wait_for,
// cancel_wait, ask_human, cancel_human), which Gerdr gives them over MCP.

// What a worker is told besides its task: short, since it shows in the chat as part of the first message. How to
// use each tool is in the tools' own descriptions (board.ts), the user's way of working in the panel's skills — named
// by absolute path (skillFile): "the skill, references/task.md" had the worker search the disk for it.
// Not exported: an exported function here is one a page or an agent can call (tasks.<name>).
function workerProtocol(ctx: Ctx, id: string) {
  return `

---
This is task ${id} on the user's Superagent task panel: opening it there opens this chat. Nothing to report: say it
in your replies, conclusion first. How to work on it (waiting on others, asking them, sessions you start) is their
superagent-panel skill: read ${skillFile(ctx, "superagent-panel/references/task.md")} first.
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

// ---- called by the page and the panel's agent ----

/**
 * Every task with its worker's live state, after applying worker replies not seen yet.
 * `column` is where the board shows it: you (needs the user), review, active, done.
 * `{ id: "t12" }`: only that task and what belongs to it (its members, the user's steps they asked for), for an agent
 * asking about one task: the whole board is tens of thousands of characters. Syncing still covers every task.
 */
export async function list(input: unknown, ctx: Ctx) {
  // Archived ones asked for by id, or whose worker is running again (the user wrote to it): back on the board first
  const want = (input as { id?: string } | null)?.id;
  if (want) bringBack(ctx, want);
  const all = ctx.sessions.list() as (Session & { parent?: string; reportTo?: string })[];
  revive(ctx, all);
  await startUnblocked(ctx);
  const live: Record<string, any> = {};
  const { store } = load(ctx);
  // Read sessions outside the write: ctx.sessions.get is cheap, but keep the locked part small
  // Done ones too: the user may give a finished worker more to do in its chat (below)
  for (const t of store.tasks) if (t.session && t.status !== "dropped") live[t.session] = ctx.sessions.get(t.session);
  // Gerdr named an auto-titled task's conversation (or renamed it as the talk went on): the task takes that name
  for (const t of store.tasks) {
    const name = t.autoTitle && t.session ? String(live[t.session]?.title ?? "").trim() : "";
    if (name && name !== t.title) edit({ id: t.id, title: name, autoTitle: true }, ctx);
  }
  // Sessions the workers handed work to (reportTo / parent / a task tag), here or on another computer: waits of their
  // task (_waits.ts syncSessions)
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
  for (const t of store.tasks) if (t.status !== "done" && t.status !== "dropped") kids[t.id] = kidsOf(t);
  const nudge: { session: string; id: string; out: string[] }[] = [];
  // Answers to questions the secretary passed on (tasks.message): into its chat, where the user asked
  const answered: { id: string; asked: string; text: string }[] = [];
  // What the user ignored, for a worker whose turn started without the board (the user typed in its chat)
  const ignored: { session: string; text: string }[] = [];
  const s = update(ctx, (s) => {
    nudge.length = 0; // update retries this function on a write race: decide afresh each time
    answered.length = 0;
    ignored.length = 0;
    for (const t of s.tasks) {
      const sess = t.session && live[t.session];
      // What the user typed in its chat (Gerdr's personSaid): the feed shows it, or the lines after it make no sense
      // (t52: "等扶摇审批" with nothing saying the user asked for 扶摇)
      const ps = (sess as any)?.personSaid as { text: string; at: number } | undefined;
      // A turn after the /compact compactWorkers sent: its upkeep turn is over (upkeep)
      if (t.compactAt && ((sess?.status === "running" && (sess.turnStartedAt ?? 0) >= t.compactAt + UPKEEP_START) || (ps?.at ?? 0) >= t.compactAt + UPKEEP_START))
        t.compactAt = undefined;
      if (ps?.at && ps.at > (t.heard ?? t.createdAt) && ps.text.trim()) {
        t.heard = ps.at;
        // A slash command (/compact) is upkeep of the conversation, nothing the feed needs
        if (!/^\/\S/.test(ps.text.trim()))
          activity(s, t, { kind: "user", by: t.id, text: `你在对话里说：${ps.text.trim()}`, at: ps.at } as any);
      }
      syncSessions(t, kids[t.id] ?? []);
      syncAgents(t, t.session, (sess?.tasks ?? []) as any[]);
      // A turn started with a slash command (/compact) is no answer to anything and no going on with the work
      if (sess?.status === "running" && !upkeep(t, sess)) {
        // The worker is at it again. What it waits on stays open: it takes back what it no longer waits for itself
        // (cancel_wait, cancel_human), the board doesn't guess it from a new turn (2026-11-23). The task's status stays
        // where the user put it (DESIGN.md「状态只由用户改」).
        const lead = ignoredLead(t);
        if (lead) ignored.push({ session: sess.id, text: lead });
      }
      // Stopped by the user (or Gerdr restarting): theirs, not a worker that went quiet. No reminder — it would start
      // it again against their stop
      const cancelled = (sess as any)?.stopReason === "cancelled";
      if (!sess || (sess.status !== "idle" && sess.status !== "error")) continue;
      if (t.synced === sess.updatedAt) continue;
      t.synced = sess.updatedAt;
      // A question the secretary passed on (tasks.message): whatever it answered in its reply goes to the secretary's
      // chat as written
      if (t.asked?.relay && sess.status === "idle" && sess.updatedAt > t.asked.at + 1000) {
        if (!cancelled) answered.push({ id: t.id, asked: t.asked.relay, text: String(sess.reply ?? "").trim() });
        t.asked = undefined;
      }
      if (going(t) && sess.status === "idle" && !settled(t) && !cancelled && !busyBehind(sess) && t.assigned?.state !== "delivered") {
        // Its turn ended and it waits on nothing: what it said last becomes the card's line; the task stays in its
        // column until the user moves it. The one thing it is still reminded of: work it handed to another session
        // with nobody waiting on it (wait_for), which nothing would wake it for.
        const out = open(t).filter((w) => w.kind === "session");
        if (out.length && (t.nudges ?? 0) < 1) {
          t.nudges = (t.nudges ?? 0) + 1;
          nudge.push({ session: sess.id, id: t.id, out: out.map((w) => w.what.replace(/^它派出的/, "")) });
        } else if (!upkeep(t, sess)) {
          // The card's line follows what it said last; the column doesn't (DESIGN.md「状态只由用户改」). A turn the user
          // started with a command (/compact) said nothing about the work.
          const said = firstWords(String(sess.reply ?? ""));
          if (said) t.summary = said;
        }
      }
      t.updatedAt = Date.now();
    }
    return s;
  });
  // Into the turn it is in: now, so it hears it before it acts on the question (the board's own messages carry it first)
  for (const n of ignored) await ctx.sessions.send(n.session, n.text, { now: true, fold: "[任务面板] 用户忽略了你问的问题" } as any).catch(() => {});
  await secretaryIgnored(ctx);
  for (const n of nudge) {
    await ctx.sessions
      .send(n.session, `[任务面板] 你把活派出去了，但没有等它（任务 ${n.id}）：${n.out.join("；")}。照 task.md「等别人」用 wait_for 等它（带超时），然后结束这一轮。`, {
        fold: "[任务面板] 提醒：派出去的活要用 wait_for 等着",
      } as any)
      .catch(() => {});
  }
  // Workers' system files follow the user's memory (a worker restarted later reads what was learned since)
  for (const t of s.tasks) if (t.session && t.repo && t.status !== "done" && t.status !== "dropped" && ctx.fs.stat(workerSystemPath(t.id))) writeWorkerSystem(ctx, t.id, t.repo);
  // A reminded worker is running again: its card is back in 进行中 now, not on the next refresh
  for (const n of nudge) live[n.session] = ctx.sessions.get(n.session) ?? live[n.session];
  await closeRouters(ctx, live);
  sweep(ctx);
  // Requirements finished long ago leave the board's files (_archive.ts, at most hourly): out of s too, so they leave
  // the page with this very answer
  if (archiveOld(ctx, () => load(ctx), workflow(ctx).archiveDays, reqOf)) {
    const kept = new Set(load(ctx).store.tasks.map((t) => t.id));
    s.tasks = s.tasks.filter((t) => kept.has(t.id));
  }
  let ack: ReturnType<typeof workflow> | undefined;
  const tasks = s.tasks.map((t) => {
      const sess = t.session ? live[t.session] : null;
      const halted = stopped(t, sess);
      // What it last said, for a card that has it stopped: its last paragraph, without Gerdr's note on how the turn
      // ended (that's stopWhy)
      const idle = sess && (sess.status === "idle" || sess.status === "error");
      const said = idle && halted ? lastWords(String(sess?.reply ?? "")) : "";
      const ks = kids[t.id] ?? [];
      // The card's line: the newest paragraph in its worker's conversation, read live (summary is written only by
      // task_update or when a turn ends, and workers forget the former: the card read hours behind the chat)
      const now = t.status !== "done" && t.status !== "dropped" && t.session ? newest(ctx, t.session) : "";
      return {
        ...t,
        // The open waits, each with what wakes it in words (the 在等 list, the card); ended ones stay in t.waits
        waits: open(t).length ? open(t).map((w) => ({ ...w, wake: wakeText(w) })) : undefined,
        // The sessions it handed work to, for the card's chips (each is a wait as well)
        helpers: ks.length ? ks.map((k) => ({ id: k.id, title: k.title, status: k.status, waiting: k.waiting, waitingKind: k.waitingKind, left: k.user })) : undefined,
        // Where each of its chat cards stands (_cardstate.ts): the cards read them from here while the board is loaded
        cards: cardStates(t),
        live: sess ? { status: sess.status, waiting: sess.waiting, waitingSince: sess.waitingSince, turnStartedAt: sess.turnStartedAt, updatedAt: sess.updatedAt, error: sess.error, title: sess.title } : null,
        column: column(s, t, sess),
        ready: blockersDone(s, t),
        // Stopped with nothing to wait on (shown under 等你): what it last said, for the card
        stopped: halted || undefined,
        stopWhy: halted ? stopWhy(t, sess, s) : undefined,
        said: said || undefined,
        latest: now || undefined,
        // 设置 → 回复对方 is 派出去时, and it's not out yet and came from a chat: the card's 回复对方 box by 派出去, filled
        // with the 回复对方 words for the user to change
        ...(t.status === "todo" && t.origin?.reply && !t.assigned && (ack ??= workflow(ctx)).ack === "dispatch"
          ? { canReply: true, replyDraft: t.replyOnStart ?? ack.ackText.split("{id}").join(t.id).split("{title}").join(t.title) }
          : {}),
      };
    });
  // What waits on the user, in Gerdr's inbox too (_inbox.ts): each member and step on its own, as before
  tellInbox(ctx, tasks as any);
  // Cards that moved (or came) since the last sync: a number on the panel's rail button (_badge.ts)
  tellBadge(ctx, tasks);
  // The secretary's side (_main.ts): its finished reply into the conversation, and news of what newly needs the user.
  // Here because the board's sync runs every minute with or without the page open; a failure mustn't break the board.
  // Task changes aren't sent to the secretary any more (2026-11-11, the user: the board is where they work, the secretary
  // helps; it looks at tasks when a schedule asks it to, secretary.checkStuck)
  for (const a of answered)
    await toMain(ctx, [`[${a.id} 的回答]（用户问的：${a.asked.length > 80 ? a.asked.slice(0, 80) + "…" : a.asked}）\n\n${a.text || "（它这一轮没说话）"}`], "notice", undefined, false).catch((err: any) =>
      ctx.log(`${a.id} 的回答没转给秘书：${err?.message ?? err}`),
    );
  const board = teams(s, tasks);
  const id = want;
  // project: the key the chat cards carry (ctx.workspace.project), for the page to file the tasks' card states under
  if (!id) return { tasks: board.map(slim), at: Date.now(), archived: archivedCount(ctx), project: ctx.workspace.project };
  if (!board.some((t) => t.id === id)) throw new Error(`没有 ${id}`);
  // The task, the requirement it is in, and everything in that requirement
  const root = (board.find((t) => t.id === id) as any)?.in ?? id;
  return { tasks: board.filter((t: any) => t.id === root || t.in === root || t.id === id), at: Date.now(), project: ctx.workspace.project };
}

/**
 * A task as the whole board gets it: what the cards, the 等你 lines and the search read, without the parts only a
 * task's own view needs. The board runs this on every change it hears of and it came to over 1 MB for 53 tasks
 * (2026-11-24): notes, asks' answers and the activity feed, mostly on cards long done. Kept in Gerdr's memory until
 * delivered and parsed by the page each time, it held hundreds of MB and stalled the page. A finished card's notes
 * and full brief come from tasks.get when it's opened; tasks.list { id } (an agent asking about one) stays whole.
 */
function slim<T extends Task>(t: T) {
  // activity: the page doesn't show it (teams() has already taken its newest time); notes: only a finished card's view
  const { activity, notes, ...card } = t;
  // Only replies still waiting are shown (待发送); a sent / skipped one's card asks outbox.status
  const pending = t.outbox?.filter((o) => o.state === "pending");
  const rest = { ...card, outbox: pending?.length ? pending : undefined };
  if (t.status !== "done" && t.status !== "dropped") return rest;
  return {
    ...rest,
    // The search matches the start of the brief; the whole of it is in tasks.get
    prompt: t.prompt && t.prompt.length > 300 ? t.prompt.slice(0, 300) : t.prompt,
    // Its asks are closed: their titles for the search and their state, not every question's answer
    asks: t.asks?.map(({ questions, ...a }) => a),
  };
}

/**
 * The cards' lines alone: { ids } → { [task id]: its worker's newest paragraph }. While a worker runs the board reads
 * these every 10 s; it used to rerun the whole of tasks.list for that, the board's biggest answer, several times a
 * minute with a few workers going (2026-11-24).
 */
export function lines(input: { ids?: string[] }, ctx: Ctx) {
  const want = new Set(input?.ids ?? []);
  const out: Record<string, string> = {};
  for (const t of load(ctx).store.tasks)
    if (want.has(t.id) && t.session && t.status !== "done" && t.status !== "dropped") out[t.id] = newest(ctx, t.session);
  return out;
}

/** One task as stored, whole (notes, the full brief, asks with their answers): a finished card's view. */
export function get(input: { id: string }, ctx: Ctx) {
  const t = load(ctx).store.tasks.find((x) => x.id === input?.id);
  if (!t) throw new Error(`没有 ${input?.id}`);
  return t;
}

/**
 * Every task is a requirement card (DESIGN.md「需求和队友」), alone or with members: its members carry `in` (the
 * requirement's id) and the page folds them into its card; the requirement's `teamColumn` is its own, marked 等你 when
 * any of them waits on the user.
 */
function teams<T extends Task & { column: string }>(s: Store, tasks: T[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = tasks.map((t) => {
    const root = reqOf(s, t);
    return root && root.id !== t.id ? { ...t, in: root.id } : t;
  });
  return out.map((t: any) => {
    if (t.in) return t;
    const mine = out.filter((x: any) => x.in === t.id);
    // A member's result for review counts as the card's too: the user judges it either way
    // Its column is its own status (the user's to change); a member waiting on the user only makes it yellow
    let col = t.column;
    if (col === "active" && mine.some((x: any) => x.column === "you")) col = "you";
    // Its last change: its own, a member's, or its feed's latest line (kept in the members' parts, not on it)
    t.updatedAt = Math.max(t.updatedAt, ...mine.map((x: any) => x.updatedAt ?? 0), ...(t.activity ?? []).map((a: any) => a.at));
    return { ...t, teamColumn: col, members: members(s, byId.get(t.id)!).map((m) => m.id) };
  });
}

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

/** The newest agent paragraph in a conversation (ctx.sessions.read: the turn going on too), "" when none or on a
 *  Gerdr without read. */
function newest(ctx: Ctx, id: string) {
  try {
    const said = (ctx.sessions as any).read?.(id, { last: 8 }) as { role: string; text: string }[] | null | undefined;
    const a = said?.filter((x) => x.role === "agent" && x.text.trim()).pop();
    return a ? lastWords(a.text) : "";
  } catch {
    return "";
  }
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
  // Never had a turn: a conversation the person opened themselves (local/blank.ts, a fork) starts quiet and waits for
  // their first message; it hasn't stopped anything (the row said 停下了 the moment it was opened, 2026-11-25)
  if (!sess.stopReason && !String(sess.reply ?? "").trim() && !sess.personSaid) return "还没开始，等你说第一句";
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
 * Where the board shows a task. The column is the task's status, which only the user changes (setStatus, drag,
 * 标为完成 / 通过 / 打回 / 放弃: DESIGN.md「状态只由用户改」). "you" is no column of its own: a task in 进行中 that
 * waits on the user right now (an approval in its chat, an error, a question) — the page shows it first and yellow.
 * A worker that stopped with nothing going on just says so on its card.
 */
function column(s: Store, t: Task, sess: any): "you" | "review" | "active" | "done" {
  if (t.status === "done" || t.status === "dropped") return "done";
  if (t.status === "review") return "review";
  // Asked of the user by someone: theirs to agree to. Delivered: whoever asked has it now
  if (t.assigned?.state === "ask") return "you";
  if (t.assigned?.state === "delivered") return "active";
  if (sess?.status === "waiting" || sess?.status === "error") return "you";
  // Waiting on the user right here: a question, a step or decision it asked for (its asks), a helper's approval
  if (open(t).some((w) => w.user)) return "you";
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

/**
 * Its current (or last) turn is one the user started with a slash command (/compact, /clear, /model…): upkeep of
 * the conversation, not work. Gerdr sets personSaid when a person's message starts a turn (hub/send.go), and byPerson
 * says the turn is theirs.
 */
function command(sess: any) {
  const ps = sess?.personSaid as { text: string; at: number } | undefined;
  return !!sess?.byPerson && !!ps && /^\/\S/.test(ps.text.trim()) && ps.at >= (sess.turnStartedAt ?? 0);
}

/** How long after compactWorkers sends /compact its turn may start: a turn starting later is someone else's. */
const UPKEEP_START = 30_000;

/**
 * Its worker's current (or last) turn is upkeep of the conversation: a slash command the user typed (command), or
 * the /compact compactWorkers sent (t.compactAt, cleared in list() once a later turn starts). Such a turn answers
 * nothing and says nothing about the work: waits stay open, the card's line stays.
 */
function upkeep(t: Task, sess: any) {
  if (command(sess)) return true;
  if (!t.compactAt) return false;
  if (sess?.status !== "running") return true;
  const turn = sess.turnStartedAt ?? 0;
  return turn >= t.compactAt - 2000 && turn < t.compactAt + UPKEEP_START;
}

const WORKER_COMPACT = "superagent-panel/references/worker-compact.md";

/**
 * Compacts workers' conversations (schedules/worker-compact.json; 设置 → 干活 → 自动压缩 workerCompact): the worker of
 * a task not ended, idle, quiet for idleMinutes, whose context holds percent% of its window or more. Quiet that long,
 * its prompt cache is cold, so the compaction costs about what its next message would, and the next one is smaller.
 * What the summary keeps is the user's prose (流程 → worker-compact.md). { dry?: true — only say which would be }
 */
export async function compactWorkers(input: { dry?: boolean } | null, ctx: Ctx) {
  const { percent, idleMinutes } = workflow(ctx).workerCompact;
  if (!percent) return "设置里关掉了 worker 自动压缩";
  const { store } = load(ctx);
  const picked: { id: string; session: string; line: string }[] = [];
  for (const t of store.tasks) {
    if (!t.session || t.status === "done" || t.status === "dropped") continue;
    const sess = ctx.sessions.get(t.session);
    const c = sess?.context;
    if (!sess || sess.status !== "idle" || !c?.window) continue;
    if (Date.now() - sess.updatedAt < idleMinutes * 60_000) continue;
    const used = Math.round((c.tokens / c.window) * 100);
    if (used < percent) continue;
    picked.push({ id: t.id, session: sess.id, line: `${t.id}「${t.title}」上下文 ${used}%（${c.tokens}/${c.window}）` });
  }
  if (!picked.length) return `没有要压缩的 worker（上下文 ≥ ${percent}%、闲了 ${idleMinutes} 分钟以上）`;
  if (input?.dry) return picked.map((p) => p.line);
  const how = textOf(ctx, WORKER_COMPACT).replace(/^#.*\n+/, "").trim();
  const done: string[] = [];
  for (const p of picked) {
    // Marked first: the turn starts as soon as it's sent, and list() runs on that event
    update(ctx, (s) => {
      const t = s.tasks.find((x) => x.id === p.id);
      if (t) t.compactAt = Date.now();
      return s;
    });
    try {
      await ctx.sessions.send(p.session, `/compact ${how}`.trim());
      done.push(p.line);
    } catch (e: any) {
      done.push(`${p.line}：没压成，${e?.message ?? e}`);
    }
  }
  return `压缩了：\n${done.join("\n")}`;
}

/** Its worker isn't running and the task waits on nothing. */
function stopped(t: Task, sess: any) {
  if (t.status !== "running") return false;
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
  const mine = new Set([t.session, ...(t.sessions ?? [])].filter(Boolean) as string[]);
  return all.filter(
    (x) =>
      !mine.has(x.id) &&
      (x.status === "running" || x.status === "starting" || x.status === "waiting") &&
      ((x.reportTo && mine.has(x.reportTo)) || (x.parent && mine.has(x.parent)) || x.tags?.task === t.id),
  );
}

/**
 * Every session handed work under a task's workers, down to helpers of helpers (reportTo / parent, here or on another
 * computer): closed with the task, the way a subagent ends with its agent (gerdr session new --report-to self).
 */
function helperSessions(ctx: Ctx, t: Task): string[] {
  const all = ctx.sessions.list() as (Session & { parent?: string; reportTo?: string })[];
  const mine = new Set([t.session, ...(t.sessions ?? [])].filter(Boolean) as string[]);
  const out: string[] = [];
  for (let depth = 0, grew = true; grew && depth < 4; depth++) {
    grew = false;
    for (const x of all)
      if (!mine.has(x.id) && ((x.reportTo && mine.has(x.reportTo)) || (x.parent && mine.has(x.parent)))) {
        mine.add(x.id);
        out.push(x.id);
        grew = true;
      }
  }
  return out;
}

function firstLine(text?: string) {
  const line = (text ?? "").trim().split("\n")[0].trim();
  return [...line].length > 40 ? [...line].slice(0, 40).join("") + "…" : line;
}

/**
 * A new task, for an agent: { title?, prompt, repo?, agent?, model?, effort?, blockedBy?, start? }. Without start it
 * waits in 待办 (the user's own to-do too: there are no tasks for people, 2026-11-19 — what a worker needs from the
 * user is an ask on its task, board.ts ask_human).
 */
export async function add(input: Partial<Task> & { title?: string; start?: boolean }, ctx: Ctx) {
  // No title given (the board only asks what to do): the first line of the prompt / steps, cut short.
  if ((input as any)?.owner === "human") throw new Error("没有人工任务了：要自己记一件事，就建一个任务不派出去（不加 start），它留在待办");
  const title = (input?.title || firstLine(input?.prompt) || (input?.attachments?.length ? `看附件：${input.attachments[0].name}` : "")).trim();
  if (!title) throw new Error("任务要写清楚做什么");
  const { start: go, ...rest } = input;
  // @-mentions in the text (the board's input box, the panel's agent writing "@design …"): who the router hands it to.
  // One mention and no agent given is simply the agent.
  if (!rest.mentions && rest.prompt?.includes("@")) {
    const m = mentionsIn(rest.prompt, await allAgents(ctx));
    if (m.length) rest.mentions = m;
  }
  if (rest.mentions?.length === 1 && !rest.agent) rest.agent = rest.mentions[0];
  const auto = !input?.title ? { autoTitle: true } : {};
  const t = update(ctx, (s) => newTask(s, { ...rest, ...auto, title, id: undefined } as any));
  if (go) {
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
    if (!t.startWhenFree || t.status !== "todo" || t.session || !blockersDone(store, t)) continue;
    const before = (t.blockedBy ?? [])
      .map((id) => store.tasks.find((x) => x.id === id))
      .filter((x): x is Task => !!x)
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
    // Named by someone (the user in the drawer, an agent): no longer follows its conversation's auto title
    if (rest.title && !("autoTitle" in rest)) rest.autoTitle = undefined;
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
/** The user's 备注 on a card from outside, after its prompt (the message as it came) in what a worker is sent. */
export function remarkOf(t: Task) {
  return t.remark?.trim() ? `\n\n## 我的备注\n${t.remark.trim()}` : "";
}

export async function start(
  input: { id: string; prompt?: string; repo?: string; agent?: string; model?: string; effort?: string; worktree?: boolean; mode?: string; reply?: string; /** A conversation its worker carries on (local/import.ts): its chat comes along, and nothing is sent to it now */ continueFrom?: string; /** Nothing sent: the person types the first message themselves (local/blank.ts) */ quiet?: boolean },
  ctx: Ctx,
) {
  // reply: the card's 回复对方 box, kept on the task until it's out (it may go to the secretary for a repository first);
  // it takes the place of the 回复对方 words
  if (typeof input.reply === "string")
    update(ctx, (s) => {
      const x = find(s, input.id);
      Object.assign(x, { replyOnStart: input.reply!.trim(), ackOnStart: undefined });
    });
  const { store } = load(ctx);
  const t = find(store, input.id);
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
    // Fixed to the task's name, unless the task waits for Gerdr's auto title (autoTitle)
    ...(t.autoTitle ? {} : { title: t.title }),
    systemFile: `${ctx.workspace.dir}/${sys}`,
    // What it makes that isn't committed goes in the task's folder (Gerdr names it in the worker's prompt and lets its
    // sandbox write there)
    artifactsDir: folder({ id: t.id }, ctx)?.path,
    tags: { task: t.id },
    ...(input.continueFrom ? { continueFrom: input.continueFrom } : {}),
    // Followed on the board (its drawer shows the chat), not in Code: no tab of it appears there
    workspace: "none",
    // No reportTo: the user follows the board, not the panel's agent, and the worker updates the board itself (panel
    // tools). A report would only have the panel's agent repeat the worker's reply to nobody, a turn each time.
  } as any);
  // Carried on from a conversation the person had (import): it has said nothing new yet, and they speak next
  if (!input.continueFrom && !input.quiet)
    await ctx.sessions.send(sess.id, (prompt || "看附件，照里面的做。") + remarkOf(t), {
      attachments: (t.attachments ?? []).map((a) => a.path),
      show: true,
    } as any);
  const out = update(ctx, (s) => {
    const x = find(s, t.id);
    Object.assign(x, { status: "running", routing: undefined, prompt, repo, session: sess.id, sessions: [...(x.sessions ?? []), sess.id], updatedAt: Date.now() });
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
  // What the user wrote in the card's 回复对方 box goes now that it's out (empty: nothing)
  if (typeof out.replyOnStart === "string") {
    if (out.replyOnStart && out.origin?.reply)
      try {
        (ctx as any).events.reply({ ...out.origin, at: 0 }, out.replyOnStart);
      } catch (err: any) {
        ctx.log(`回复 ${out.origin.source}/${out.origin.kind} 失败：${err?.message ?? err}`);
      }
    return update(ctx, (s) => {
      const x = find(s, out.id);
      if (x.replyOnStart) note(x, `派出去时回了对方：${x.replyOnStart}`);
      x.replyOnStart = undefined;
      return x;
    });
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

/** Hand the same task and its conversation to another agent, keeping its place on the board. */
export async function switchAgent(input: { id: string; session: string; agent: string }, ctx: Ctx) {
  const t = find(load(ctx).store, input.id);
  if (!t.session || t.session !== input.session || t.status === "dropped") throw new Error("任务会话已变更，请重新打开菜单");
  const from = ctx.sessions.get(t.session);
  if (!from) throw new Error("找不到原任务会话");
  if (!input.agent || input.agent === from.agent) throw new Error("请选择另一个 agent");
  if (from.status === "running" || from.status === "waiting") throw new Error("请先结束当前轮次，再更换 agent");

  const sess = await ctx.sessions.start({
    cwd: from.cwd,
    agent: input.agent,
    ...(t.autoTitle ? {} : { title: t.title }),
    systemFile: `${ctx.workspace.dir}/${writeWorkerSystem(ctx, t.id, t.repo || from.cwd)}`,
    artifactsDir: folder({ id: t.id }, ctx)?.path,
    tags: { task: t.id },
    continueFrom: from.id,
    workspace: "none",
  });

  try {
    return update(ctx, (s) => {
      const current = find(s, t.id);
      if (current.session !== from.id || current.status === "dropped") throw new Error("任务会话已变更，请重新打开菜单");
      current.session = sess.id;
      current.sessions = [...new Set([...(current.sessions ?? []), from.id, sess.id])];
      current.agent = input.agent;
      delete current.model;
      delete current.effort;
      current.updatedAt = Date.now();
      return current;
    });
  } catch (error) {
    await ctx.sessions.close(sess.id).catch(() => {});
    throw error;
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
  // The user's words passed on: shown whole in the worker's chat (code's messages fold by default). What the user
  // ignored since it last heard goes first
  const lead = update(ctx, (s) => ignoredLead(find(s, t.id)));
  await ctx.sessions.send(t.session, lead ? `${lead}\n\n${text}` : text, { now: true, show: true } as any);
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
  // Helpers its worker started go with it
  for (const id of [t.session, ...closing, ...helperSessions(ctx, t)]) if (id && (ctx.sessions as any).close) await (ctx.sessions as any).close(id).catch(() => {});
  return t;
}


/**
 * The user moves an agent task to a column (a drag on the board, 移到… in its menu): { id, status: todo | running |
 * review | done }. The only way a task changes column besides the user's other buttons (派出去 / 通过 / 打回 / 放弃):
 * neither its worker nor its conversation's state moves it (DESIGN.md「状态只由用户改」). Into 进行中 from 待办 is
 * 派出去; to 已完成 is 标为完成; back to 待办 only before it was sent out. The worker isn't told: the user says what
 * they want in its chat.
 */
export async function setStatus(input: { id: string; status: string }, ctx: Ctx) {
  const t = find(load(ctx).store, input.id);
  const to = input.status;
  if (to === t.status) return t;
  if (to === "done") return accept({ id: t.id }, ctx);
  if (t.status === "dropped") throw new Error(`${t.id} 已经放弃了：先恢复它`);
  if (to === "running" && t.status === "todo" && !t.session) return start({ id: t.id }, ctx);
  if (to === "todo") {
    if (t.session) throw new Error(`${t.id} 已经派出去了，回不到待办`);
    return t;
  }
  if (to !== "running" && to !== "review") throw new Error(`没有这个状态：${to}（todo / running / review / done）`);
  if (!t.session) throw new Error(`${t.id} 还没派出去：先派出去`);
  const label = to === "review" ? "待验收" : "进行中";
  return update(ctx, (s) => {
    const x = find(s, t.id);
    Object.assign(x, { status: to, doneAt: undefined, updatedAt: Date.now(), ...(to === "review" ? { reportedAt: Date.now() } : {}) });
    activity(s, x, { kind: "user", by: x.id, text: `你移到了${label}` });
    return x;
  });
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

/**
 * The user did what a worker asked (an ask: a step, a decision, a value): { id, value? }. Its worker is told and
 * woken, with what was handed back; a secret is named, never sent.
 */
export async function complete(input: { id: string; value?: string }, ctx: Ctx) {
  const { t, h } = update(ctx, (s) => {
    const { t, a: h } = findAsk(s, input.id);
    // Answered already (the chat card and the board both can, and a reloaded card no longer knows): never tell the
    // worker twice
    if (h.status === "done") throw new Error(`已经${h.handBack.kind === "choice" ? "决定" : "做完"}了${h.handedBack ? `：${h.handedBack}` : ""}`);
    if (h.status === "dropped") throw new Error(`「${h.title}」已经不需要了`);
    if (h.handBack.kind === "questions") throw new Error(`「${h.title}」是几个问题：一个一个答（tasks.answerQuestion）`);
    if ((h.handBack.kind === "value" || h.handBack.kind === "choice") && !input.value?.trim()) throw new Error(h.handBack.kind === "choice" ? "选一个，或者写下你的决定" : `要交回：${h.handBack.label || "一个值"}`);
    Object.assign(h, { status: "done", handedBack: input.value?.trim() || undefined, doneAt: Date.now(), updatedAt: Date.now() });
    activity(s, t, { kind: "user", by: t.id, of: h.id, text: `${h.handBack.kind === "choice" ? "你答了" : "你做完了"}「${h.title}」${h.handBack.kind === "secret" || !h.handedBack ? "" : `：${h.handedBack}`}` });
    return { t, h };
  });
  let back = "";
  if (h.handBack.kind === "value") back = `\n交回的${h.handBack.label || "值"}：${h.handedBack}`;
  if (h.handBack.kind === "secret") back = `\n密钥已存为面板密钥「${h.handBack.name}」（只有面板的本地函数能读，你看不到值）。`;
  const text =
    h.handBack.kind === "choice"
      ? `你问的「${h.title}」（${h.id}），用户的决定：${h.handedBack}\n照这个接着做。`
      : `你请用户做的「${h.title}」（${h.id}）他做完了。${back}\n先按你说的方式核验${h.verify ? `（${h.verify}）` : ""}，没问题再继续；核验不过就用 ask_human 再问一次，说明哪里不对。`;
  // Its wait on h ended in the write above (_waits.ts sync); this only tells the worker, the one way every wake goes
  const woke = t.session && t.status !== "dropped";
  if (woke) await wake(ctx, t.id, { how: h.handBack.kind === "choice" ? `你答了：${h.handedBack}` : "你做完了", text, fold: false });
  return { ask: h, task: t.id, woke: woke ? [t.id] : [] };
}

/**
 * A step whose link / code expired: { id } — drop it and ask the worker that needed it for a fresh one (it answers
 * with a new ask_human, which shows up as a new card).
 */
export async function redo(input: { id: string }, ctx: Ctx) {
  const { t, a: h } = findAsk(load(ctx).store, input.id);
  if (!t.session) throw new Error(`${t.id} 没有 worker 对话`);
  update(ctx, (s) => {
    const { t: x, a } = findAsk(s, h.id);
    note(x, `「${a.title}」过期了，让 worker 重新生成`);
    Object.assign(a, { status: "dropped", dropReason: "过期了", doneAt: Date.now(), updatedAt: Date.now() });
  });
  await tell(ctx, t, `你请用户做的「${h.title}」（${h.id}）过期了，用户还没来得及做。重新生成一个（新的链接 / 验证码），再用 ask_human 问一次。`);
  return { asked: t.id };
}

/**
 * The user says an ask isn't needed (不用做了 on its card): { id, reason? }. It leaves 等你 and its worker is told, so it
 * finds another way or asks again. Until 2026-11-19 this was 放弃 on a human task, which only dropped the task.
 */
export async function dropAsk(input: { id: string; reason?: string }, ctx: Ctx) {
  const why = input?.reason?.trim();
  const { t, h } = update(ctx, (s) => {
    const { t, a: h } = findAsk(s, input.id);
    if (h.status !== "open") throw new Error(`「${h.title}」已经不在等你了`);
    Object.assign(h, { status: "dropped", dropReason: why ? `你说不用了：${why}` : "你说不用了", doneAt: Date.now(), updatedAt: Date.now() });
    activity(s, t, { kind: "user", by: t.id, of: h.id, text: `你说「${h.title}」不用了${why ? `：${why}` : ""}` });
    return { t, h };
  });
  if (worker(t)) await wake(ctx, t.id, { how: `你说「${h.title}」不用了`, fold: false, text: `你请用户做 / 答的「${h.title}」（${h.id}），用户说不用了${why ? `：${why}` : ""}。别再等它：换个做法接着做，真的少不了就用 ask_human 说明为什么再问一次。` }).catch(() => {});
  return { ask: h, task: t.id };
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
 * different now. { id: the ask (a5) }. Its worker is woken to ask it again as things stand (ask_human with replaces: it
 * then shows at the bottom of the feed) or take it back; the user doesn't scroll up to answer an old version of it.
 */
export async function refreshAsk(input: { id: string }, ctx: Ctx) {
  const { t: w, a: h } = findAsk(load(ctx).store, input.id);
  if (h.status !== "open") throw new Error(`「${h.title}」已经不在等你了`);
  if (!w.session) throw new Error(`${w.id} 没有 worker 对话`);
  const qs = (h.questions ?? []).filter((q) => !q.dropped && q.answer == null);
  const ids = qs.length ? qs.map((q) => `${h.id}#${q.id}「${q.title}」`).join("、") : `${h.id}「${h.title}」`;
  update(ctx, (s) => Object.assign(findAsk(s, h.id).a, { refreshing: Date.now() }));
  await wake(ctx, w.id, {
    how: "你请它更新问题",
    text:
      `[任务面板] 用户请你把还在问他的 ${ids} 按现在的情况更新：这些是在你们后来的对话之前问的。\n` +
      `- 还要问但问法变了：ask_human 带 replaces（写上旧的 id）重新问，写清现在的情况和选项；\n` +
      `- 已经不用问了：cancel_human，说明原因；\n` +
      `- 还是原样要问：不用改，在回复里说一句「这个问题还是要你定」。\n做完就结束这一轮。`,
    feed: `你请 ${w.repo?.split("/").pop() || w.id} 按最新情况更新「${h.title}」`,
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
      closing.push(...helperSessions(ctx, x));
    }
    activity(s, t, { kind: "user", by: t.id, text: `你放弃了${t.team ? "这部分" : ""}${input.reason ? `：${input.reason}` : ""}` });
    return t;
  });
  for (const id of closing) if ((ctx.sessions as any).close) await (ctx.sessions as any).close(id).catch(() => {});
  return t;
}

/**
 * A card not sent out yet (the secretary drafted it into 待办 for the user to look over) that the user wants redone in
 * their own words rather than by editing it: the secretary rewrites it in place (title, prompt, repository, agent),
 * splits it into more 待办 cards or drops it, and leaves it in 待办 for another look. Before 2026-11-16 this threw
 * "直接改任务内容再派": fine for a card the user wrote, but a card the secretary drafted from a long message is the
 * secretary's to redo; the user only says what's wrong. Settled when its turn ends (_main.ts sweep).
 */
async function redraft(t: Task, feedback: string, ctx: Ctx) {
  if (t.routing) throw new Error(`${t.id} 秘书正在派，等它派完再说`);
  const block = [
    `[重排 ${t.id}] ${t.title}`,
    `这张卡还在待办、没派出去，用户看了不满意，要你按他的意见重排。`,
    `现在的卡：仓库 ${t.repo ?? "（没选）"}${t.agent ? `，agent ${t.agent}` : ""}${t.model ? `，模型 ${t.model}` : ""}`,
    t.origin ? `来源：${t.origin.title ?? t.origin.source}${t.origin.url ? ` ${t.origin.url}` : ""}` : "",
    `现在的说明：\n${t.prompt ?? t.title}`,
    t.remark?.trim() ? `用户的备注（他自己写的，派出去时附在说明后面）：${t.remark.trim()}` : "",
    `用户的意见：${feedback}`,
    `照意见改这张卡：tasks.edit '{"id":"${t.id}","title":"…","prompt":"…","repo":"/绝对路径","agent":"…"}'（只写要改的）；` +
      `要拆成几件，这张改成第一件，其余用 tasks.add 建成新卡（不加 start，留在待办）；整件事不用做了，tasks.drop 写 reason。` +
      `**改完留在待办，不要派出去**，用户要再看一遍；除非他的意见里明说了改好就派。`,
  ]
    .filter(Boolean)
    .join("\n");
  update(ctx, (s) => {
    const x = find(s, t.id);
    x.reroute = { feedback, at: Date.now(), was: draftOf(x) };
    activity(s, x, { kind: "user", by: x.id, text: `你让秘书重排：${feedback}` });
  });
  try {
    return await rerouteTask(ctx, t.id, block);
  } catch (e) {
    update(ctx, (s) => (find(s, t.id).reroute = undefined));
    throw e;
  }
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
  if (!root) throw new Error(`没有 ${input.id}`);
  if (root.status === "todo" && !root.session) return redraft(root, feedback, ctx);
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
 * A handover takes the old task's asks with it: what it asked the user is still needed, now by the new one. Until
 * 2026-11-05 they stayed with the old task: t11 was dropped for t52 to take over, its "approve the release" (t51) was
 * dropped as nothing needed it any more, and the user lost it from 等你 while t52 waited on it. The ones the old task
 * still had open move over; their answers then wake the new worker.
 */
function takeOver(ctx: Ctx, id: string, from: string) {
  update(ctx, (s) => {
    const t = find(s, id);
    const old = find(s, from);
    const moving = (old.asks ?? []).filter((a) => a.status === "open");
    if (moving.length) {
      old.asks = (old.asks ?? []).filter((a) => !moving.includes(a));
      t.asks = [...(t.asks ?? []), ...moving.map((a) => ({ ...a, updatedAt: Date.now() }))];
      // The old task's waits on them would end as "不在了": they aren't over, they moved
      for (const w of old.waits ?? []) if (w.item && moving.some((a) => a.id === w.item) && !w.end) w.end = { how: `交给了 ${t.id}`, at: Date.now() };
    }
    // The card's first line: whose work this goes on with (the feed used to start at its first wait)
    activity(s, t, { kind: "join", by: t.id, text: `接手了 ${old.id}「${old.title}」${moving.length ? `，连同要你做的：${moving.map((h) => h.title).join("；")}` : ""}` });
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
/**
 * The archive (_archive.ts): requirements finished more than 设置 → archiveDays ago, newest first, each with its
 * tasks (id, title, status, when done, last summary). q: only those whose id / title / summary / repository has it.
 * Asking for one by id anywhere (tasks.list {id}, any action) brings it back; so does tasks.unarchive.
 */
export function archived(input: { q?: string; limit?: number } | null, ctx: Ctx) {
  const q = input?.q?.trim().toLowerCase();
  const hit = (t: { id: string; title: string; summary?: string; repo?: string }) => [t.id, t.title, t.summary, t.repo].some((x) => x?.toLowerCase().includes(q!));
  const groups = archivedGroups(ctx).filter((g) => !q || g.tasks.some(hit));
  return { groups: groups.slice(0, input?.limit ?? 200).map((g) => ({ ...g, doneAt: latest(g) })), total: groups.length };
}

/**
 * Finds tasks by words, on the board and in the archive: { q: words separated by spaces — a task matches when any is in
 * its title, request, latest summary, origin (who sent it, where) or notes, or, for a live one (_clues.ts liveTasks),
 * in what was said in its worker's conversation lately; limit?: 20 }. One line each, newest first, for an agent
 * connecting a message or a person to work (the secretary before letting a message go). Then tasks.list {id} for the
 * one it wants. The conversation counts because ids and names a worker deals with are often only there: 2026-11-23,
 * the defect numbers t123 had fixed and told the tester about were in no title or summary.
 */
export function search(input: { q: string; limit?: number }, ctx: Ctx) {
  const words = (input?.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('q 写要找的词，空格分开：{"q":"模型 客服"}');
  const hit = (...xs: (string | undefined)[]) => {
    const all = xs.filter(Boolean).join("\n").toLowerCase();
    return words.filter((w) => all.includes(w)).length;
  };
  const cut = (x: string, n: number) => cutLine(x.replace(/\s+/g, " "), n);
  const rows: { at: number; n: number; line: string }[] = [];
  const tasks = load(ctx).store.tasks;
  const live = new Set(liveTasks(tasks).map((t) => t.id));
  for (const t of tasks) {
    const own = hit(t.id, t.title, t.prompt, t.summary, t.repo, t.origin?.title, ...(t.notes ?? []).map((x) => x.text));
    const n = live.has(t.id) ? hit(t.id, t.title, t.prompt, t.summary, t.repo, t.origin?.title, ...(t.notes ?? []).map((x) => x.text), said(ctx, t)) : own;
    if (n) rows.push({ at: t.updatedAt ?? t.createdAt, n, line: `- ${t.id}「${t.title}」(${t.status})${t.origin?.title ? ` 来自 ${cut(t.origin.title, 40)}` : ""}${t.summary ? `：${cut(t.summary, 120)}` : ""}${n > own ? "（词在它的对话里）" : ""}` });
  }
  for (const g of archived({ limit: 1000 }, ctx).groups)
    for (const t of g.tasks as any[]) {
      const n = hit(t.id, t.title, t.summary, t.repo);
      if (n) rows.push({ at: t.doneAt ?? 0, n, line: `- ${t.id}「${t.title}」(已归档)${t.summary ? `：${cut(t.summary, 120)}` : ""}` });
    }
  rows.sort((a, b) => b.n - a.n || b.at - a.at);
  const lim = input?.limit ?? 20;
  return rows.length ? rows.slice(0, lim).map((r) => r.line).join("\n") + (rows.length > lim ? `\n（还有 ${rows.length - lim} 个，换更具体的词）` : "") : `没有任务带「${words.join("」「")}」`;
}

/** Puts an archived requirement (the one holding task `id`) back on the board, under 已完成. */
export function unarchive(input: { id: string }, ctx: Ctx) {
  if (!bringBack(ctx, input.id)) throw new Error(`${input.id} 不在归档里`);
  return { ok: true };
}

export function restore(input: { id: string }, ctx: Ctx) {
  return update(ctx, (s) => {
    const t = find(s, input.id);
    if (t.status !== "dropped") throw new Error(`${t.id} 没有被放弃`);
    for (const x of t.team ? [t] : members(s, t)) {
      if (x.status !== "dropped" || (x !== t && !x.droppedFrom)) continue;
      note(x, "恢复了（撤销放弃）");
      Object.assign(x, { status: x.droppedFrom ?? (x.session ? "running" : "todo"), droppedFrom: undefined, doneAt: undefined, updatedAt: Date.now() });
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
  // Read once: isMain reads the secretary's whole state file (600 KB+) each time, and every task the main session
  // dispatched asks again on each tasks.list (it is never marked closed) — 38 reads, ~0.4 s of every list (2026-11-18)
  const main = new Set(mains(ctx));
  const done = update(ctx, (s) => {
    const out: string[] = [];
    for (const t of s.tasks) {
      if (!t.router || t.routerClosed || (t.status === "todo" && t.routing)) continue; // still being routed
      if (main.has(t.router)) continue; // the Superagent's main session: it stays for the next one
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

/**
 * Where an ask stands, cheaply (the chat's task-step card asks for it): status, and what the user handed back. { id:
 * a5, a5#2 for one question of several, or a human task's old id (t206) for a card drawn before 2026-11-19 }.
 */
export function status(input: { id: string }, ctx: Ctx) {
  // One of the secretary's own questions (sN, _secask.ts): drawn by the same card
  if (isSecAsk(String(input?.id ?? ""))) return secStatus(String(input.id), ctx);
  let found;
  try {
    found = findAsk(load(ctx).store, String(input?.id ?? ""));
  } catch {
    return { status: "missing" };
  }
  return askState(found.a, found.q);
}

/**
 * Answers one question of an ask with several: { id, q, value }. The answers wait on the ask until every question has
 * one; then it's done and the worker hears them all in one message. Answering one again changes it: before the rest
 * are answered nobody has acted on it yet; after, the worker is told what changed.
 */
export async function answerQuestion(input: { id: string; q: string; value: string }, ctx: Ctx) {
  const value = input?.value?.trim();
  if (!value) throw new Error("选一个，或者写下你的答案");
  let changed: { q: Question; old: string } | null = null;
  let finished = false;
  const { t, h } = update(ctx, (s) => {
    const { t, a: h } = findAsk(s, input.id);
    const q = h.questions?.find((x) => x.id === String(input.q));
    if (!q) throw new Error(`${h.id} 没有第 ${input.q} 个问题`);
    if (h.status === "dropped" || q.dropped) throw new Error(`这个问题已经不需要了`);
    changed = null;
    finished = false;
    const old = q.answer;
    if (old === value) return { t, h };
    q.answer = value;
    if (h.status === "done" && old) {
      changed = { q, old };
      note(t, `改了「${q.title}」的答案：${old} → ${value}`);
    } else if (asked(h).every((x) => x.answer)) {
      finished = true;
      finish(s, t, h);
    }
    if (h.status === "done") h.handedBack = summary(h);
    h.updatedAt = Date.now();
    return { t, h };
  });
  if (finished) {
    await deliver(ctx, t, h);
  } else if (changed && worker(t)) {
    const c = changed as { q: Question; old: string };
    await tell(ctx, t, `用户改了「${c.q.title}」（${h.id}）的答案：原来是「${c.old}」，现在是「${value}」。\n按新的来；已经照旧答案做了的，改过来。`).catch(() => {});
  }
  return { ask: h, task: t.id, done: h.status === "done" };
}

/** Its worker, still there to be told (a conversation, the task not dropped or done). */
function worker(t: Task) {
  return !!t.session && t.status !== "dropped" && t.status !== "done";
}

/** All of h's questions are answered or set aside: it's done, and the feed says what the user answered. */
function finish(s: Store, t: Task, h: Ask) {
  Object.assign(h, { status: "done", handedBack: summary(h), doneAt: Date.now() });
  for (const q of asked(h)) q.sent = true;
  activity(s, t, { kind: "user", by: t.id, of: h.id, text: `你答了 ${asked(h).length} 个问题：${summary(h)}` });
}

/** The answers of a finished ask go to its worker, with the questions the user set aside. */
async function deliver(ctx: Ctx, t: Task, h: Ask) {
  if (!worker(t)) return;
  const skipped = (h.questions ?? []).filter((q) => q.skipped);
  const text =
    `你问的问题（${h.id}），用户${asked(h).length ? "答了" : "都没答"}：\n${asked(h).map((q, i) => `${i + 1}. ${q.title}\n   → ${q.answer}`).join("\n")}` +
    (skipped.length ? `\n用户说不用答了（已经过时，别再按它们做）：${skipped.map((q) => `「${q.title}」`).join("、")}` : "") +
    `\n照这些接着做。`;
  await wake(ctx, t.id, { how: `你答了「${h.title}」`, text, fold: false }).catch(() => {});
}

/**
 * The user sets a question aside (不用答了): it went moot and the worker didn't take it back (t63#1, 2026-11-05).
 * { id, q }. When the rest are answered, everything goes to the worker now, saying this one was set aside.
 */
export async function skipQuestion(input: { id: string; q: string }, ctx: Ctx) {
  let finished = false;
  const { t, h } = update(ctx, (s) => {
    const { t, a: h } = findAsk(s, input.id);
    const q = h.questions?.find((x) => x.id === String(input.q));
    if (!q) throw new Error(`${h.id} 没有第 ${input.q} 个问题`);
    if (h.status !== "open" || q.dropped) throw new Error(`这个问题已经不在等你了`);
    if (q.answer != null) throw new Error(`这个问题你已经答了：${q.answer}`);
    finished = false;
    Object.assign(q, { dropped: "你说不用答了", skipped: true });
    note(t, `用户说「${q.title}」不用答了`);
    activity(s, t, { kind: "user", by: t.id, of: h.id, text: `你说「${q.title}」不用答了` });
    const left = asked(h);
    if (!left.length) {
      // Nothing left to ask: the ask goes, and its worker hears that none of it is needed
      Object.assign(h, { status: "dropped", doneAt: Date.now() });
      finished = true;
    } else if (left.every((x) => x.answer != null)) {
      finished = true;
      finish(s, t, h);
    }
    h.updatedAt = Date.now();
    return { t, h };
  });
  if (finished) await deliver(ctx, t, h);
  return { ok: true };
}

/**
 * The ✕ on a question card (2026-11-19): the user ignores it — usually it went moot and the agent that asked never took
 * it back. { id: a5, a5#2 (one question of several) or sN (the secretary's) }. Nobody is woken for it: the agent hears
 * at the start of its next turn (ignoredLead; the secretary's: _main.ts secIgnoredLead). One question of several while
 * others are open or answered: set aside as 不用答了, and once the rest are answered they go to the worker saying so
 * (skipQuestion); the last one open makes the whole ask ignored.
 */
export async function ignore(input: { id: string }, ctx: Ctx) {
  const id = String(input?.id ?? "");
  if (isSecAsk(id)) return closeSec({ id }, ctx);
  const [aid, qid] = id.split("#");
  if (qid) {
    const h = findAsk(load(ctx).store, aid).a;
    const left = (h.questions ?? []).filter((q) => !q.dropped && q.answer == null && q.id !== qid);
    const answered = (h.questions ?? []).some((q) => !q.dropped && q.answer != null);
    if (left.length || answered) return skipQuestion({ id: aid, q: qid }, ctx);
  }
  update(ctx, (s) => {
    const { t, a: h } = findAsk(s, aid);
    if (h.status !== "open") throw new Error(`「${h.title}」已经不在等你了`);
    for (const q of h.questions ?? []) if (!q.dropped && q.answer == null) Object.assign(q, { dropped: "你忽略了", skipped: true });
    // Said with the worker's next message, whoever sends it (noteIgnored); untold only on a Gerdr without notes
    const told = noteIgnored(ctx, t.session, h);
    Object.assign(h, { status: "dropped", dropReason: "你忽略了", ignored: true, told, doneAt: Date.now(), updatedAt: Date.now() });
    activity(s, t, { kind: "user", by: t.id, of: h.id, text: `你忽略了「${h.title}」` });
  });
  return { ignored: id };
}

/**
 * 先把已答的发给它: the answers given so far go to the worker now, the rest stay on the board for later. { id }.
 * Answering all at once stays the default (the worker usually needs them together); this is for going on meanwhile.
 */
export async function sendAnswered(input: { id: string }, ctx: Ctx) {
  let fresh: Question[] = [];
  let rest: Question[] = [];
  const { t, h } = update(ctx, (s) => {
    const { t, a: h } = findAsk(s, input.id);
    if (h.status !== "open" || !h.questions) throw new Error(`「${h.title}」已经不在等你了`);
    fresh = asked(h).filter((q) => q.answer != null && !q.sent);
    rest = asked(h).filter((q) => q.answer == null);
    if (!fresh.length) throw new Error("还没有答了没发的");
    for (const q of fresh) q.sent = true;
    activity(s, t, { kind: "user", by: t.id, of: h.id, text: `你先发了答案：${fresh.map((q) => `${q.title}：${q.answer}`).join("；")}` });
    h.updatedAt = Date.now();
    return { t, h };
  });
  if (worker(t))
    await wake(ctx, t.id, {
      how: `你先发了已答的`,
      fold: false,
      text:
        `用户先把答了的发给你（${h.id}）：\n${fresh.map((q) => `- ${q.title}\n  → ${q.answer}`).join("\n")}\n` +
        `还没答、之后再答的：${rest.map((q) => `${h.id}#${q.id}「${q.title}」`).join("、")}（答了会再发给你）。能照已答的先做的就先做；还没答的里已经不用问的，cancel_human 它。`,
    }).catch(() => {});
  return { sent: fresh.length };
}

/** The questions still asked (not taken back). */
function asked(h: Ask) {
  return (h.questions ?? []).filter((q) => !q.dropped);
}

function summary(h: Ask) {
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
  const { t, h } = update(ctx, (s) => {
    const { t, a: h } = findAsk(s, input.id);
    if (h.status !== "done") throw new Error(`「${h.title}」还没答，直接答就行`);
    if (h.handBack.kind !== "choice" && h.handBack.kind !== "value") throw new Error(`「${h.title}」没有可以改的答案`);
    old = h.handedBack ?? "";
    if (old === value) return { t, h };
    note(t, `改了「${h.title}」的答案：${old} → ${value}`);
    Object.assign(h, { handedBack: value, updatedAt: Date.now() });
    return { t, h };
  });
  if (old === value) return { ask: h, changed: false };
  const what = h.handBack.kind === "choice" ? "决定" : h.handBack.label || "交回的值";
  const told = t.session && t.status !== "dropped";
  if (told) await tell(ctx, t, `用户改了「${h.title}」（${h.id}）的${what}：原来是「${old}」，现在是「${value}」。\n按新的来；已经照旧答案做了的，改过来（改不了的用 ask_human 说明）。`).catch(() => {});
  return { ask: h, changed: true, told: told ? [t.id] : [] };
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
