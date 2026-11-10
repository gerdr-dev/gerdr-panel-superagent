// The panel's settings: values the code acts on (who runs the router and the workers, the repositories, which GitLab
// the MR watcher asks, whether proactive work runs). One file for both sides: the 设置 page edits with it, local/_config.ts reads
// with it. What a person stores (user/settings.json) is only what they set; everything else is the default here,
// the careful one, so a later default reaches whoever never chose. How MRs are merged / rebased was a setting here
// until 2026-11-04, when the watcher still did it; now the worker does, so it's prose in the skill (mr.md). Which
// repositories take small changes straight (repos[].direct) was one until 2026-11-05: it's a fact about one repository,
// so it's in the user's memory now (local/_memory.ts), with who merges and who approves a release.
//
// Why settings and not variables in the skill: these are values only code acts on, and prose around them was read
// by nobody (an extra sentence next to {{合并}} changed nothing). How the agents should do things stays prose in
// skills/; a value an agent also needs (repositories, the worker's default model) is written into its message by
// the code, from here. DESIGN.md, 「设置和流程」.

/** mode: the permission mode its sessions start in (claude: default / acceptEdits / plan / auto; codex: ask / auto / read-only). */
export type Who = { agent: string; model: string; effort: string; mode: string };

export type Repo = {
  path: string;
  /** One line for the router: what this repository is (which service / product). */
  note?: string;
};

export type Settings = {
  /** The Superagent's main session (routing only). "" = Gerdr's default for that agent. */
  router: Who;
  /** Workers' defaults; a task's own agent / model wins, and these models only go with this agent. */
  worker: Who;
  repos: Repo[];
  gitlab: { host: string };
  /** Work nobody asked for: off, observe (judged and recorded, not done: dsh's observe mode) or on. */
  proactive: "off" | "observe" | "on";
};

export const DEFAULTS: Settings = {
  router: { agent: "", model: "", effort: "", mode: "" },
  worker: { agent: "", model: "", effort: "", mode: "" },
  repos: [],
  gitlab: { host: "gitlab.com" },
  proactive: "observe",
};

const str = (v: unknown, d: string) => (typeof v === "string" ? v.trim() : d);
const oneOf = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
const who = (v: any, d: Who): Who => ({ agent: str(v?.agent, d.agent), model: str(v?.model, d.model), effort: str(v?.effort, d.effort), mode: str(v?.mode, d.mode) });

/** Whatever is stored (partial, old, hand-edited) → complete settings: a missing or unfitting value is the default. */
export function normalize(raw: any): Settings {
  const d = DEFAULTS;
  const r = raw && typeof raw === "object" ? raw : {};
  const repos: Repo[] = [];
  for (const x of Array.isArray(r.repos) ? r.repos : []) {
    const path = str(typeof x === "string" ? x : x?.path, "");
    if (!path || repos.some((y) => y.path === path)) continue;
    const note = str(x?.note, "");
    repos.push({ path, ...(note ? { note } : {}) });
  }
  return {
    router: who(r.router, d.router),
    worker: who(r.worker, d.worker),
    repos,
    gitlab: { host: str(r.gitlab?.host, "") || d.gitlab.host },
    proactive: oneOf(r.proactive, ["off", "observe", "on"] as const, d.proactive),
  };
}
