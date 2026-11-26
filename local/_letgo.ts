// Let it go as the code follows it (a helper file: nothing here is callable). The shape, the defaults and the clock are
// ui/src/lib/letgo.ts; what each gate changes is at its own place:
// - inbox:   superagent.ts accept (sent out instead of a 待办 card)
// - unsure:  _secask.ts secAsk (the secretary's decision isn't asked) and the line on its messages (_main.ts toMain)
// - decide:  board.ts ask_human (the worker's pick stands, recorded on the task)
// - message: board.ts reply_message (sent instead of a card, except to the policy's `confirm` people)
// - mode:    tasks.ts workerOf (the permission mode a worker starts in)
// No policy in effect: every gate closed. How the agents should judge is the policy's note, put in their messages
// whole; skills/superagent-panel/references/letgo.md says how the mechanism works. DESIGN.md「Let it go」.

import { ANY_REPO, GATE_TEXT, GATES, policyAt, type Gate, type Manual } from "../ui/src/lib/letgo";
import { workflow } from "./_config";
import { DATA, skillFile } from "./_user";

export const NOTE = "superagent-panel/references/letgo.md";
const FILE = `${DATA}/letgo.json`;

/** What was done without asking the user (a gate open), for the briefing when the policy changes. */
export type Done = { at: number; kind: "dispatched" | "decided" | "sent" | "secretary"; task?: string; text: string };

type State = {
  /** Set by hand (the page's buttons, letgo.set): overrides the times until `until`. */
  manual?: Manual;
  /** The policy last seen by letgo.tick ("" = none), and since when: a change hands the log to the secretary. */
  last?: { policy: string; since: number };
  log?: Done[];
  /** What the secretary was last told in full (agentText): later messages get one short line. */
  toldSecretary?: string;
};

export function state(ctx: Ctx): State {
  const st = ctx.fs.stat(FILE);
  if (!st) return {};
  try {
    return JSON.parse(ctx.fs.read(FILE));
  } catch {
    return {};
  }
}

export function updateState<T>(ctx: Ctx, f: (s: State) => T): T {
  const s = state(ctx);
  const out = f(s);
  ctx.fs.write(FILE, JSON.stringify(s, null, 2) + "\n");
  return out;
}

/** The policy in effect now (none: nothing let go), how (manual / time / none), until when, and the settings. */
export function current(ctx: Ctx) {
  const l = workflow(ctx).letgo;
  return { ...policyAt(l, new Date(), state(ctx).manual), letgo: l };
}

const norm = (p?: string) => (p ?? "").trim().replace(/(.)\/+$/, "$1");

/** Whether the policy in effect holds in this repository. */
export function inRepo(ctx: Ctx, repo?: string) {
  const p = current(ctx).policy;
  if (!p) return false;
  if (p.repos.includes(ANY_REPO)) return true;
  const r = norm(repo);
  return !!r && p.repos.some((x) => norm(x) === r);
}

/**
 * Whether `gate` is open now for work in `repo`. `unsure` is the secretary's, before there is a repository: the policy
 * alone. Every other gate also needs the repository in the policy.
 */
export function opens(ctx: Ctx, gate: Gate, repo?: string) {
  const p = current(ctx).policy;
  if (!p?.gates.includes(gate)) return false;
  return gate === "unsure" || inRepo(ctx, repo);
}

/** The permission mode the policy in effect gives a worker of this engine in this repository; "" = 设置's. */
export function modeFor(ctx: Ctx, engine: string, repo?: string) {
  const p = current(ctx).policy;
  if (!p || !inRepo(ctx, repo)) return "";
  return engine === "codex" ? p.mode.codex : engine === "claude" ? p.mode.claude : "";
}

/**
 * The entry of the policy's 仍要我过目 this conversation / person matches, if any: writing to them stays a card for the
 * user. Matched on the member id, the conversation (a channel id covers its threads), the name as the source shows it
 * (contained, any case) and the link.
 */
export function confirmFor(ctx: Ctx, to: { actor?: string; who?: string; key?: string; url?: string }) {
  const low = (s?: string) => (s ?? "").toLowerCase();
  return current(ctx).policy?.confirm.find((c) => {
    const x = low(c);
    if (!x) return false;
    if (low(to.actor) === x) return true;
    const key = low(to.key);
    if (key && (key === x || key.split("/").includes(x))) return true;
    if (to.who && low(to.who).includes(x)) return true;
    return !!to.url && low(to.url).includes(x);
  });
}

/** Records what was done without asking the user, for the briefing when the policy changes. */
export function logDone(ctx: Ctx, d: Omit<Done, "at">) {
  updateState(ctx, (s) => {
    s.log = [...(s.log ?? []), { ...d, at: Date.now() }].slice(-300);
  });
}

/** "14:05", or "11/27 09:00" for another day. */
export function hhmm(ms?: number) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? "" : `${d.getMonth() + 1}/${d.getDate()} `}${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "策略「下班」（按时间，到 09:00）", or "没有策略在生效：什么都问我". */
export function policyText(c: ReturnType<typeof current>) {
  const how = c.by === "manual" ? "手动选的" : c.by === "time" ? "按时间" : "";
  const until = c.until ? `到 ${hhmm(c.until)}` : "";
  const more = how || until ? `（${[how, until].filter(Boolean).join("，")}）` : "";
  return c.policy ? `策略「${c.policy.name}」${more}` : `没有策略在生效，什么都问用户${more}`;
}

/**
 * What an agent is told about the policy in effect: each of its gates open or closed (the secretary's; for a worker
 * what holds in its repository), who is still looked at first, and the note whole. "" when it lets nothing of theirs go
 * and says nothing: then they work as always, asking.
 */
export function agentText(ctx: Ctx, who: "secretary" | "worker", repo?: string): string {
  const c = current(ctx);
  const p = c.policy;
  if (!p) return "";
  const mine = GATES.filter((g) => (who === "secretary" ? g === "inbox" || g === "unsure" : g === "decide" || g === "message"));
  const here = who === "secretary" || inRepo(ctx, repo);
  const open = here ? mine.filter((g) => p.gates.includes(g)) : [];
  if (!open.length && !p.note) return "";
  const head = `[Let it go] 现在是${policyText(c)}。`;
  if (who === "secretary") {
    // Whole once per policy (the note can be long), then a line on each message
    const key = `${c.until ?? ""}:${JSON.stringify(p)}`;
    if (state(ctx).toldSecretary === key) return `${head}照之前给你的这套策略做（怎么用见 ${skillFile(ctx, NOTE)}）。`;
    updateState(ctx, (s) => void (s.toldSecretary = key));
  }
  const gates = mine.map((g) => `- ${GATE_TEXT[g].label}：${open.includes(g) ? GATE_TEXT[g].open : GATE_TEXT[g].closed}`).join("\n");
  const repos =
    who === "secretary" && p.gates.includes("inbox")
      ? `\n这套策略管的仓库（派到别的仓库的活照样进待办）：${p.repos.includes(ANY_REPO) ? "所有仓库" : p.repos.join("、") || "（没有）"}`
      : who === "worker" && !here
        ? "\n这套策略不管你这个任务的仓库：照常问用户。"
        : "";
  const confirm = p.confirm.length ? `\n仍要用户过目的人和对话（给他们的消息一律交给用户发）：${p.confirm.join("、")}` : "";
  return `${head}\n${gates}${repos}${confirm}${p.note ? `\n\n这套策略的说明：\n${p.note}` : ""}`;
}
