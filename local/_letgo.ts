// Let it go as the code follows it (a helper file: nothing here is callable). The shape, the defaults and the clock are
// ui/src/lib/letgo.ts; what each gate changes is at its own place:
// - inbox:   superagent.ts accept (sent out instead of a 待办 card)
// - unsure:  _secask.ts secAsk (the secretary's decision isn't asked) and the line on its messages (_main.ts toMain)
// - decide:  board.ts ask_human (the worker's pick stands, recorded on the task)
// - message: board.ts reply_message (sent instead of a card, except to the policy's `confirm` people)
// - mode:    tasks.ts workerOf (the permission mode a worker starts in)
// Several policies may be in effect at once, each over its repositories: for work in a repository, the first in effect
// holding there decides (policyFor). Where none does, nothing is let go. How the agents should judge is that policy's
// note, put in their messages whole; skills/superagent-panel/references/letgo.md says how the mechanism works.
// DESIGN.md「Let it go」.

import { ANY_REPO, activeAt, GATE_TEXT, policyFor as pick, type Gate, type Manual, type Policy } from "../ui/src/lib/letgo";
import { workflow } from "./_config";
import { DATA, skillFile } from "./_user";

export const NOTE = "superagent-panel/references/letgo.md";
const FILE = `${DATA}/letgo.json`;

/** What was done without asking the user (a gate open), for the briefing when the policies in effect change. */
export type Done = { at: number; kind: "dispatched" | "decided" | "sent" | "secretary"; task?: string; text: string };

type State = {
  /** Set by hand (the page's buttons, letgo.set): only that policy, until `until`. */
  manual?: Manual;
  /** The policies last seen in effect by letgo.tick (ids, joined), and since when: a change hands the log over. */
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

/** The policies in effect now (in order), how (manual / time / none), until when, and the settings. */
export function current(ctx: Ctx) {
  const l = workflow(ctx).letgo;
  return { ...activeAt(l, new Date(), state(ctx).manual), letgo: l };
}

/** The policy that decides for work in this repository now, if any. */
export function policyFor(ctx: Ctx, repo?: string): Policy | undefined {
  return pick(current(ctx).policies, repo);
}

/**
 * Whether `gate` is open now for work in `repo`: the policy deciding there has it. `unsure` is the secretary's, before
 * there is a repository: any policy in effect that opens it.
 */
export function opens(ctx: Ctx, gate: Gate, repo?: string) {
  if (gate === "unsure") return current(ctx).policies.some((p) => p.gates.includes("unsure"));
  return !!policyFor(ctx, repo)?.gates.includes(gate);
}

/** The permission mode the deciding policy gives this agent (a role: else its engine's) in this repository; "" = 设置's. */
export function modeFor(ctx: Ctx, agent: string, base: string | undefined, repo?: string) {
  const p = policyFor(ctx, repo);
  return (p && (p.mode[agent] || (base ? p.mode[base] : ""))) || "";
}

/**
 * The entry of the deciding policy's 仍要我过目 this conversation / person matches, if any: writing to them stays a card
 * for the user. Matched on the member id, the conversation (a channel id covers its threads), the name as the source
 * shows it (contained, any case) and the link.
 */
export function confirmFor(policy: Policy | undefined, to: { actor?: string; who?: string; key?: string; url?: string }) {
  const low = (s?: string) => (s ?? "").toLowerCase();
  return policy?.confirm.find((c) => {
    const x = low(c);
    if (!x) return false;
    if (low(to.actor) === x) return true;
    const key = low(to.key);
    if (key && (key === x || key.split("/").includes(x))) return true;
    if (to.who && low(to.who).includes(x)) return true;
    return !!to.url && low(to.url).includes(x);
  });
}

/** Records what was done without asking the user, for the briefing when the policies in effect change. */
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

const name = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;
const reposText = (p: Policy) => (p.repos.includes(ANY_REPO) ? "所有仓库" : p.repos.map(name).join("、") || "（没选仓库）");

/** "策略「a 全放行」（管 annulo）、「白天」（管 所有仓库）（按时间，到 19:00）", or "没有策略在生效，什么都问用户". */
export function policyText(c: ReturnType<typeof current>) {
  const how = c.by === "manual" ? "手动选的" : c.by === "time" ? "按时间" : "";
  const until = c.until ? `到 ${hhmm(c.until)}` : "";
  const more = how || until ? `（${[how, until].filter(Boolean).join("，")}）` : "";
  if (!c.policies.length) return `没有策略在生效，什么都问用户${more}`;
  return `策略${c.policies.map((p) => `「${p.name}」（管 ${reposText(p)}）`).join("、")}在生效${more}`;
}

const gateLine = (p: Policy | undefined, g: Gate) => `${GATE_TEXT[g].label}：${p?.gates.includes(g) ? GATE_TEXT[g].open : GATE_TEXT[g].closed}`;

/**
 * What an agent is told about the policies in effect. The secretary: each one with its repositories, its two gates,
 * people and note (a repository none holds: everything asked). A worker: the one deciding in its repository. "" when
 * nothing of theirs is let go and there's nothing to say: then they work as always, asking.
 */
export function agentText(ctx: Ctx, who: "secretary" | "worker", repo?: string): string {
  const c = current(ctx);
  const head = `[Let it go] 现在是${policyText(c)}。`;
  if (who === "worker") {
    const p = pick(c.policies, repo);
    if (!p || (!p.gates.some((g) => g === "decide" || g === "message") && !p.note)) return "";
    const confirm = p.confirm.length ? `\n仍要用户过目的人和对话（给他们的消息一律交给用户发）：${p.confirm.join("、")}` : "";
    return `${head}\n管你这个仓库的是「${p.name}」：\n- ${gateLine(p, "decide")}\n- ${gateLine(p, "message")}${confirm}${p.note ? `\n\n这套策略的说明：\n${p.note}` : ""}`;
  }
  const mine = c.policies.filter((p) => p.gates.includes("inbox") || p.gates.includes("unsure") || p.note);
  if (!mine.length) return "";
  // Whole once per set of policies (the notes can be long), then a line on each message
  const key = `${c.until ?? ""}:${JSON.stringify(c.policies)}`;
  if (state(ctx).toldSecretary === key) return `${head}照之前给你的这几套策略做（怎么用见 ${skillFile(ctx, NOTE)}）。`;
  updateState(ctx, (s) => void (s.toldSecretary = key));
  const each = c.policies.map(
    (p) =>
      `### 「${p.name}」管 ${reposText(p)}\n- ${gateLine(p, "inbox")}\n- ${gateLine(p, "unsure")}` +
      (p.confirm.length ? `\n- 仍要用户过目：${p.confirm.join("、")}` : "") +
      (p.note ? `\n说明：\n${p.note}` : ""),
  );
  return (
    `${head}同一个仓库被几套管着时排在前面的为准；派到没有策略管的仓库的活照样进待办，拿不准就问用户。` +
    `「拿不准时」是派活之前的事：哪套放开了就照那套的说明自己定。\n\n${each.join("\n\n")}`
  );
}
