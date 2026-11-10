// Events into the Superagent: the 触发器 settings page and the function its triggers run.
//
// Which events come in is the user's choice, kept as Gerdr trigger files (triggers/inbox-*.json), one per source:
// the page writes them, Gerdr runs inbox.onEvent for each matching event. Nothing here names a source: the choices
// come from ctx.events.catalog() (what the installed add-ons emit, what came lately), so someone without Slack sees
// no Slack and a Feishu add-on shows up by itself. What happens to an event is _main.ts: the gate (who may ask, the
// trigger's `allow`), a task following its conversation, or the main session's judgement.

import { load } from "./_store";
import { migrate } from "./_user";
import { workflow } from "./_config";
import { compact, evaluate, followUp, record, state, subscribers } from "./_main";

// Which events this person takes in is theirs: their trigger files live in user/triggers/ (Gerdr reads them beside the
// panel's own triggers/, like triggers/mr.json)
const DIR = "user/triggers";
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

type Ours = { path: string; key?: string; allow?: string[]; inferred?: boolean };

function ours(ctx: Ctx): Record<string, Ours> {
  migrate(ctx);
  const out: Record<string, Ours> = {};
  if (!ctx.fs.stat(DIR)) return out;
  for (const f of ctx.fs.list(DIR)) {
    const name = f.path.split("/").pop() ?? "";
    if (!name.startsWith(PREFIX) || !name.endsWith(".json")) continue;
    try {
      const t = JSON.parse(ctx.fs.read(f.path));
      if (t.fn === FN && t.on) out[t.on] = { path: f.path, key: t.key, allow: Array.isArray(t.input?.allow) ? t.input.allow : undefined, inferred: !!t.input?.inferred };
    } catch {
      // a broken file is Gerdr's to report (gerdr panel triggers)
    }
  }
  return out;
}

/** The panel's own triggers (triggers/*.json, shipped with it, like mr.json): always on, not the user's choice. */
export function builtin(input: unknown, ctx: Ctx): { id: string; on: string; name?: string; key?: string }[] {
  const out: { id: string; on: string; name?: string; key?: string }[] = [];
  for (const f of ctx.fs.stat("triggers") ? ctx.fs.list("triggers") : []) {
    const name = f.path.split("/").pop() ?? "";
    if (f.dir || !name.endsWith(".json")) continue;
    try {
      const t = JSON.parse(ctx.fs.read(f.path));
      if (t.on) out.push({ id: name.slice(0, -5), on: t.on, name: t.name, key: t.key });
    } catch {
      // a broken file is Gerdr's to report (gerdr panel triggers)
    }
  }
  return out;
}

/** "gitlab/*" matches "gitlab/mr.merged": a trigger's on, as Gerdr reads it. */
function covers(on: string, what: string) {
  return new RegExp(`^${on.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(what);
}

/**
 * For the 触发器 page: every source one can subscribe to, and whether it makes tasks now. `by`: one of the panel's
 * own triggers already takes it (the page shows that instead of a switch: turning it on too would take it twice).
 */
export function sources(input: unknown, ctx: Ctx) {
  const on = ours(ctx);
  const own = builtin(input, ctx);
  const list: (Source & { enabled: boolean; key?: string; allow?: string[]; inferred?: boolean; by?: string })[] = (events(ctx).catalog() as Source[]).map((s) => ({
    ...s,
    enabled: !!on[s.on],
    key: on[s.on]?.key,
    allow: on[s.on]?.allow,
    inferred: on[s.on]?.inferred,
    by: on[s.on] ? undefined : own.find((b) => covers(b.on, s.on))?.name,
  }));
  // Turned on earlier for a source that's gone from the catalog (its add-on removed): still listed, so it can be turned off
  for (const [k, v] of Object.entries(on)) if (!list.some((s) => s.on === k)) list.push({ on: k, enabled: true, key: v.key, allow: v.allow, inferred: v.inferred });
  return list;
}

/**
 * Turns a source on (writes its trigger) or off (removes it): { on, enabled, key?, title?, allow?, inferred? }.
 * `inferred`: its events aren't someone asking the agent (a channel's chatter, alerts): only the proactive rules take
 * them. `allow`: who may
 * ask for work through it, as the source names them (event.actor: a Slack member id; a display name works too).
 * Empty = whoever the source lets through (the Slack add-on has its own list).
 */
export function setSource(input: { on: string; enabled: boolean; key?: string; title?: string; allow?: string[] | string; inferred?: boolean }, ctx: Ctx) {
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
  const extra: Record<string, unknown> = {};
  if (allow.length) extra.allow = allow;
  if (input.inferred) extra.inferred = true;
  if (Object.keys(extra).length) t.input = extra;
  ctx.fs.write(p, JSON.stringify(t, null, 2) + "\n");
  return { on: input.on, enabled: true, key: t.key, allow, inferred: !!input.inferred };
}

/**
 * A trigger's run (dsh-superagent's flow, _main.ts). A message in a conversation some task follows goes to that
 * task's worker first, whoever sent it: it's context for work already allowed, and grants nothing new (dsh: a
 * Subscription bypasses the gate). Anything else passes the gate (`allow` in the trigger file: who may ask through
 * this source) and goes to the main session, which decides whether it's work. A trigger marked `inferred` (its
 * events aren't addressed to the agent: a channel's chatter, alerts, an MR nobody follows) is judged only by the
 * proactive rules, and not at all while proactive work is off. Every event is logged with where it went (去向). The
 * same event twice (a source re-sending) is handled once.
 */
export async function onEvent(input: { event: GerdrEvent; trigger?: string; allow?: string[]; inferred?: boolean }, ctx: Ctx) {
  const e = input?.event;
  if (!e?.id) throw new Error("没有事件（这个函数由 triggers/*.json 调用）");
  // Another panel's own watcher (mrwatch in another project's install): its tasks' news, not this panel's. Not logged:
  // it never came here (2026-11-10: the default project's board judged the lb project's MRs, one turn each)
  if (e.data?.panel && e.data.panel !== ctx.workspace.project) return { notMine: true };
  const { store } = load(ctx);
  if (store.tasks.some((t) => t.origin?.id === e.id || t.followups?.includes(e.id)) || state(ctx).items.some((x) => x.event.id === e.id)) return { duplicate: true };
  const ev = compact(e);
  const owners = subscribers(store.tasks, ev);
  if (owners.length) {
    for (const t of owners) await followUp(ctx, t.id, ev);
    const it = record(ctx, ev, { state: "delivered", tasks: owners.map((t) => t.id) });
    return { item: it.id, delivered: it.tasks };
  }
  const allow = input.allow ?? [];
  if (allow.length && ![ev.actor, ev.who].some((w) => w && allow.includes(w))) {
    const it = record(ctx, ev, { state: "filtered", reason: `${ev.who || ev.actor || "发送人不明"} 不在「只收这些人」里` });
    return { item: it.id, filtered: true };
  }
  const inferred = !!input.inferred;
  if (inferred && workflow(ctx).proactive === "off") {
    const it = record(ctx, ev, { state: "filtered", inferred, reason: "不是找你的，主动工作关着（流程 → 主动工作）" });
    return { item: it.id, filtered: true };
  }
  const it = record(ctx, ev, { state: "pending", inferred: inferred || undefined, sentAt: Date.now() });
  await evaluate(ctx, [it.id], store.tasks);
  return { item: it.id, pending: true };
}
