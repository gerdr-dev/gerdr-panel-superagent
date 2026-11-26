// Let it go: policies for what the agents may do without the user, each in effect at its own times. DESIGN.md「Let it go」.
//
// A policy is a whole set of rules, from letting a lot go to letting nothing go, and the times it is in effect are its
// own (the person, 2026-11-26: "就是策略，然后再选一个时间段生效它"; someone may let some repositories go in the day
// and nothing at all once off work). Each has its own times, gates, repositories, people still looked at first (a
// leader), worker permission mode and note. Nothing is global, and there is no "as usual" policy: when none is in
// effect nothing is let go — every gate closed, the careful default for whoever never set anything up.
//
// Pure: the shape, the defaults and "which policy is in effect now", for both the page (ui/src/settings/LetGo.tsx) and
// local/_letgo.ts (the code that follows it).

/** What a policy can let go. Each is one place where an agent would otherwise stop for the user; closed = it does. */
export type Gate =
  /** An outside message the secretary takes as work: sent out, not a 待办 card for the user to look over first. */
  | "inbox"
  /** The secretary unsure (take it or not, which repository): it decides by the policy's note, doesn't ask. */
  | "unsure"
  /** A worker's decision (ask_human with options): it picks, the pick is recorded, nobody is asked. */
  | "decide"
  /** What a worker writes as the user (reply_message): sent at once, not a card for the user to send. */
  | "message";

export const GATES: Gate[] = ["inbox", "unsure", "decide", "message"];

/** "*" in a policy's repos: every repository. */
export const ANY_REPO = "*";

/** A time of the week: from–to on these days (0 = Sunday); to before from runs past midnight; 00:00–24:00 is all day. */
export type Window = { days: number[]; from: string; to: string };

export type Policy = {
  id: string;
  name: string;
  /** When it is in effect. Empty: only when picked by hand. */
  times: Window[];
  gates: Gate[];
  /** Repositories its gates hold in (paths as in 设置 → 仓库, or "*" for all). Work elsewhere: every gate closed. */
  repos: string[];
  /**
   * People and conversations still looked at first under it (a leader, a big channel): a member id, a name as the
   * source shows it, or a conversation / channel id. Writing to them stays a card for the user to send.
   */
  confirm: string[];
  /** The permission mode a worker starts in, in its repositories, per engine. "": 设置 → 干活's. */
  mode: { claude: string; codex: string };
  /** Said to the secretary and the workers while it is in effect (red lines, "有八成把握就直接派"). */
  note: string;
};

/** The policies, in order: where two are in effect at once, the one higher up wins. */
export type LetGo = { policies: Policy[] };

export const LETGO_DEFAULTS: LetGo = { policies: [] };

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const HHMM = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strings = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(str).filter(Boolean))];

function windows(v: unknown): Window[] {
  const out: Window[] = [];
  for (const w of Array.isArray(v) ? (v as any[]) : []) {
    const from = str(w?.from);
    const to = str(w?.to);
    if (!HHMM.test(from) || from === "24:00" || !HHMM.test(to) || from === to) continue;
    const days = [...new Set((Array.isArray(w?.days) ? w.days : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6))].sort() as number[];
    if (days.length) out.push({ days, from, to });
  }
  return out;
}

/**
 * Whatever is stored → complete. `legacy`: the settings' old inboxWork / replies (before policies, 2026-11-26): someone
 * who had "直接派出去" or "直接发" and no policies gets one in effect all the time doing just that, so nothing changes for them.
 */
