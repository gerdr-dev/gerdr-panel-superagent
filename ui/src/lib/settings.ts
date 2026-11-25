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
import { isColor } from "./repoColor";

export type Who = { agent: string; model: string; effort: string; mode: string };

export type Repo = {
  path: string;
  /** One line for the router: what this repository is (which service / product). */
  note?: string;
  /** Its colour in the list and on the new-conversation page (#rrggbb: lib/repoColor.ts). */
  color?: string;
};

export type Settings = {
  /** The Superagent's main session (routing only). "" = Gerdr's default for that agent. */
  router: Who;
  /** Workers' defaults; a task's own agent / model wins, and these models only go with this agent. */
  worker: Who;
  repos: Repo[];
  /** Work nobody asked for: off, observe (judged and recorded, not done: dsh's observe mode) or on. */
  proactive: "off" | "observe" | "on";
  /**
   * An outside message the secretary takes as work: "review" = a 待办 card (a card per part) the user looks at, edits
   * and sends out; "dispatch" = sent out right away (2026-11-11: the user wants to see it first, and fix what the
   * secretary made of it).
   */
  inboxWork: "review" | "dispatch";
  /**
   * A message in a conversation a task follows: "worker" = straight to that task's worker; "secretary" = judged first,
   * so it can be left alone or go to another task.
   */
  followUps: "worker" | "secretary";
  /** When the person who sent it hears back: "accept" = when it's taken, "dispatch" = when it's sent out, "never". */
  ack: "accept" | "dispatch" | "never";
  /** What they hear: {id} and {title} are the task's. */
  ackText: string;
  /**
   * What a worker writes to the people in a chat its task follows (board.ts reply_message): "review" = a card the user
   * sends or lets go (local/outbox.ts), the worker carrying on without hearing which; "auto" = sent right away.
   */
  replies: "review" | "auto";
  /**
   * The secretary's conversation is compacted (schedules/compact.json, hourly by default, once it has sat idle an
   * hour) when its context holds at least this many tokens. 0 = whenever the schedule runs and something was said
   * since the last compaction: by time (set the schedule to, say, 04:00). DESIGN.md「秘书」「一个会话，靠压缩」.
   */
  compactTokens: number;
  /**
   * Workers' conversations compacted by tasks.compactWorkers (schedules/worker-compact.json, every 10 minutes): one
   * whose context is at least `percent`% of its window and that has said nothing for `idleMinutes` (its prompt cache
   * is cold by then, so the compaction costs about what its next message would). Tasks that ended are left alone.
   * percent 0 = never. The user asked for it on 2026-11-23 (">60% and quiet 30 min").
   */
  workerCompact: { percent: number; idleMinutes: number };
  /**
   * A requirement whose tasks all ended (done / dropped) more than this many days ago is archived: moved out of
   * user/data/reqs/, so the board stops reading it every run. Comes back when asked for (local/_archive.ts). 0 = never.
   */
  archiveDays: number;
  /**
   * A question card's answer, picked in the chat, waits this many seconds (with an undo) before it's sent to the
   * worker: once sent, it acts on it. 0 = sent at once. Gerdr's own default is 3 (it was 6, which felt slow).
   */
  undoSeconds: number;
};

export const ACK_TEXT = "收到，建了任务 {id}「{title}」，有结果会在这里说。";

export const DEFAULTS: Settings = {
  router: { agent: "", model: "", effort: "", mode: "" },
  worker: { agent: "", model: "", effort: "", mode: "" },
  repos: [],
  proactive: "observe",
  inboxWork: "review",
  followUps: "worker",
  ack: "dispatch",
  ackText: ACK_TEXT,
  replies: "review",
  compactTokens: 80_000,
  workerCompact: { percent: 60, idleMinutes: 30 },
  archiveDays: 14,
  undoSeconds: 3,
};

const str = (v: unknown, d: string) => (typeof v === "string" ? v.trim() : d);
const oneOf = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
const count = (v: unknown, d: number) => (v !== "" && v != null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);
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
    const color = isColor(x?.color) ? x.color.toLowerCase() : "";
    repos.push({ path, ...(note ? { note } : {}), ...(color ? { color } : {}) });
  }
  return {
    router: who(r.router, d.router),
    worker: who(r.worker, d.worker),
    repos,
    proactive: oneOf(r.proactive, ["off", "observe", "on"] as const, d.proactive),
    inboxWork: oneOf(r.inboxWork, ["review", "dispatch"] as const, d.inboxWork),
    followUps: oneOf(r.followUps, ["worker", "secretary"] as const, d.followUps),
    ack: oneOf(r.ack, ["accept", "dispatch", "never"] as const, d.ack),
    ackText: str(r.ackText, "") || d.ackText,
    replies: oneOf(r.replies, ["review", "auto"] as const, d.replies),
    compactTokens: Number.isFinite(Number(r.compactTokens)) && Number(r.compactTokens) >= 0 && r.compactTokens !== "" && r.compactTokens != null ? Math.round(Number(r.compactTokens)) : d.compactTokens,
    workerCompact: {
      percent: Math.min(100, count(r.workerCompact?.percent, d.workerCompact.percent)),
      idleMinutes: count(r.workerCompact?.idleMinutes, d.workerCompact.idleMinutes),
    },
    archiveDays: count(r.archiveDays, d.archiveDays),
    undoSeconds: Math.min(30, count(r.undoSeconds, d.undoSeconds)),
  };
}
