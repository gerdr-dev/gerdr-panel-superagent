// 放行 (Let it go): the page's and agents' commands. The settings themselves (policies, the times that pick them, who is
// always looked at first) are `settings.letgo` (settings.get / settings.set); this is what holds right now, picking a
// policy by hand until a time, and the tick that asks the secretary for a briefing when a let-go time ends.
// DESIGN.md「放行」; the rules: ui/src/lib/letgo.ts, local/_letgo.ts.

import { GATE_NAME } from "../ui/src/lib/letgo";
import { current, hhmm, policyText, state, updateState, type Done } from "./_letgo";
import { toMain } from "./_main";

/** → { policy (id, name, gates, repos) or null, by (manual / time / none), until, text, manual, log so far } */
export function status(input: unknown, ctx: Ctx) {
  const c = current(ctx);
  return {
    policy: c.policy ? { ...c.policy, gates: c.policy.gates.map((g) => ({ id: g, name: GATE_NAME[g] })) } : null,
    by: c.by,
    until: c.until,
    text: policyText(c),
    manual: state(ctx).manual,
    log: c.policy ? (state(ctx).log ?? []) : [],
  };
}

/**
 * By hand: { policy: a policy's id, or "" for not letting go; until: ms, "HH:MM" (the next one) or hours (< 100) } —
 * e.g. 全放行 until 09:00, or nothing tonight. { clear: true } goes back to the times.
 */
export function set(input: { policy?: string; until?: number | string; clear?: boolean }, ctx: Ctx) {
  if (input?.clear) {
    updateState(ctx, (s) => void delete s.manual);
    return status({}, ctx);
  }
  const policy = String(input?.policy ?? "").trim();
  const all = current(ctx).letgo.policies;
  if (policy && !all.some((p) => p.id === policy))
    throw new Error(`没有策略 ${policy}：有 ${all.map((p) => `${p.id}（${p.name}）`).join("、") || "（还没建）"}；"" 是不放行`);
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
 * schedules/letgo.json, every few minutes: notes the policy, and when a let-go time ends asks the secretary for the
 * briefing on it (what was done, decided and said on the user's behalf; what still waits on them).
 */
export async function tick(input: unknown, ctx: Ctx) {
  const c = current(ctx);
  const s = state(ctx);
  const now = c.policy?.id ?? "";
  const was = s.last?.policy ?? "";
  if (was === now) return { policy: now };
  const log = s.log ?? [];
  updateState(ctx, (x) => {
    x.last = { policy: now, since: Date.now() };
    if (!now) x.log = [];
    // A manual choice that ran out: gone, so the page shows the times again
    if (x.manual && x.manual.until <= Date.now()) delete x.manual;
  });
  // From one policy to another: the same let-go time goes on
  if (now || !was) return { policy: now, was };
  const lines = log.map((d) => `- ${hhmm(d.at)} ${KIND[d.kind]}${d.task ? ` · ${d.task}` : ""}：${d.text}`);
  await toMain(
    ctx,
    [
      `[放行结束] 放行从 ${hhmm(s.last?.since)} 到现在结束了，接下来照平时做（拿不准的问用户、外面来的活按设置进待办）。\n` +
        `这段时间替用户做的：\n${lines.join("\n") || "- （面板没记下什么）"}\n\n` +
        `给用户写一份简报：做完了什么、替他定了什么（他可能想推翻）、以他的名义发了什么、还有哪些在等他（\`gerdr panel run tasks.list\` 里 column 是 you 的）。` +
        `按简报的写法写（secretary.md），只写要他知道的。`,
    ],
    "brief",
    undefined,
    "[面板] 放行结束，写简报",
  );
  return { policy: now, was, briefed: log.length };
}
