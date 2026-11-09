/**
 * The chat card for something a worker's tool just changed on the board (ui/src/cards.tsx TaskEvent). Every change the
 * user would see on the board shows in the worker's chat too, where they may be reading instead: a folded "called
 * task_update" row said nothing of what changed.
 *
 * How loud it is follows how much it matters to the user:
 * - "card": a result or a change of who's on it (review, done, a teammate pulled in, a progress line for the feed);
 * - "line": bookkeeping they may glance at (the card's summary updated, a message to a teammate, a message handed
 *   back, a memory kept).
 * Things waiting on the user or on something outside have their own cards (task-step, task-wait).
 */
export type EventKind = "progress" | "working" | "review" | "done" | "join" | "tell" | "handBack" | "remember";

const KICKER: Record<EventKind, string> = {
  progress: "更新进度",
  working: "更新概要",
  review: "等你验收",
  done: "做完了",
  join: "拉队友",
  tell: "告诉队友",
  handBack: "交回 Superagent",
  remember: "记住了",
};

const LOUD: Record<EventKind, "card" | "line"> = {
  progress: "card",
  working: "line",
  review: "card",
  done: "card",
  join: "card",
  tell: "line",
  handBack: "line",
  remember: "line",
};

export function eventCard(ctx: Ctx, task: string | undefined, kind: EventKind, title: string, more?: { body?: string; links?: { label?: string; url: string }[] }) {
  return {
    type: "task-event",
    ref: `${task ?? "-"}:${kind}:${Date.now()}`,
    project: ctx.workspace.project,
    task,
    kind,
    level: LOUD[kind],
    kicker: task ? `${KICKER[kind]} · ${task}` : KICKER[kind],
    title,
    body: more?.body,
    links: more?.links?.length ? more.links : undefined,
    tone: kind === "done" ? "ok" : kind === "review" ? "warn" : "info",
  };
}
