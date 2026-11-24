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
//   For an MR that trigger is also the subscription the GitLab add-on polls by (gerdr docs/dev/EVENTS.md, "Sources,
//   subscriptions and Gerdr"): written here, the add-on starts on it within seconds; swept (tick), it stops.
//   Followed while waiting only (_waits.ts waitingOn), not added to the task's threads: a colleague's next DM, days
//   later and about something else, is not this task's news.
// - check: a command the worker wrote that says whether it has happened (a publish approved, a job done), run here every
//   few minutes (tick → runChecks): exit 0 wakes it with the output. Watching a state is no fixed event: each wait has
//   its own, so the worker writes it (2026-11-04: waiting on a colleague to approve a publish, only his DM reply would
//   have woken it — not the approval itself).
// - recheck: woken anyway after that many minutes.
// Meanwhile the card stays in 进行中 showing what it waits on and the latest check. A wait ends when one of its own
// items comes (that wait_for only: others stay open), the task ends, or the worker takes it back (cancel_wait, wait_for
// replaces). The worker running again doesn't end it: until 2026-11-23 it did, and a worker woken by the user lost
// the colleague it was waiting on; the user wants the agent to cancel, not the board to guess.

import { activity, going, load, memberName, members, note, reqOf, teamOf, update, type Task } from "./_store";
import { endGroups, isOutside, mrConversation, open, outsideGroups, waitOn, wakeItem, wakeText, type Wait, type WakeOn } from "./_waits";

const sessionTitle = (w: Wait) => w.what.replace(/^它派出的「(.*?)」.*$/, "$1");
import { cutLine, wake } from "./_wake";
import { waitsState } from "./_cardstate";
import { evaluate, followUp, follows, record, sharers, subscribers, compact, type Ev } from "./_main";
import { mine, staleAsks } from "./board";
import { USER } from "./_user";

const DIR = `${USER}/triggers`;
const PREFIX = "follow-";
const FN = "waits.onFollowed";
/** An MR's trigger: it waits for the MR's state (a condition on it), not for events — see onState. */
const STATE_FN = "waits.onState";
const DAY = 86_400_000;

