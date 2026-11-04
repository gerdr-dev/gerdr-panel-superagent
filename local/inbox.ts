import { list } from "./tasks";

/**
 * Brings the board up to date and tells Gerdr's inbox what waits on the user (tasks.list does both; _inbox.ts). On a
 * schedule, so a task that starts waiting on the user reaches the inbox and the phone without the board being open.
 */
export async function sync(input: unknown, ctx: Ctx) {
  const r = await list(input, ctx);
  return { you: r.tasks.filter((t) => t.column === "you").map((t) => t.id) };
}
