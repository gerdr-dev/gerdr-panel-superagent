import type { Task } from "./_store";

// What on the board waits on the user, in Gerdr's inbox (ctx.inbox.set): on every device and as a phone notification,
// so a task asking something isn't seen only by someone who happens to open the board. One item per task under 等你,
// said the way its chat's line says it. Left out on purpose: a worker's approval or error, which Gerdr's inbox already
// has from the session itself (a second item would say the same twice).

type Listed = Task & {
  column: string;
  question?: string;
  stopped?: boolean;
  said?: string;
  live?: { status: string; waiting?: string } | null;
  helpers?: { title: string; waiting?: string; waitingKind?: string; left?: boolean }[];
};

const cut = (s: string, n = 120) => ([...s].length > n ? [...s].slice(0, n).join("") + "…" : s);

export function tellInbox(ctx: Ctx, tasks: Listed[]) {
  const inbox = (ctx as any).inbox as { set(items: { id: string; title: string; body?: string; session?: string }[]): void } | undefined;
  if (!inbox?.set) return; // a Gerdr from before ctx.inbox
  const items: { id: string; title: string; body?: string; session?: string }[] = [];
  for (const t of tasks) {
    if (t.column !== "you") continue;
    if (t.owner === "human") {
      // A step of the user's: opening it goes to the chat of the task it holds up, where its card is
      const blocked = tasks.find((x) => x.blockedBy?.includes(t.id) && x.session && x.status !== "done" && x.status !== "dropped");
      const left = (t.questions ?? []).filter((q) => !q.dropped && !q.answer);
      const what = t.questions ? `待你答 ${left.length} 个问题` : t.handBack?.kind === "choice" ? "待你决定" : "要你做";
      items.push({ id: t.id, title: `${t.id} ${what}：${cut(t.title, 80)}`, body: left.length ? left.map((q) => `· ${q.title}`).join("\n") : t.steps, session: blocked?.session });
      continue;
    }
    if (t.live?.status === "waiting" || t.live?.status === "error") continue;
    const k = t.helpers?.find((x) => x.left);
    const line = t.question
      ? `问你：${t.question}`
      : k
        ? `它派出去的「${k.title}」${k.waitingKind === "ask" ? "在问" : "要你批准"}：${k.waiting ?? ""}`
        : t.stopped
          ? `停下了${t.said ? `：${t.said}` : "，没说接下来要什么"}`
          : "在等你";
    items.push({ id: t.id, title: `${t.id} ${cut(line)}`, body: t.title, session: t.session });
  }
  try {
    inbox.set(items);
  } catch (err: any) {
    ctx.log(`收件箱没更新：${err?.message ?? err}`);
  }
}
