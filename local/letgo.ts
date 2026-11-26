// Let it go: the page's and agents' commands. The policies themselves (each with its times, gates, repositories,
// people still looked at first, mode, note) are `settings.letgo` (settings.get / settings.set); this is which one is in
// effect right now (several at once, each over its repositories), picking one by hand until a time, and the tick that hands what was done without asking to the
// secretary for a briefing when the policy changes. DESIGN.md「Let it go」; the rules: ui/src/lib/letgo.ts, local/_letgo.ts.

import { current, hhmm, policyText, state, updateState, type Done } from "./_letgo";
import { toMain } from "./_main";

/** → { policies (those in effect, in order), by (manual / time / none), until, text, manual, log so far } */
export function status(input: unknown, ctx: Ctx) {
  const c = current(ctx);
  return { policies: c.policies, by: c.by, until: c.until, text: policyText(c), manual: state(ctx).manual ?? null, log: state(ctx).log ?? [] };
}

/**
 * By hand: { policy: a policy's id, or "" for none (nothing let go); until: ms, "HH:MM" (the next one) or hours (< 100) }.
 * { clear: true } goes back to the times.
 */
export function set(input: { policy?: string; until?: number | string; clear?: boolean }, ctx: Ctx) {
  if (input?.clear) {
    updateState(ctx, (s) => void delete s.manual);
    return status({}, ctx);
  }
  const policy = String(input?.policy ?? "").trim();
  const all = current(ctx).letgo.policies;
  if (policy && !all.some((p) => p.id === policy))
    throw new Error(`没有策略 ${policy}：有 ${all.map((p) => `${p.id}（${p.name}）`).join("、") || "（还没建）"}；"" 是哪套都不用、什么都问`);
  const until = untilOf(input?.until);
  if (!until || until <= Date.now()) throw new Error(`until 要是以后的时间：毫秒时间戳、"HH:MM"（下一个这个钟点）或小时数`);
  updateState(ctx, (s) => void (s.manual = { policy, until }));
  return status({}, ctx);
}

function untilOf(v: unknown): number | undefined {
  if (typeof v === "number" && v > 0) return v < 100 ? Date.now() + v * 3600_000 : v;
  if (typeof v !== "string") return undefined;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return untilOf(Number(v));
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return undefined;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const KIND: Record<Done["kind"], string> = { dispatched: "直接派出去", decided: "替你定了", sent: "直接发出去", secretary: "秘书自己定了" };

/**
 * schedules/letgo.json, every few minutes: notes the policies in effect; when they change and something was done without
 * asking under the one before, hands that to the secretary for a briefing.
 */
export async function tick(input: unknown, ctx: Ctx) {
  const c = current(ctx);
  const s = state(ctx);
  const now = c.policies.map((p) => p.id).join();
  const was = s.last?.policy ?? "";
  if (s.last && was === now) return { policy: now };
  const log = s.log ?? [];
  const before = was.split(",").map((id) => c.letgo.policies.find((p) => p.id === id)?.name).filter(Boolean).map((n) => `「${n}」`).join("、");
  updateState(ctx, (x) => {
    x.last = { policy: now, since: Date.now() };
    x.log = [];
    // A manual choice that ran out: gone, so the page shows the times again
    if (x.manual && x.manual.until <= Date.now()) delete x.manual;
  });
  if (!log.length) return { policy: now, was };
  const lines = log.map((d) => `- ${hhmm(d.at)} ${KIND[d.kind]}${d.task ? ` · ${d.task}` : ""}：${d.text}`);
  await toMain(
    ctx,
    [
      `[策略换了] ${before ? `策略${before}` : "上一段"}从 ${hhmm(s.last?.since)} 到现在结束了，现在是${policyText(c)}。\n` +
        `那段时间没问用户就做了的：\n${lines.join("\n")}\n\n` +
        `给用户写一份简报：做完了什么、替他定了什么（他可能想推翻）、以他的名义发了什么、还有哪些在等他（\`gerdr panel run tasks.list\` 里 column 是 you 的）。` +
        `按简报的写法写（secretary.md），只写要他知道的。`,
    ],
    "brief",
    undefined,
    "[面板] 策略换了，写简报",
  );
  return { policy: now, was, briefed: log.length };
}
