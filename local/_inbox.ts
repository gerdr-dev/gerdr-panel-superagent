import type { Task } from "./_store";

// What on the board waits on the user, in Gerdr's inbox (ctx.inbox.set): on every device and as a phone notification,
// so a task asking something isn't seen only by someone who happens to open the board. One item per task under 等你,
// said the way its chat's line says it. Left out on purpose: a worker's approval or error, which Gerdr's inbox already
// has from the session itself (a second item would say the same twice).

type Listed = Task & {
  column: string;
  question?: string;
  stopped?: boolean;
  stopWhy?: string;
  said?: string;
  live?: { status: string; waiting?: string } | null;
  helpers?: { title: string; waiting?: string; waitingKind?: string; left?: boolean }[];
};

const cut = (s: string, n = 120) => ([...s].length > n ? [...s].slice(0, n).join("") + "…" : s);

type Line = { id: string; title: string; body?: string; session?: string };

/** What waits on the user, one line per task: for Gerdr's inbox, and for the secretary's news (_main.ts notice). */
export function waitingLines(tasks: Listed[]): Line[] {
  const items: Line[] = [];
  for (const t of tasks) {
    if (t.column !== "you") continue;
    if (t.owner === "human") {
      // A step of the user's: opening it goes to the chat of the task it holds up, where its card is
      const blocked = tasks.find((x) => x.blockedBy?.includes(t.id) && x.session && x.status !== "done" && x.status !== "dropped");
      const left = (t.questions ?? []).filter((q) => !q.dropped && !q.answer);
      const what = t.questions ? `待你答 ${left.length} 个问题` : t.handBack?.kind === "choice" ? "待你决定" : "要你做";
      // Named by the task it holds up (t113), the card the user knows: the step's own id (t149) is shown nowhere on the
      // board (2026-11-16). One question: the body is that task's title, not the question a second time
      const head = blocked ? `${blocked.id} ` : "";
      const body = left.length > 1 ? left.map((q) => `· ${q.title}`).join("\n") : blocked ? blocked.title : left.length ? undefined : t.steps;
      items.push({ id: t.id, title: `${head}${what}：${cut(t.title, 80)}`, body, session: blocked?.session });
      continue;
    }
    if (t.live?.status === "waiting" || t.live?.status === "error") continue;
    const k = t.helpers?.find((x) => x.left);
    const line = t.question
      ? `问你：${t.question}`
      : k
        ? `它派出去的「${k.title}」${k.waitingKind === "ask" ? "在问" : "要你批准"}：${k.waiting ?? ""}`
        : t.stopped
          ? `${t.stopWhy ?? "停下了"}${t.said ? `。它最后说：${t.said}` : ""}`
          : "在等你";
    items.push({ id: t.id, title: `${t.id} ${cut(line)}`, body: t.title, session: t.session });
  }
  return items;
}

export function tellInbox(ctx: Ctx, tasks: Listed[]) {
  const inbox = (ctx as any).inbox as { set(items: Line[]): void } | undefined;
  if (!inbox?.set) return; // a Gerdr from before ctx.inbox
  try {
    inbox.set(waitingLines(tasks));
  } catch (err: any) {
    ctx.log(`收件箱没更新：${err?.message ?? err}`);
  }
}
