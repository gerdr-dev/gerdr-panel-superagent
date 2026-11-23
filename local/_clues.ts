// Connecting an outside message to the task it is about by what the workers said (a helper file: nothing here is
// callable from a page).
//
// A worker often writes to people itself, with the user's identity (a Slack DM through its own tool): "25077302 和
// 25076404 也修好了，麻烦再验一下". The answer ("可以把bug推一下状态哈") comes in as an outside message that no task follows,
// and the conversation before it, which the source hands along, is the worker's own words. 2026-11-23 (c592): the
// secretary looked nothing up and asked the user "要我去改吗"; the task that sent those words (t123) never heard.
// tasks.search couldn't have found it either: the defect numbers were only in t123's conversation.
//
// So the board does the one match that can't drift: the marks in the message and the conversation before it that
// name a thing (links, ids, long numbers, MR / issue numbers, commit hashes) are looked for in the live workers'
// conversations, and the tasks that have them are listed under the message as clues. Names are not matched (DESIGN.md
// 「中期记忆」: written differently every time, and a colleague is in many tasks); whether the clue is right is still the
// secretary's call.

import type { Task } from "./_store";

const URL_RE = /https?:\/\/[^\s<>|"'）)\]】，。]+/g;
// An id-like token: KEY-123, !4203 / #4280, five digits or more, a hex hash with letters and digits (0fe9a4e)
const ID_RE = /(?<![A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9]*-\d{2,}|[!#]\d{3,}|\d{5,}|(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40})(?![A-Za-z0-9])/g;

/** The marks in a text that name one thing: links and id-like tokens (those inside a link too), at most 30. */
export function marks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?]+$/, "");
    if (u.length > 12) out.add(u);
  }
  for (const m of text.matchAll(ID_RE)) out.add(m[0]);
  return [...out].slice(0, 30);
}

const DAY = 24 * 3600 * 1000;

/**
 * The tasks whose worker conversation is worth looking in: on the board and not ended, or done in the last 3 days (a
 * reply to a delivery comes after it is done; attaching picks it up again). Ones without a worker have said nothing.
 */
export function liveTasks(tasks: Task[]): Task[] {
  const now = Date.now();
  return tasks.filter((t) => t.session && (t.status === "running" || t.status === "review" || t.status === "todo" || (t.status === "done" && (t.doneAt ?? 0) > now - 3 * DAY)));
}

/** What a task's worker and the people talking to it said lately (no tool calls: Gerdr's sessions.read), "" if unknown. */
export function said(ctx: Ctx, t: Task, last = 80): string {
  if (!t.session) return "";
  try {
    return (ctx.sessions.read(t.session, { last }) ?? []).map((m) => m.text).join("\n");
  } catch {
    return "";
  }
}

/**
 * Clue lines for a message: "- t123「PortAI 计费税率」(running)：对话里有 25077302、25076404". `skip`: tasks already named
 * under the message (they follow its conversation). [] when the text has no marks or no task has them.
 */
export function clues(ctx: Ctx, tasks: Task[], text: string, skip: Set<string>): string[] {
  const ms = marks(text);
  if (!ms.length) return [];
  const out: string[] = [];
  for (const t of liveTasks(tasks)) {
    if (skip.has(t.id)) continue;
    const conv = said(ctx, t);
    const hit = conv ? ms.filter((m) => conv.includes(m)) : [];
    if (hit.length) out.push(`- ${t.id}「${t.title}」(${t.status})：对话里有 ${hit.slice(0, 5).join("、")}${hit.length > 5 ? ` 等 ${hit.length} 处` : ""}`);
  }
  return out;
}