export const tools = {
  wait_for: {
    description:
      "End your turn waiting on someone or something outside, instead of only saying you'll wait (once your turn ends nothing wakes you otherwise). " +
      "wake: what wakes you, a list — whichever comes first wakes you, and ends this wait. Each item is one of: " +
      "{type: message, conversation}: news where a person will answer — a Slack DM id (D09…), a Slack message link or the event id you got (slack-me:C0…:<ts>, for a thread in a channel), a small channel's id (C0…, only when the slack-me add-on takes small channels in full), or an MR URL (its reviews, pipelines, merge come too); " +
      "{type: check, command, every?, cwd?}: a command that tells whether what you wait for has happened (a publish approved, a job finished, a page live) — the board runs it every `every` minutes, exit 0 = it has (you're woken with its output), any other exit = not yet; exit 0 as soon as things leave the step you wait in, not only on the end you hope for ([ \"$s\" != pending_approval ], not [ \"$s\" = success ]) — rejected, stuck halfway or failed must wake you too; waiting on a person (approve, merge), check that act itself, don't assume what should follow it happens by itself; print one line saying where things stand, it shows on your card; " +
      "{type: time, minutes}: the timeout, required: woken after that long if nothing else came; " +
      "Every wait needs a time item as its timeout (how long it should take): whoever you wait on may never answer — stuck, offline, forgot; a wait without one is refused. Handed work to a session you started (gerdr session new, here or on another computer)? You are the one who waits for it, the same way: its report wakes you first; past the timeout, go and see where it's stuck. " +
      "Waiting on a person to do something you can see (approve, merge, deploy)? Give both a message and a check. " +
      "Your card stays in progress meanwhile, showing `what`. When the last thing you waited on came and you got something done with it (it went live, a check passed), say that result in your reply first. Then end your turn; when woken and still waiting, call it again. " +
      "What you wait on stays open until one of its own items comes or you take it back — not when you're woken by something else or carry on working: when you no longer wait for it (it came another way, you changed course), cancel_wait it; waiting for the same thing in a new way, wait_for with replaces. When to use: the superagent-panel skill, references/task.md.",
    input: {
      type: "object",
      properties: {
        what: { type: "string", description: "What you wait for, for the card: 程志鹏审批香港生产发布单 publish-03d1…" },
        replaces: {
          type: "array",
          items: { type: "string" },
          description: "Waits of yours this one replaces (their ids, w3, as wait_for's result and my_task give them): taken back with this one",
        },
        wake: {
          type: "array",
          minItems: 1,
          description: "What wakes you; whichever comes first",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["message", "check", "time"] },
              conversation: { type: "string", description: "message: a Slack DM id, a Slack message link or event id (slack-me:C0…:<ts>), a small channel's id, or an MR URL" },
              until: {
                type: "string",
                description:
                  "message with an MR URL, optional: the condition on the MR's state that wakes you, one JavaScript expression over its fields, e.g. `state != 'opened' || pipeline == 'failed' || reviews > 3`, or `notes.some(n => n.author != me && n.resolvable && !n.resolved)` (fields: state, pipeline, pipeline_id, reviews, unresolved, last_note, conflict, need_rebase, mergeable, approvals, head, me, notes; `gerdr wait sources` says what each means). Left out: anything new from now on — merged / closed, more comments by others, a pipeline finishing, a conflict, a rebase needed, mergeable. Checked against the MR as it is, so what already happened wakes you at once",
              },
              command: { type: "string", description: "check: run with sh -c, 60 s at most; exit 0 = it has happened, or things left the step you wait in (any change from it, not only the hoped-for end). Use the tools you already use for this work" },
              every: { type: "number", description: "check: minutes between runs (1 – 60, default 2)" },
              cwd: { type: "string", description: "check: absolute directory to run it in (default: the task's repository)" },
              minutes: { type: "number", description: "time: woken after this many minutes (1 – 1440)" },
            },
            required: ["type"],
          },
        },
      },
      required: ["what", "wake"],
    },
  },
  cancel_wait: {
    description:
      "Take back something you waited on with wait_for (its id, w3, as wait_for's result and my_task's waits give it): it came another way, it no longer matters, or you changed course. It stops showing on your card and no longer wakes you. Nothing else ends a wait for you: being woken by something else or working on doesn't, so take back what's moot as soon as you see it.",
    input: { type: "object", properties: { id: { type: "string" }, reason: { type: "string", description: "Why, in a few words (同事在私信里已经答了)" } }, required: ["id", "reason"] },
  },
};

