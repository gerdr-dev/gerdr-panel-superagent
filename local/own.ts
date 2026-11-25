// Where the person's own conversations stand: the ones they opened in Code themselves, not handed out by the
// secretary. They are listed in the same groups as the tasks and moved the same way (dragged, 移到… in the menus):
// the person asked not to be made to tell the two apart (2026-11-24, 「不要把我建的和秘书建的区别对待」).
//
// A task's standing is its `status` in the task data. A conversation of the person's has no task behind it (nothing
// dispatched it, no worker to wake, nothing the secretary follows), so only where it stands is kept, here:
// user/data/own.json, { [session id]: "review" | "done" }. Missing = 进行中: an open conversation is in progress
// until they say otherwise.

import { USER } from "./_user";

const FILE = `${USER}/data/own.json`;
type Standing = "review" | "done";

function load(ctx: Ctx): Record<string, Standing> {
  if (!ctx.fs.stat(FILE)) return {};
  try {
    const v = JSON.parse(ctx.fs.read(FILE));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** → { standing: { [session]: "review" | "done" } }. Conversations that are gone are dropped as it's read. */
export function get(_input: unknown, ctx: Ctx) {
  const all = load(ctx);
  const out: Record<string, Standing> = {};
  for (const [id, st] of Object.entries(all)) if (ctx.sessions.get(id)) out[id] = st;
  if (Object.keys(out).length !== Object.keys(all).length) ctx.fs.write(FILE, JSON.stringify(out, null, 2) + "\n");
  return { standing: out };
}

/** { session, status: "running" | "review" | "done" } → the new standings. "running" forgets it (the default). */
export function set(input: { session: string; status: string }, ctx: Ctx) {
  if (!input?.session) throw new Error("哪个对话");
  if (!["running", "review", "done"].includes(input.status)) throw new Error(`自己开的对话只有 进行中 / 待验收 / 已完成：没有 ${input.status}`);
  const all = load(ctx);
  if (input.status === "running") delete all[input.session];
  else all[input.session] = input.status as Standing;
  ctx.fs.write(FILE, JSON.stringify(all, null, 2) + "\n");
  return { standing: all };
}
