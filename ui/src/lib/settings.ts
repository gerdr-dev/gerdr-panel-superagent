// The panel's settings: values the code acts on (who runs the router and the workers, the repositories, how mrwatch
// merges, whether proactive work runs). One file for both sides: the 设置 page edits with it, local/_config.ts reads
// with it. What a person stores (user/settings.json) is only what they set; everything else is the default here,
// the careful one (nothing merged or rebased behind anyone's back), so a later default reaches whoever never chose.
//
// Why settings and not variables in the skill: these are values only code acts on, and prose around them was read
// by nobody (an extra sentence next to {{合并}} changed nothing). How the agents should do things stays prose in
// skills/; a value an agent also needs (repositories, the worker's default model) is written into its message by
// the code, from here. DESIGN.md, 「设置和流程」.

export type Who = { agent: string; model: string; effort: string };

export type Repo = {
  path: string;
  /** One line for the router: what this repository is (which service / product). */
  note?: string;
  /** Small changes may be pushed straight to the target branch instead of an MR (the worker is told). */
  direct?: boolean;
};

export type Settings = {
  /** The Superagent's main session (routing only). "" = Gerdr's default for that agent. */
  router: Who;
  /** Workers' defaults; a task's own agent / model wins, and these models only go with this agent. */
  worker: Who;
  repos: Repo[];
  gitlab: { host: string };
  mr: {
    merge: "auto" | "manual";
    minApprovals: number;
    rebase: "auto" | "manual" | "off";
    rebaseSkipCI: boolean;
    maxRounds: number;
  };
  /** Work nobody asked for: off, observe (judged and recorded, not done: dsh's observe mode) or on. */
  proactive: "off" | "observe" | "on";
};

export const DEFAULTS: Settings = {
  router: { agent: "", model: "", effort: "" },
  worker: { agent: "", model: "", effort: "" },
  repos: [],
  gitlab: { host: "gitlab.com" },
  mr: { merge: "manual", minApprovals: 1, rebase: "manual", rebaseSkipCI: false, maxRounds: 3 },
  proactive: "observe",
};

const str = (v: unknown, d: string) => (typeof v === "string" ? v.trim() : d);
const oneOf = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
const int = (v: unknown, min: number, max: number, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d);
const who = (v: any, d: Who): Who => ({ agent: str(v?.agent, d.agent), model: str(v?.model, d.model), effort: str(v?.effort, d.effort) });

/** Whatever is stored (partial, old, hand-edited) → complete settings: a missing or unfitting value is the default. */
export function normalize(raw: any): Settings {
  const d = DEFAULTS;
  const r = raw && typeof raw === "object" ? raw : {};
  const repos: Repo[] = [];
  for (const x of Array.isArray(r.repos) ? r.repos : []) {
    const path = str(typeof x === "string" ? x : x?.path, "");
    if (!path || repos.some((y) => y.path === path)) continue;
    const note = str(x?.note, "");
    repos.push({ path, ...(note ? { note } : {}), ...(x?.direct === true ? { direct: true } : {}) });
  }
  return {
    router: who(r.router, d.router),
    worker: who(r.worker, d.worker),
    repos,
    gitlab: { host: str(r.gitlab?.host, "") || d.gitlab.host },
    mr: {
      merge: oneOf(r.mr?.merge, ["auto", "manual"] as const, d.mr.merge),
      minApprovals: int(r.mr?.minApprovals, 0, 10, d.mr.minApprovals),
      rebase: oneOf(r.mr?.rebase, ["auto", "manual", "off"] as const, d.mr.rebase),
      rebaseSkipCI: typeof r.mr?.rebaseSkipCI === "boolean" ? r.mr.rebaseSkipCI : d.mr.rebaseSkipCI,
      maxRounds: int(r.mr?.maxRounds, 1, 20, d.mr.maxRounds),
    },
    proactive: oneOf(r.proactive, ["off", "observe", "on"] as const, d.proactive),
  };
}
