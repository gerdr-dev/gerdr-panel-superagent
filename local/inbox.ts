// Events that become tasks: the 触发器 settings page and the function its triggers run.
//
// Which events make a task is the user's choice, kept as Gerdr trigger files (triggers/inbox-*.json), one per source:
// the page writes them, Gerdr runs inbox.onEvent for each matching event. Nothing here names a source: the choices
// come from ctx.events.catalog() (what the installed add-ons emit, what came lately), so someone without Slack sees
// no Slack and a Feishu add-on shows up by itself. Answers go back through the event's own reply address
// (ctx.events.reply): "taken as tN" here, results from _store.ts tellOrigins.

import { add } from "./tasks";
import { load, type Task } from "./_store";

const DIR = "triggers";
const PREFIX = "inbox-";
const FN = "inbox.onEvent";

type Source = { on: string; title?: string; description?: string; addon?: string; canReply?: boolean; seen?: number };

function events(ctx: Ctx): any {
  const e = (ctx as any).events;
  if (!e?.catalog) throw new Error("这个 Gerdr 还没有事件功能：升级 Gerdr 后再用");
  return e;
}

/** triggers/inbox-<slug>.json for a source/kind ("slack/dm" → inbox-slack-dm.json). */
function fileOf(on: string) {
  return `${DIR}/${PREFIX}${on.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;
}

function ours(ctx: Ctx): Record<string, { path: string; key?: string }> {
  const out: Record<string, { path: string; key?: string }> = {};
  if (!ctx.fs.stat(DIR)) return out;
  for (const f of ctx.fs.list(DIR)) {
    const name = f.path.split("/").pop() ?? "";
    if (!name.startsWith(PREFIX) || !name.endsWith(".json")) continue;
    try {
      const t = JSON.parse(ctx.fs.read(f.path));
      if (t.fn === FN && t.on) out[t.on] = { path: f.path, key: t.key };
    } catch {
      // a broken file is Gerdr's to report (gerdr work triggers)
    }
  }
  return out;
}

/** For the 触发器 page: every source one can subscribe to, and whether it makes tasks now. */
export function sources(input: unknown, ctx: Ctx) {
  const on = ours(ctx);
  const list: (Source & { enabled: boolean; key?: string })[] = (events(ctx).catalog() as Source[]).map((s) => ({ ...s, enabled: !!on[s.on], key: on[s.on]?.key }));
  // Turned on earlier for a source that's gone from the catalog (its add-on removed): still listed, so it can be turned off
  for (const [k, v] of Object.entries(on)) if (!list.some((s) => s.on === k)) list.push({ on: k, enabled: true, key: v.key });
  return list;
}

/** Turns a source on (writes its trigger) or off (removes it): { on, enabled, key?, title? }. */
export function setSource(input: { on: string; enabled: boolean; key?: string; title?: string }, ctx: Ctx) {
  if (!/^[A-Za-z0-9._*-]+\/[A-Za-z0-9._*-]+$/.test(input?.on ?? "")) throw new Error(`事件写成 来源/类型：${input?.on}`);
  const p = fileOf(input.on);
  if (!input.enabled) {
    const cur = ours(ctx)[input.on];
    if (cur) ctx.fs.trash(cur.path);
    return { on: input.on, enabled: false };
  }
  const t: Record<string, unknown> = { on: input.on, fn: FN, name: `${input.title || input.on} → 新任务` };
  if (input.key?.trim()) t.key = input.key.trim();
  ctx.fs.write(p, JSON.stringify(t, null, 2) + "\n");
  return { on: input.on, enabled: true, key: t.key };
}

/**
 * A trigger's run: the event becomes a task, handed out like one typed on the board (no repository: the router
 * picks, the attachments go along), and the sender hears it was taken. The same event twice (a source re-sending)
 * makes one task.
 */
export async function onEvent(input: { event: GerdrEvent; trigger?: string }, ctx: Ctx) {
  const e = input?.event;
  if (!e?.id) throw new Error("没有事件（这个函数由 triggers/inbox-*.json 调用）");
  const dup = load(ctx).store.tasks.find((t) => t.origin?.id === e.id);
  if (dup) return { task: dup.id, duplicate: true };
  const text = (e.text ?? "").trim() || e.title || "";
  const files = Array.isArray(e.data?.files) ? e.data.files.filter((f: any) => f?.path) : [];
  const from = [e.data?.userName && `来自 ${e.data.userName}`, `${e.source}/${e.kind}`].filter(Boolean).join("，");
  const prompt = `${text}\n\n（${from}${e.url ? `：${e.url}` : ""}）`;
  const t = (await add(
    {
      title: firstLine(text) || e.title || `${e.source}/${e.kind}`,
      prompt,
      attachments: files.map((f: any) => ({ path: f.path, name: f.name ?? f.path.split("/").pop(), mime: f.mimetype })),
      origin: { id: e.id, source: e.source, kind: e.kind, key: e.key, title: e.title, url: e.url, reply: e.reply },
      start: true,
    },
    ctx,
  )) as Task;
  if (e.reply) {
    try {
      events(ctx).reply(e, `收到，建了任务 ${t.id}「${t.title}」，有结果会在这里说。`);
    } catch (err: any) {
      ctx.log(`回复失败：${err?.message ?? err}`);
    }
  }
  return { task: t.id };
}

function firstLine(text: string) {
  const line = text.split("\n")[0].trim();
  return [...line].length > 40 ? [...line].slice(0, 40).join("") + "…" : line;
}
