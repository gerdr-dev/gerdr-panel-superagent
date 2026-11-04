// Events into the Superagent: the 触发器 settings page and the function its triggers run.
//
// Which events come in is the user's choice, kept as Gerdr trigger files (triggers/inbox-*.json), one per source:
// the page writes them, Gerdr runs inbox.onEvent for each matching event. Nothing here names a source: the choices
// come from ctx.events.catalog() (what the installed add-ons emit, what came lately), so someone without Slack sees
// no Slack and a Feishu add-on shows up by itself. What happens to an event is _main.ts: the gate (who may ask, the
// trigger's `allow`), a task following its conversation, or the main session's judgement.

import { load } from "./_store";
import { compact, evaluate, followUp, record, state, subscribers } from "./_main";

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

type Ours = { path: string; key?: string; allow?: string[] };

function ours(ctx: Ctx): Record<string, Ours> {
  const out: Record<string, Ours> = {};
  if (!ctx.fs.stat(DIR)) return out;
  for (const f of ctx.fs.list(DIR)) {
    const name = f.path.split("/").pop() ?? "";
    if (!name.startsWith(PREFIX) || !name.endsWith(".json")) continue;
    try {
      const t = JSON.parse(ctx.fs.read(f.path));
      if (t.fn === FN && t.on) out[t.on] = { path: f.path, key: t.key, allow: Array.isArray(t.input?.allow) ? t.input.allow : undefined };
    } catch {
      // a broken file is Gerdr's to report (gerdr work triggers)
    }
  }
  return out;
}

/** For the 触发器 page: every source one can subscribe to, and whether it makes tasks now. */
export function sources(input: unknown, ctx: Ctx) {
  const on = ours(ctx);
  const list: (Source & { enabled: boolean; key?: string; allow?: string[] })[] = (events(ctx).catalog() as Source[]).map((s) => ({ ...s, enabled: !!on[s.on], key: on[s.on]?.key, allow: on[s.on]?.allow }));
  // Turned on earlier for a source that's gone from the catalog (its add-on removed): still listed, so it can be turned off
  for (const [k, v] of Object.entries(on)) if (!list.some((s) => s.on === k)) list.push({ on: k, enabled: true, key: v.key, allow: v.allow });
  return list;
}

/**
 * Turns a source on (writes its trigger) or off (removes it): { on, enabled, key?, title?, allow? }. `allow`: who may
 * ask for work through it, as the source names them (event.actor: a Slack member id; a display name works too).
 * Empty = whoever the source lets through (the Slack add-on has its own list).
 */
export function setSource(input: { on: string; enabled: boolean; key?: string; title?: string; allow?: string[] | string }, ctx: Ctx) {
  if (!/^[A-Za-z0-9._*-]+\/[A-Za-z0-9._*-]+$/.test(input?.on ?? "")) throw new Error(`事件写成 来源/类型：${input?.on}`);
  const p = fileOf(input.on);
  if (!input.enabled) {
    const cur = ours(ctx)[input.on];
    if (cur) ctx.fs.trash(cur.path);
    return { on: input.on, enabled: false };
  }
  const t: Record<string, unknown> = { on: input.on, fn: FN, name: `${input.title || input.on} → Superagent` };
  if (input.key?.trim()) t.key = input.key.trim();
  const allow = (Array.isArray(input.allow) ? input.allow : (input.allow ?? "").split(/[,，\s]+/)).map((x) => String(x).trim()).filter(Boolean);
  if (allow.length) t.input = { allow };
  ctx.fs.write(p, JSON.stringify(t, null, 2) + "\n");
  return { on: input.on, enabled: true, key: t.key, allow };
}

/**
 * A trigger's run (dsh-superagent's flow, _main.ts): the gate first (`allow` in the trigger file: who may ask through
 * this source); a message in a conversation some task follows goes to that task's worker, no judgement needed;
 * anything else goes to the main session, which decides whether it's work. Every event is logged with where it went
 * (the board's 去向). The same event twice (a source re-sending) is handled once.
 */
export async function onEvent(input: { event: GerdrEvent; trigger?: string; allow?: string[] }, ctx: Ctx) {
  const e = input?.event;
  if (!e?.id) throw new Error("没有事件（这个函数由 triggers/inbox-*.json 调用）");
  const { store } = load(ctx);
  if (store.tasks.some((t) => t.origin?.id === e.id || t.followups?.includes(e.id)) || state(ctx).items.some((x) => x.event.id === e.id)) return { duplicate: true };
  const ev = compact(e);
  const allow = input.allow ?? [];
  if (allow.length && ![ev.actor, ev.who].some((w) => w && allow.includes(w))) {
    const it = record(ctx, ev, { state: "filtered", reason: `${ev.who || ev.actor || "发送人不明"} 不在「只收这些人」里` });
    return { item: it.id, filtered: true };
  }
  const owners = subscribers(store.tasks, ev);
  if (owners.length) {
    for (const t of owners) await followUp(ctx, t.id, ev);
    const it = record(ctx, ev, { state: "delivered", tasks: owners.map((t) => t.id) });
    return { item: it.id, delivered: it.tasks };
  }
  const it = record(ctx, ev, { state: "pending", sentAt: Date.now() });
  await evaluate(ctx, [it.id], store.tasks);
  return { item: it.id, pending: true };
}