/** Which conversation a worker means, as events name it: { source, key }, from what has come from it lately. */
function resolve(ctx: Ctx, conv: string): { source: string; key: string; where: string; url?: string } {
  const c = conv.trim();
  // An MR: its events come from the GitLab add-on as gitlab, <host>/group/repo!34 — review, pipeline, merge…
  const asMr = mrConversation(c);
  if (asMr) return asMr;
  const since = Date.now() - 30 * DAY;
  // Slack (slack-me) keys a DM, group DM or small channel by its id and its threads as <channel>/<thread ts>; a channel
  // you're only @-mentioned in, by thread alone (<channel>/<ts of the first message>). So a bare C… id matches only a
  // small channel's top level: 2026-11-23 a worker gave one for the thread it was @-mentioned in and was told the
  // channel didn't exist. A message link or the event's id names the thread itself.
  const keys: string[] = [c];
  const link = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(c);
  const evId = /^[\w-]+:([A-Z0-9]+):(\d+\.\d+)$/.exec(c);
  if (link) {
    const thread = /[?&]thread_ts=(\d+\.\d+)/.exec(c)?.[1];
    const ts = `${link[2]}.${link[3]}`;
    if (thread) keys.push(`${link[1]}/${thread}`);
    keys.push(`${link[1]}/${ts}`, link[1]);
  } else if (evId) {
    const hit = ctx.events.list({ key: `${evId[1]}*`, since, limit: 1000 }).find((e) => e.id === c);
    if (hit?.key) keys.push(hit.key);
    keys.push(`${evId[1]}/${evId[2]}`, evId[1]);
  } else if (/\/archives\/([A-Z0-9]+)/.test(c)) keys.push(/\/archives\/([A-Z0-9]+)/.exec(c)![1]);
  for (const key of keys) {
    // The source comes from a message that came in there (it has a reply address), not from the newest event with the
    // key: ctx.events.reply keeps the key, so a draft the user sent from the outbox is an event there too, under this
    // panel's own reply source (lb-gerdr-panel-taskboard). 2026-11-24, t266: a wait followed that source, so the user's
    // next send woke the worker as if the colleague had answered, and the colleague's real answer would have woken nobody.
    const all = ctx.events.list({ key, since, limit: 50 });
    const came = all.filter((x) => x.reply);
    const seen = came.length ? came : all;
    if (seen.length) {
      // For the chat's card: where, in words — "Slack 有人私聊我 · 石石 (Yang Lei)", not D09DJBLRF4K
      const e = seen[seen.length - 1];
      const kind = ctx.events.catalog().find((x) => x.on === `${e.source}/${e.kind}`)?.title || e.source;
      const { who, place } = compact(e);
      return { source: e.source, key, where: [kind, place, who || (place ? "" : key)].filter(Boolean).join(" · ") };
    }
  }
  const chan = /^[CG][A-Z0-9]+$/.test(c) ? c : "";
  if (chan && ctx.events.list({ key: `${chan}/*`, since, limit: 1 }).length)
    throw new Error(
      `「${c}」这个频道只有 @ 你的消息会进来，按线程算对话，单给频道 id 对不上：` +
        `给那条消息的事件 id（slack-me:${c}:<ts>）或消息链接。注意同事在这里不 @ 你的回话叫不醒你；` +
        `要等他回话，换成私信，或者让用户在 slack-me 插件设置里打开「小频道全收」（几个人的频道每句话都进来）`,
    );
  throw new Error(
    `没找到「${c}」这个对话：最近 30 天没有它的消息进来（可能这个来源的插件没开，或者写的不是频道 / 私信 id）。` +
      `只等状态变化的（job、发布）用 recheck 定时回来看；要人回话的，换成对方会回复的那个对话的 id 或链接`,
  );
}

type WakeIn = { type?: string; conversation?: string; until?: string; command?: string; every?: number; cwd?: string; minutes?: number; who?: string };

