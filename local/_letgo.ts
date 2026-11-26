// 放行 (Let it go) as the code follows it (a helper file: nothing here is callable). The shape, the defaults and the
// clock are ui/src/lib/letgo.ts; what each gate changes is at its own place:
// - inbox:      superagent.ts accept (sent out instead of a 待办 card)
// - unsure:     _secask.ts secAsk (the secretary's decision isn't asked) and the line on its messages (_main.ts toMain)
// - decide:     board.ts ask_human (the worker's pick stands, recorded on the task)
// - message:    board.ts reply_message (sent instead of a card, except to the policy's `confirm` people)
// - permission: tasks.ts workerOf (the mode a worker starts in)
// How the agents should judge while let go is prose: the shared note (skills/superagent-panel/references/letgo.md, red
// lines and the like) and the policy's own note, put in their messages whole. DESIGN.md「放行」.

import { GATE_NAME, policyAt, type Gate, type Manual } from "../ui/src/lib/letgo";
import { workflow } from "./_config";
import { DATA, skillFile } from "./_user";
import { textOf } from "./playbooks";

export const NOTE = "superagent-panel/references/letgo.md";
const FILE = `${DATA}/letgo.json`;

/** What one let-go time did on the user's behalf, for the briefing when it ends. */
export type Done = { at: number; kind: "dispatched" | "decided" | "sent" | "secretary"; task?: string; text: string };

type State = {
  /** Set by hand (the 放行 page's buttons, letgo.set): overrides the times until `until`. */
  manual?: Manual;
  /** The policy last seen by letgo.tick ("" = none), and since when: a change to none asks for the briefing. */
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

/** The policy holding now (none: as usual), how (manual / time), until when, and the settings. */
export function current(ctx: Ctx) {
  const l = workflow(ctx).letgo;
  return { ...policyAt(l, new Date(), state(ctx).manual), letgo: l };
}

const norm = (p?: string) => (p ?? "").trim().replace(/(.)\/+$/, "$1");

/** Whether the policy holding now lets this repository go. */
export function repoLetGo(ctx: Ctx, repo?: string) {
  const r = norm(repo);
  return !!r && !!current(ctx).policy?.repos.some((x) => norm(x) === r);
}

/**
 * Whether `gate` is open now for work in `repo`. `unsure` is the secretary's, before there is a repository: the policy
 * alone. Every other gate also needs the repository in the policy.
 */
export function opens(ctx: Ctx, gate: Gate, repo?: string) {
  const p = current(ctx).policy;
  if (!p?.gates.includes(gate)) return false;
  return gate === "unsure" || repoLetGo(ctx, repo);
}

/**
 * The entry of the holding policy's 要你过目的人 this conversation / person matches, if any: writing to them stays a
 * card for the user. Matched on the member id, the conversation (a channel id covers its threads), the name as the
 * source shows it (contained, any case) and the link.
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

/** Records what was done on the user's behalf while let go, for the briefing when it ends. */
export function logDone(ctx: Ctx, d: Omit<Done, "at">) {
  if (!current(ctx).policy) return;
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

/** "放行「全放行」（按时间段，到 09:00）", or "平时". */
export function policyText(c: ReturnType<typeof current>) {
  const how = c.by === "manual" ? "手动选的" : c.by === "time" ? "按时间段" : "";
  const until = c.until ? `到 ${hhmm(c.until)}` : "";
  const more = how || until ? `（${[how, until].filter(Boolean).join("，")}）` : "";
  return c.policy ? `放行「${c.policy.name}」${more}` : `平时${c.by === "manual" ? more : ""}`;
}

/** The shared note (letgo.md) without its title, then the policy's own. */
function notes(ctx: Ctx, own: string) {
  const shared = textOf(ctx, NOTE).replace(/^---[\s\S]*?---\s*/, "").replace(/^# .*\n+/, "").trim();
  return [shared, own.trim() && `这一套策略自己的说明：\n${own.trim()}`].filter(Boolean).join("\n\n");
}

/**
 * What an agent is told while let go: the policy, what is open (the secretary's gates; for a worker what holds in its
 * repository), who is still looked at first, and the notes whole. "" when nothing is let go.
 */
export function agentText(ctx: Ctx, who: "secretary" | "worker", repo?: string): string {
  const c = current(ctx);
  const p = c.policy;
  if (!p) return "";
  const head = `[放行] 现在是${policyText(c)}：用户不在旁边，能自己做的就做，别停下来等他。`;
  if (who === "secretary") {
    // Whole once per policy (the notes can be long), then a line on each message
    const key = `${c.until ?? ""}:${JSON.stringify(p)}`;
    if (state(ctx).toldSecretary === key) return `${head}照之前给你的放行说明做（共用的部分在 ${skillFile(ctx, NOTE)}）。`;
    updateState(ctx, (s) => void (s.toldSecretary = key));
  }
  if (who === "worker" && !repoLetGo(ctx, repo)) return `${head}但这一套策略没放行你这个任务的仓库：照平时做，要拍板的照样问用户。`;
  const open = p.gates.filter((g) => (who === "secretary" ? g === "inbox" || g === "unsure" : g !== "inbox" && g !== "unsure"));
  const repos = who === "secretary" && p.gates.includes("inbox") ? `\n放行的仓库（派到别的仓库的活照平时进待办）：${p.repos.join("、") || "（没有）"}` : "";
  const confirm = p.confirm.length ? `\n这一套里仍要用户过目的人和对话（给他们发消息一律交给用户发）：${p.confirm.join("、")}` : "";
  const n = notes(ctx, p.note);
  return `${head}\n放开的：\n${open.map((g) => `- ${GATE_NAME[g]}`).join("\n") || "- （这一套没放开你这边的环节）"}${repos}${confirm}${n ? `\n\n用户写的放行说明：\n${n}` : ""}`;
}
