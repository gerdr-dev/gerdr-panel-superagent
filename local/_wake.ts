// The one way a waiting task's worker is woken (_waits.ts has why). Whatever came — a message in a conversation it
// follows (a colleague's DM, an MR review, a failed pipeline: _main.ts followUp), the time it asked to look again
// (waits.ts tick), the user's answer or step done on the board (tasks.ts complete / answer / answerQuestion) — it:
//   1. ends the waits it answers, saying how (the chat's wait card, the 在等 list and the trail show it);
//   2. marks the long waits it only touched (an MR still to merge) as woken, by what;
//   3. picks an ended task up again when asked to (resume: a person speaking in its conversation);
//   4. tells the worker, in one message.
// A session it handed work to reports to the worker through Gerdr itself, not here: its wait ends when the session
// does (_waits.ts syncSessions).

import { activity, find, update, type Task } from "./_store";
import { endWaits, open, type Wait } from "./_waits";

export type Wake = {
  /** What came, in a few words: "石石 回复了", "到点了", "你答了：用方案 B". */
  how: string;
  /** The message for the worker. */
  text: string;
  /** Which open waits this answers (ended). Default: none. */
  ends?: (w: Wait) => boolean;
  /** The conversation it came from: a long wait on it that doesn't end (an MR still to merge) is marked woken. */
  on?: { source: string; key?: string };
  files?: string[];
  /** A task that ended (done / review) goes back to running: a person spoke again in its conversation. */
  resume?: boolean;
  /** Recorded on the task as handled (an event id), so a re-sent one isn't handled twice. */
  followup?: string;
  /** Also before telling, on the same write. */
  also?: (t: Task) => void;
  /** A line for the activity feed of its requirement, when it has teammates (the user's answer, say). */
  feed?: string;
  /** What the user attached to that line (shown with it in the feed). */
  feedFiles?: { path: string; name?: string }[];
  /**
   * The one line the worker's chat shows instead of the message (Gerdr's send fold): the board's prompt to it is
   * long and mostly instructions, and what came already shows as the chat's wait card. Default "[任务面板] <how>";
   * false: shown whole.
   */
  fold?: string | false;
};

/** A line cut short, for a fold line. */
export function cutLine(text: string, n: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return [...t].length > n ? [...t].slice(0, n).join("") + "…" : t;
}

/** Wakes task `id`'s worker (a task not sent out yet only gets the record). Returns the task as written. */
export async function wake(ctx: Ctx, id: string, m: Wake): Promise<Task> {
  const t = update(ctx, (s) => {
    const x = find(s, id);
    if (m.followup) x.followups = [...(x.followups ?? []), m.followup];
    const ended = m.ends ? endWaits(x, m.ends, m.how) : [];
    // What it waited on outside came (an approval, a reply, a job finished): the feed had "在等 X" and, until
    // 2026-11-05, never the answer, so a stretch of waiting ended in nothing (t52: 42 minutes between "等审批" and the
    // next line). Only the world's answers: the user's are logged as theirs (feed), a teammate's as its tell, and
    // "time's up" is no result.
    const came = ended.find((w) => w.kind === "reply" || w.kind === "check");
    if (came) activity(s, x, { kind: "got", by: x.id, text: `等到了：${came.what.replace(/^等待?\s*/, "")}（${m.how}）` });
    const now = Date.now();
    if (m.on) for (const w of open(x)) if (w.on && w.on.source === m.on.source && w.on.key === m.on.key) w.woke = { how: m.how, at: now };
    if (m.resume && x.session && (x.status === "done" || x.status === "review")) {
      x.status = "running";
      x.doneAt = undefined;
    }
    m.also?.(x);
    if (m.feed) activity(s, x, { kind: "user", by: x.id, text: m.feed, ...(m.feedFiles?.length ? { files: m.feedFiles } : {}) });
    x.updatedAt = now;
    return x;
  });
  const fold = m.fold === false ? undefined : m.fold || `[任务面板] ${cutLine(m.how, 80)}`;
  // fold false: shown whole (Gerdr folds a message from code by default)
  if (t.session) await ctx.sessions.send(t.session, m.text, { now: true, attachments: m.files, ...(m.fold === false ? { show: true } : { fold }) } as any);
  return t;
}