/** { what, wake: [{ type: message | check | time, … }], replaces?: ["w3"] }. */
export function wait_for(input: { what: string; wake?: WakeIn[]; replaces?: string[] | string }, ctx: Ctx) {
  const what = (input?.what ?? "").trim();
  if (!what) throw new Error("what 写清在等什么");
  const items: WakeIn[] = Array.isArray(input.wake) ? [...input.wake] : [];
  const replaces = (Array.isArray(input.replaces) ? input.replaces : input.replaces ? [input.replaces] : []).map(String);
  if (!items.length) throw new Error(`wake 至少给一项：不然没有什么会叫醒你。例：[{"type":"message","conversation":"D0…"},{"type":"time","minutes":60}]`);
  // Checked before anything is written; the conversation looked up (it may not exist)
  const parsed = items.map((x, i) => {
    const at = `wake[${i}]`;
    if (x.type === "message") {
      if (!x.conversation?.trim()) throw new Error(`${at}：message 要给 conversation`);
      const conv = resolve(ctx, x.conversation);
      if (x.until?.trim() && conv.source !== "gitlab") throw new Error(`${at}：until 只用在 MR 上（conversation 写 MR 的网址）`);
      return { type: "message" as const, conv, until: x.until?.trim() || undefined };
    }
    if (x.type === "check") {
      const command = x.command?.trim();
      if (!command) throw new Error(`${at}：check 要给 command`);
      const every = x.every == null ? 2 : Number(x.every);
      if (!(every >= 1 && every <= 60)) throw new Error(`${at}：every 是 1 到 60 分钟`);
      return { type: "check" as const, command, every, cwd: x.cwd?.trim() };
    }
    if (x.type === "time") {
      const m = Number(x.minutes);
      if (!(m >= 1 && m <= 1440)) throw new Error(`${at}：time 的 minutes 是 1 到 1440`);
      return { type: "time" as const, minutes: m };
    }
    throw new Error(`${at}：type 是 message / check / time 之一，不是「${x.type ?? ""}」`);
  });
  const { t, ws, others, stale } = update(ctx, (s) => {
    const t = mine(s, ctx);
    if (!going(t)) throw new Error(`${t.id} ${t.status === "done" ? "已经完成" : t.status === "dropped" ? "已经放弃" : "还没派出去"}，不用等`);
    const now = Date.now();
    const on: WakeOn[] = parsed.map((p) => {
      if (p.type === "message") return { type: "message", conv: p.conv };
      if (p.type === "time") return { type: "time", at: now + p.minutes * 60_000 };
      const cwd = p.cwd || t.repo || "";
      if (!cwd.startsWith("/")) throw new Error("check 的 cwd 要是绝对路径（任务没有仓库时必须给）");
      return { type: "check", command: p.command, every: p.every, cwd };
    });
    // Every wait has a deadline: whoever it waits on (a colleague, a session it handed work to, a teammate, a job) may
    // never answer — stuck, gone offline, forgot. Past it the worker is woken and looks, instead of waiting for good.
    if (!parsed.some((p) => p.type === "time")) {
      const out = open(t).filter((w) => w.kind === "session");
      throw new Error(
        `wake 里要有一项 {"type":"time","minutes":N} 作超时（按对方要多久估，1–1440）：等的人可能一直不回、卡住、下线。` +
          (out.length ? `你派出的${out.map((w) => `「${sessionTitle(w)}」`).join("、")}回报会先叫醒你；到了超时还没回报，你去看它卡在哪（gerdr session read）。` : "到点没等到，你去看怎么回事，再决定接着等、换做法还是 ask_human。"),
      );
    }
    for (const id of replaces) {
      const w = open(t).find((x) => x.id === id && isOutside(x));
      if (!w) throw new Error(`没有在等的 ${id}（my_task 的 waits 里有你还在等的）`);
      endGroups(t, (x) => x.since === w.since, "换成了新的等待");
    }
    const ws = waitOn(t, what, on);
    const others = outsideGroups(t).filter((g) => g.since !== ws[0]?.since);
    note(t, `等：${what}（${ws.map((w) => wakeText(w)).join("；")}）`);
    // Its own part is done and it waits on something it doesn't control (CI, a teammate, a colleague): a fact for the
    // requirement's feed, like a part done. The same wait again (woken, still waiting) isn't news.
    const root = reqOf(s, t);
    const last = (root?.activity ?? []).filter((a) => a.by === t.id).pop();
    if (root && !(last?.kind === "wait" && last.text === what)) activity(s, t, { by: t.id, kind: "wait", text: what });
    Object.assign(t, { viaTools: true, reportedAt: now, nudges: 0, updatedAt: now });
    return { t, ws, others, stale: staleAsks(s, t) };
  });
  // A trigger of its own for each conversation it waits on. An MR's waits for its state instead (onState): written
  // here, the GitLab add-on looks at the MR within seconds, and what already happened wakes the worker at once
  for (const p of parsed) {
    if (p.type !== "message") continue;
    if (p.conv.source === "gitlab") stateTrigger(ctx, p.conv, p.until);
    else ensureTrigger(ctx, p.conv);
  }
  return {
    id: t.id,
    gerdrCard: waitCard(ctx, t, ws),
    waitId: ws[0]?.id,
    note: `${ws.map((w) => wakeText(w).replace("叫醒它", "叫醒你").replace("它写的", "你写的")).join("；")}。哪个先到都会叫醒你；现在结束这一轮，不用再等。`,
    ...(others.length
      ? { stillWaiting: others.map((g) => `${g.id}「${g.what}」`).join("、") + "：你之前的等待都还开着。已经不用等的现在 cancel_wait；这次是换个方式等同一件事，就该用 replaces" }
      : {}),
    ...(stale ? { reminder: stale } : {}),
  };
}

/** Takes back a wait_for (any of its waits' ids: the whole wait_for goes): { id, reason }. */
export function cancel_wait(input: { id: string; reason: string }, ctx: Ctx) {
  const id = String(input?.id ?? "").trim();
  const reason = String(input?.reason ?? "").trim();
  if (!reason) throw new Error("reason 写一句为什么不等了");
  return update(ctx, (s) => {
    const t = mine(s, ctx);
    const w = open(t).find((x) => x.id === id && isOutside(x));
    if (!w) {
      const left = outsideGroups(t);
      throw new Error(`没有在等的 ${id}。${left.length ? `你还在等：${left.map((g) => `${g.id}「${g.what}」`).join("、")}` : "你现在什么都没在等"}`);
    }
    const ended = endGroups(t, (x) => x.since === w.since, `不等了：${reason}`);
    note(t, `不等「${w.what}」了：${reason}`);
    t.updatedAt = Date.now();
    const left = outsideGroups(t);
    return { ok: true, ended: ended.length, ...(left.length ? { stillWaiting: left.map((g) => `${g.id}「${g.what}」`).join("、") } : {}) };
  });
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
    wakes: ws.map(wakeItem),
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
  return waitsState(t, ws);
}

