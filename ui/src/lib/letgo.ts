// 放行 (Let it go): times when the agents carry on without the user — the secretary sends work out instead of putting it
// in 待办, a worker decides instead of asking, messages go without the user looking first. DESIGN.md「放行」.
//
// Pure: the shape, the defaults and "which policy holds now", for both the 放行 page (it shows what holds right now) and
// local/_letgo.ts (the code that follows it). Why it is shaped like this (the person, 2026-11-26): not one switch but
// policies — each says what is let go and in which repositories (a complicated or unfamiliar one never is) — and a
// week of times, each picking a policy (a light one in the day, the whole of it at night). Each policy has its own
// repositories, its own people still looked at first (a leader) and its own note: nothing is special-cased outside them.

/** What can be let go. Each is one place where an agent would otherwise stop for the user. */
export type Gate =
  /** An outside message the secretary takes as work: sent out, not a 待办 card. */
  | "inbox"
  /** The secretary unsure (take it or not, which repository): it decides by the policy's note, doesn't ask. */
  | "unsure"
  /** A worker's decision (ask_human with options): it picks, the pick is recorded, nobody is asked. */
  | "decide"
  /** What a worker writes as the user (reply_message): sent at once, not a card to send. */
  | "message"
  /** A worker started in this time runs in the 放行 permission mode (no approval prompts). */
  | "permission";

export const GATES: Gate[] = ["inbox", "unsure", "decide", "message", "permission"];

/** One way of letting go: what is open, where, and what the agents are told on top. */
export type Policy = {
  id: string;
  name: string;
  gates: Gate[];
  /** Repositories it lets go (paths, as in 设置 → 仓库). Work elsewhere is as usual. `unsure` needs none. */
  repos: string[];
  /**
   * People and conversations still looked at first under this policy (a leader, a big channel): a member id, a name
   * as the source shows it, or a conversation / channel id. Writing to them stays a card for the user to send.
   */
  confirm: string[];
  /** Said to the secretary and the workers while it holds ("有八成把握就直接派"), after the shared note (letgo.md). */
  note: string;
};

/** A time of the week with a policy: from–to on these days (0 = Sunday); to before from runs past midnight. */
export type Window = { days: number[]; from: string; to: string; policy: string };

export type LetGo = {
  policies: Policy[];
  /** When which policy holds. The first that covers a moment wins. Empty: never by time (only by hand). */
  times: Window[];
  /** The permission mode a worker starts in while `permission` is open, per engine. */
  mode: { claude: string; codex: string };
};

export const LETGO_DEFAULTS: LetGo = {
  policies: [
    { id: "day", name: "部分放行", gates: ["inbox"], repos: [], confirm: [], note: "" },
    { id: "night", name: "全放行", gates: [...GATES], repos: [], confirm: [], note: "" },
  ],
  times: [],
  mode: { claude: "auto", codex: "auto" },
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strings = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(str).filter(Boolean))];

export function normalizeLetGo(raw: any): LetGo {
  const d = LETGO_DEFAULTS;
  const r = raw && typeof raw === "object" ? raw : {};
  const policies: Policy[] = [];
  for (const p of Array.isArray(r.policies) ? r.policies : d.policies) {
    const id = str(p?.id).replace(/[^\w-]/g, "") || `p${policies.length + 1}`;
    if (policies.some((x) => x.id === id)) continue;
    policies.push({
      id,
      name: str(p?.name) || id,
      gates: GATES.filter((g) => Array.isArray(p?.gates) && p.gates.includes(g)),
      repos: strings(p?.repos).map((x) => x.replace(/(.)\/+$/, "$1")),
      confirm: strings(p?.confirm),
      note: typeof p?.note === "string" ? p.note.trim() : "",
    });
  }
  const times: Window[] = [];
  for (const w of Array.isArray(r.times) ? r.times : []) {
    const from = str(w?.from);
    const to = str(w?.to);
    const policy = str(w?.policy);
    if (!HHMM.test(from) || !HHMM.test(to) || from === to || !policies.some((p) => p.id === policy)) continue;
    const days = [...new Set((Array.isArray(w?.days) ? w.days : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6))].sort() as number[];
    if (!days.length) continue;
    times.push({ days, from, to, policy });
  }
  return {
    policies,
    times,
    mode: { claude: str(r.mode?.claude) || d.mode.claude, codex: str(r.mode?.codex) || d.mode.codex },
  };
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** The first window covering `at` (local time), if any. */
export function windowAt(times: Window[], at: Date): Window | undefined {
  const now = at.getHours() * 60 + at.getMinutes();
  const day = at.getDay();
  const yesterday = (day + 6) % 7;
  return times.find((w) => {
    const f = mins(w.from);
    const t = mins(w.to);
    // Same day, or one that started yesterday and runs past midnight
    return f < t ? w.days.includes(day) && now >= f && now < t : (w.days.includes(day) && now >= f) || (w.days.includes(yesterday) && now < t);
  });
}

/** By hand, until a time: overrides the times. policy "": not let go ("not tonight"). */
export type Manual = { policy: string; until: number };

/** The policy holding at `at` (none: as usual): by hand while that lasts, else by the times. */
export function policyAt(l: LetGo, at: Date, manual?: Manual): { policy?: Policy; by: "manual" | "time" | "none"; until?: number } {
  const byId = (id?: string) => l.policies.find((p) => p.id === id);
  if (manual && manual.until > at.getTime()) return { policy: byId(manual.policy), by: "manual", until: manual.until };
  const w = windowAt(l.times, at);
  return { policy: byId(w?.policy), by: w ? "time" : "none", until: nextChange(l, at) };
}

/** When the policy by the times next changes (minute steps over the next 8 days); undefined: never. */
export function nextChange(l: LetGo, at: Date): number | undefined {
  if (!l.times.length) return undefined;
  const of = (d: Date) => windowAt(l.times, d)?.policy ?? "";
  const now = of(at);
  const t = new Date(at.getTime());
  t.setSeconds(0, 0);
  for (let i = 1; i <= 8 * 24 * 60; i++) {
    t.setTime(t.getTime() + 60_000);
    if (of(t) !== now) return t.getTime();
  }
  return undefined;
}

export const GATE_NAME: Record<Gate, string> = {
  inbox: "外面来的活直接派出去，不进待办",
  unsure: "秘书拿不准时按说明自己定，不问你",
  decide: "worker 要你拍板时自己选，记成「替你定了」",
  message: "以你的名义发的消息直接发，不出待发送卡片",
  permission: "worker 用放行的权限模式开（不弹批准）",
};

export const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

/** One window's days and hours in words: "工作日 19:00–09:00（次日）". */
export function windowText(w: Pick<Window, "days" | "from" | "to">): string {
  const d = w.days.join();
  const days = w.days.length === 7 ? "每天" : d === "1,2,3,4,5" ? "工作日" : d === "0,6" ? "周末" : `周${w.days.map((x) => DAY_NAMES[x]).join("、")}`;
  return `${days} ${w.from}–${w.to}${mins(w.to) < mins(w.from) ? "（次日）" : ""}`;
}