export function normalizeLetGo(raw: any, legacy?: { inboxWork?: unknown; replies?: unknown }): LetGo {
  const r = raw && typeof raw === "object" ? raw : {};
  let list: any[] = Array.isArray(r.policies) ? r.policies : [];
  if (!Array.isArray(r.policies)) {
    const gates = [...(legacy?.inboxWork === "dispatch" ? ["inbox"] : []), ...(legacy?.replies === "auto" ? ["message"] : [])];
    if (gates.length) list = [{ id: "always", name: "一直", times: [{ days: ALL_DAYS, from: "00:00", to: "24:00" }], gates, repos: [ANY_REPO] }];
  }
  const policies: Policy[] = [];
  for (const p of list) {
    const id = str(p?.id).replace(/[^\w-]/g, "") || `p${policies.length + 1}`;
    if (policies.some((x) => x.id === id)) continue;
    policies.push({
      id,
      name: str(p?.name) || id,
      times: windows(p?.times),
      gates: GATES.filter((g) => Array.isArray(p?.gates) && p.gates.includes(g)),
      repos: strings(p?.repos).map((x) => x.replace(/(.)\/+$/, "$1")),
      confirm: strings(p?.confirm),
      mode: { claude: str(p?.mode?.claude), codex: str(p?.mode?.codex) },
      note: typeof p?.note === "string" ? p.note.trim() : "",
    });
  }
  return { policies };
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Whether a window covers `at` (local time). */
export function covers(w: Window, at: Date): boolean {
  const now = at.getHours() * 60 + at.getMinutes();
  const day = at.getDay();
  const f = mins(w.from);
  const t = mins(w.to);
  // Same day, or one that started yesterday and runs past midnight
  return f < t ? w.days.includes(day) && now >= f && now < t : (w.days.includes(day) && now >= f) || (w.days.includes((day + 6) % 7) && now < t);
}

/** The first policy one of whose windows covers `at`. */
export function byTime(l: LetGo, at: Date): Policy | undefined {
  return l.policies.find((p) => p.times.some((w) => covers(w, at)));
}

/** By hand, until a time: overrides the times. policy "": none (nothing let go). */
export type Manual = { policy: string; until: number };

/** The policy in effect at `at` (none: nothing let go): by hand while that lasts, else by the times. */
export function policyAt(l: LetGo, at: Date, manual?: Manual): { policy?: Policy; by: "manual" | "time" | "none"; until?: number } {
  if (manual && manual.until > at.getTime()) return { policy: l.policies.find((p) => p.id === manual.policy), by: "manual", until: manual.until };
  const p = byTime(l, at);
  return { policy: p, by: p ? "time" : "none", until: nextChange(l, at) };
}

/** When the policy by the times next changes (minute steps over the next 8 days); undefined: never. */
export function nextChange(l: LetGo, at: Date): number | undefined {
  if (!l.policies.some((p) => p.times.length)) return undefined;
  const of = (d: Date) => byTime(l, d)?.id ?? "";
  const now = of(at);
  const t = new Date(at.getTime());
  t.setSeconds(0, 0);
  for (let i = 1; i <= 8 * 24 * 60; i++) {
    t.setTime(t.getTime() + 60_000);
    if (of(t) !== now) return t.getTime();
  }
  return undefined;
}

/** Each gate open / closed, in words for the page and the agents. */
export const GATE_TEXT: Record<Gate, { label: string; open: string; closed: string }> = {
  inbox: { label: "外面来的活", open: "直接派出去", closed: "放进待办等我过目" },
  unsure: { label: "秘书拿不准时", open: "按说明自己定", closed: "问我" },
  decide: { label: "worker 要拍板时", open: "自己选，记成「替你定了」", closed: "问我" },
  message: { label: "以我的名义发消息", open: "直接发", closed: "出待发送卡片，我点了才发" },
};

export const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

/** One window in words: "工作日 19:00–09:00（次日）", "每天 全天". */
export function windowText(w: Window): string {
  const d = w.days.join();
  const days = w.days.length === 7 ? "每天" : d === "1,2,3,4,5" ? "工作日" : d === "0,6" ? "周末" : `周${w.days.map((x) => DAY_NAMES[x]).join("、")}`;
  if (w.from === "00:00" && w.to === "24:00") return `${days} 全天`;
  return `${days} ${w.from}–${w.to}${mins(w.to) < mins(w.from) ? "（次日）" : ""}`;
}