// ---- the trigger that brings a followed conversation in ----

function slug(s: string) {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

/**
 * An MR waited on: a trigger waiting until a condition on its state holds (Gerdr docs/dev/EVENTS.md, "Waiting for a
 * state"). Rewritten on every wait_for: the worker's expectation now. Without one: anything new from what the MR is
 * like now (its last reported state), so a worker woken and waiting again isn't woken at once by what it just handled.
 */
function stateTrigger(ctx: Ctx, th: { source: string; key: string }, until?: string) {
  const p = `${DIR}/${PREFIX}${slug(th.source)}-${slug(th.key)}.json`;
  ctx.fs.mkdir(DIR);
  // `on` is for a Gerdr from before triggers could wait for states: it reads this as an event trigger matching
  // nothing (no source emits gitlab/state), instead of a broken file that would stop all of this panel's triggers
  ctx.fs.write(p, JSON.stringify({ source: th.source, key: th.key, until: until || newFromNow(ctx, th.key), on: `${th.source}/state`, fn: STATE_FN, name: `任务在等的 MR：${th.key}` }, null, 2) + "\n");
}

/** "Anything new from now" on an MR, from the values it has now (none known yet: anything at all worth a look). */
function newFromNow(ctx: Ctx, key: string) {
  // ctx.states is missing on a Gerdr from before waiting for states: then nothing is known
  const now = typeof ctx.states?.get === "function" ? ctx.states.get("gitlab", key) : null;
  const st = now?.state as Record<string, any> | undefined;
  if (!st) return "state != 'opened' || reviews > 0 || pipeline == 'failed' || conflict || need_rebase || mergeable";
  const done = ["success", "failed", "canceled"].includes(st.pipeline);
  const parts = [
    "state != 'opened'",
    `reviews > ${Number(st.reviews) || 0}`,
    // A pipeline finishing: the one running now, or a new one if the current one is finished already
    done ? `(pipeline_id != ${Number(st.pipeline_id) || 0} && (pipeline == 'success' || pipeline == 'failed'))` : "pipeline == 'success' || pipeline == 'failed'",
  ];
  if (!st.conflict) parts.push("conflict");
  if (!st.need_rebase) parts.push("need_rebase");
  if (!st.mergeable) parts.push("mergeable");
  return parts.join(" || ");
}

/**
 * An MR's condition holds ({ state, detail, url, source, key, until, trigger }, from Gerdr): the tasks following
 * it get it as a follow-up, and the trigger goes (it ran once; the worker waits again with wait_for if it must).
 */
export async function onState(input: { state: Record<string, unknown>; detail?: string; url?: string; source: string; key: string; until: string; trigger: string }, ctx: Ctx) {
  if (!input?.key || !input.state) throw new Error("没有状态（这个函数由 user/triggers/follow-*.json 里带 until 的触发器调用）");
  const own = `${DIR}/${input.trigger}.json`;
  if (input.trigger && ctx.fs.stat(own)) ctx.fs.trash(own);
  const iid = /!(\d+)$/.exec(input.key)?.[1];
  // Lists (an MR's notes) are for conditions to filter, not to read here: their length
  const fields = Object.entries(input.state)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length} 项]` : v && typeof v === "object" ? "{…}" : v}`)
    .join(" ");
  const ev: Ev = {
    id: `${input.source}:state:${input.key}:${Date.now()}`,
    source: input.source,
    kind: "state",
    key: input.key,
    title: `${iid ? `MR !${iid}` : input.key} 等到了：${input.until}`,
    text: `现在：${fields}\n\n${input.detail ?? ""}\n\n（这次等待结束了。还要接着等，就再调 wait_for：不写 until 就是「从现在起有新情况」）`,
    url: input.url,
  };
  const { store } = load(ctx);
  const owners = subscribers(store.tasks, ev);
  if (!owners.length) return { nobody: true };
  for (const t of owners) await followUp(ctx, t.id, ev);
  const it = record(ctx, ev, { state: "delivered", tasks: owners.map((t) => t.id) });
  return { item: it.id, delivered: it.tasks };
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
  if (!owners.length) {
    // Its tasks all ended: a person saying more there is the secretary's to judge (more work on one, or not)
    if (!ev.actor || !sharers(store.tasks, ev).length) return { nobody: true };
    const it = record(ctx, ev, { state: "pending", sentAt: Date.now() });
    await evaluate(ctx, [it.id], store.tasks);
    return { item: it.id, pending: true };
  }
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
    .store.tasks.filter(going)
    .flatMap((t) => open(t).filter((w) => w.kind === "time" && (w.at ?? 0) <= now).map((w) => ({ t, w })));
  const woke: string[] = [];
  for (const { t, w } of due) {
    try {
      // Work it handed out that hasn't come back by now: the timeout it set. Say so, and what to do about it
      const out = open(t).filter((x) => x.kind === "session");
      const late = out.length
        ? `\n你派出的还没回报：${out.map((x) => x.what.replace(/^它派出的/, "")).join("；")}。用 gerdr session read 看它卡在哪：在等批准就 ask_human 让用户批；卡住了、那台电脑下线了、做偏了，就换个做法、自己接手或 ask_human，别再原样干等。`
        : "";
      await wake(ctx, t.id, {
        how: "到点了，回来看",
        text: `[任务面板] 到时间了，回来看一下（任务 ${t.id}）：${w.what}。${late}`,
        // That wait_for ends (all its items): it looks again and waits again if it must. Others stay open
        ends: (x) => x.since === w.since && isOutside(x),
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
    .store.tasks.filter(going)
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
          fold: code === 0 ? `[任务面板] 等到了「${cutLine(w.what, 30)}」：${cutLine(last.out || "exit 0", 50)}` : `[任务面板] 检查命令连着 3 次出错：${cutLine(w.what, 30)}`,
          text:
            code === 0
              ? `[任务面板] 你等的「${w.what}」检查到了（任务 ${t.id}）。检查命令的输出：\n\n${tail || "（没有输出）"}`
              : `[任务面板] 你为「${w.what}」写的检查命令连着 3 次没跑成（任务 ${t.id}）：\n\n${tail}\n\n看看命令哪里不对，改好再 wait_for。`,
          ends: (x) => x.since === w.since && isOutside(x),
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

/**
 * The triggers wait_for wrote (user/triggers/follow-*.json), for the 触发器 page: they are triggers too, and the page
 * says of each where its events go. One row each: { id, on, key, fn, name, tasks: the live tasks waiting on it }.
 */
export function followed(input: unknown, ctx: Ctx) {
  if (!ctx.fs.stat(DIR)) return [];
  const live = load(ctx).store.tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
  const out: { id: string; on: string; key?: string; fn: string; name?: string; tasks: string[] }[] = [];
  for (const f of ctx.fs.list(DIR)) {
    const name = f.path.split("/").pop() ?? "";
    if (f.dir || !name.startsWith(PREFIX) || !name.endsWith(".json")) continue;
    try {
      const t = JSON.parse(ctx.fs.read(f.path));
      if (t.fn !== FN && t.fn !== STATE_FN) continue;
      const source = t.source || String(t.on).split("/")[0];
      const tasks = live.filter((x) => follows(x).some((th) => th.source === source && th.key === t.key)).map((x) => `${x.id}「${x.title}」`);
      out.push({ id: name.slice(0, -5), on: t.on, key: t.key, fn: t.fn, name: t.name, tasks });
    } catch {
      // a broken file is Gerdr's to report
    }
  }
  return out;
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
      if (t.fn !== FN && t.fn !== STATE_FN) continue;
      const source = t.source || String(t.on).split("/")[0];
      if (live.some((x) => follows(x).some((th) => th.source === source && th.key === t.key))) continue;
    } catch {
      continue;
    }
    ctx.fs.trash(f.path);
    out.push(name);
  }
  return out;
}
