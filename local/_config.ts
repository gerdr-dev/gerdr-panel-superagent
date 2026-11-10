// The panel's settings as the code reads them: this person's user/settings.json over the defaults
// (ui/src/lib/settings.ts has the shape, the defaults and why these are settings and not prose).

import { DEFAULTS, normalize, type Settings } from "../ui/src/lib/settings";
import { effective, mine, overlay, USER } from "./_user";
import { addLine, GENERAL, nameOf } from "./_memory";

export type { Settings, Who, Repo } from "../ui/src/lib/settings";

export const FILE = `${USER}/settings.json`;

/** What this person set (only that: the rest stays the default), with its etag. */
export function stored(ctx: Ctx): { raw: any; etag?: string; broken?: boolean } {
  migrate(ctx);
  mrToSkill(ctx);
  directToMemory(ctx);
  whoMergesToMemory(ctx);
  const st = ctx.fs.stat(FILE);
  if (!st) return { raw: {} };
  try {
    return { raw: JSON.parse(ctx.fs.read(FILE)), etag: st.etag };
  } catch {
    // Hand-edited into something that isn't JSON: the defaults until it's fixed (the 设置 page says so)
    return { raw: {}, etag: st.etag, broken: true };
  }
}

export function workflow(ctx: Ctx): Settings {
  return normalize(stored(ctx).raw);
}

/** Only what differs from the defaults, so a default changed later still reaches whoever never chose. */
export function diff(s: Settings): any {
  const out: any = {};
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const d: any = DEFAULTS[k];
    const v: any = s[k];
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const sub: any = {};
      for (const kk of Object.keys(d)) if (JSON.stringify(v[kk]) !== JSON.stringify(d[kk])) sub[kk] = v[kk];
      if (Object.keys(sub).length) out[k] = sub;
    } else if (JSON.stringify(v) !== JSON.stringify(d)) out[k] = v;
  }
  return out;
}

// ---- once: from {{variables}} in the skill to settings ----

const VAR = /\{\{([^:{}]+):([^;{}]*)(?:;[^{}]*)?\}\}/g;

/**
 * These values used to be {{name: value ; type}} variables in skills/my-workflow (repos.md, models.md, deliver.md,
 * mr.md, proactive.md). The first read without a settings file takes them from this person's skill files and writes
 * user/settings.json. Their copies of repos.md / models.md (nothing but these values) go to the Trash; in their other
 * copies each {{…}} becomes its plain value, since nothing reads the syntax any more.
 */
function migrate(ctx: Ctx) {
  if (ctx.fs.stat(FILE)) return;
  const vars = new Map<string, string>();
  const files = overlay(ctx, "skills").filter((f) => f.rel.endsWith(".md"));
  for (const f of files) {
    // Not inside `code`: that's how a skill showed the syntax
    const text = ctx.fs.read(f.path).replace(/```[\s\S]*?```|`[^`\n]*`/g, "");
    for (const m of text.matchAll(VAR)) {
      const name = m[1].trim();
      if (!vars.has(name)) vars.set(name, m[2].trim());
    }
  }
  const v = (...names: string[]) => names.map((n) => vars.get(n)).find((x) => x !== undefined);
  const said = (x: string | undefined, map: Record<string, string[]>) => {
    if (x === undefined) return undefined;
    for (const [word, says] of Object.entries(map)) if (says.includes(x.toLowerCase())) return word;
    return undefined;
  };
  const list = (x?: string) => (x ?? "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const num = (x?: string) => (x !== undefined && /^\d+$/.test(x) ? Number(x) : undefined);
  const direct = list(v("直推仓库"));
  const raw = {
    router: { agent: v("派活 agent", "router agent"), model: v("派活模型", "router model"), effort: v("派活思考强度", "router effort") },
    worker: { agent: v("干活 agent", "worker agent"), model: v("干活模型", "worker model"), effort: v("干活思考强度", "worker effort") },
    // 直推仓库 named repositories by path or by group/name: matched on the path's last part
    repos: list(v("仓库", "repos")).map((path) => ({ path, direct: direct.some((d) => path === d || path.endsWith(`/${d.split("/").pop()}`)) })),
    proactive: said(v("主动工作", "proactive"), { off: ["关", "off"], observe: ["只记录", "observe"], on: ["照做", "on"] }),
  };
  ctx.fs.write(FILE, JSON.stringify(diff(normalize(raw)), null, 2) + "\n");
  for (const r of raw.repos) if (r.direct) addLine(ctx, nameOf(r.path), DIRECT);
  for (const f of files) {
    if (!f.mine) continue;
    const rel = `skills/${f.rel}`;
    if (rel.endsWith("/references/repos.md") || rel.endsWith("/references/models.md")) {
      if (effective(ctx, rel) === mine(rel)) ctx.fs.trash(mine(rel));
      continue;
    }
    const text = ctx.fs.read(f.path);
    const plain = text.replace(VAR, (_, _name, value) => String(value).trim());
    if (plain !== text) ctx.fs.write(f.path, plain);
  }
}

// ---- once: the MR settings into this person's skill ----

const MR = "skills/my-workflow/references/mr.md";

/**
 * How MRs are merged and rebased used to be settings (user/settings.json mr), when the MR watcher did it. The worker
 * does it now, following the skill (mr.md): someone who had chosen values gets their own copy of mr.md saying the
 * same, and the setting goes. Untouched defaults say what the shared mr.md says already: nothing to copy.
 */
function mrToSkill(ctx: Ctx) {
  if (!ctx.fs.stat(FILE)) return;
  let raw: any;
  try {
    raw = JSON.parse(ctx.fs.read(FILE));
  } catch {
    return;
  }
  if (!raw?.mr) return;
  const m = raw.mr;
  const from = effective(ctx, MR);
  if (from && !ctx.fs.stat(mine(MR))) {
    let text = ctx.fs.read(from);
    const n = typeof m.minApprovals === "number" ? m.minApprovals : 1;
    if (m.merge === "auto") addLine(ctx, GENERAL, MERGE_ANY);
    if (n !== 1) text = text.replace("至少 1 个人批准过", n === 0 ? "不用等人批准" : `至少 ${n} 个人批准过`);
    if (typeof m.maxRounds === "number") text = text.replace("改了 3 轮", `改了 ${m.maxRounds} 轮`);
    const rebase =
      m.rebase === "auto"
        ? `- 只是落后、没有冲突：直接变基（\`glab mr rebase${m.rebaseSkipCI ? " --skip-ci" : ""}\`）${m.rebaseSkipCI ? "，变基时跳过流水线" : "，变基时跑流水线"}。`
        : m.rebase === "off"
          ? "- 只是落后、没有冲突：不用变基，等 GitLab 说能合再说。"
          : `- 只是落后、没有冲突：先问我要不要变基（\`ask_human\`）；我说变就变，变基时${m.rebaseSkipCI ? "跳过" : "跑"}流水线。`;
    text = text.replace(/^- 只是落后、没有冲突：.*$/m, rebase);
    if (text !== ctx.fs.read(from)) {
      ctx.fs.mkdir(mine(MR).slice(0, mine(MR).lastIndexOf("/")));
      ctx.fs.write(mine(MR), text);
    }
  }
  delete raw.mr;
  ctx.fs.write(FILE, JSON.stringify(raw, null, 2) + "\n");
}

// ---- once: per-repository values into the memory (local/_memory.ts) ----

const DIRECT = "小改动可以直接推到目标分支，不用开 MR；改动大、改了接口或数据结构、拿不准的，还是开 MR（原来是设置里的「小改动可直推」）";
const MERGE_ANY = "MR 能合了就你直接合，没单独说的仓库都这样（原来是 mr.md「谁来合」表里的「其他仓库」）";

/**
 * 「小改动可直推」 was a checkbox per repository in the settings (repos[].direct), passed to the worker by the code. It's
 * a fact about one repository the user may also say in a chat ("这个仓库以后直接推"), so it's memory now: one line in
 * that repository's file, and the setting goes.
 */
function directToMemory(ctx: Ctx) {
  if (!ctx.fs.stat(FILE)) return;
  let raw: any;
  try {
    raw = JSON.parse(ctx.fs.read(FILE));
  } catch {
    return;
  }
  if (!Array.isArray(raw?.repos) || !raw.repos.some((r: any) => r && typeof r === "object" && "direct" in r)) return;
  for (const r of raw.repos) {
    if (!r || typeof r !== "object" || !("direct" in r)) continue;
    if (r.direct === true && typeof r.path === "string") addLine(ctx, nameOf(r.path), DIRECT);
    delete r.direct;
  }
  ctx.fs.write(FILE, JSON.stringify(raw, null, 2) + "\n");
}

/**
 * mr.md had a 「谁来合」 table (repository → who merges). Who merges is per repository, so it's memory now and the
 * shared mr.md points there. Someone with their own copy of mr.md still has the table: its rows go into the memory
 * (「其他仓库」 into the general file, unless it says the default 先问我) and the section is replaced by the shared one.
 */
function whoMergesToMemory(ctx: Ctx) {
  const own = mine(MR);
  if (!ctx.fs.stat(own)) return;
  const text = ctx.fs.read(own);
  const head = "## 可以合并了：谁来合";
  const at = text.indexOf(head);
  if (at < 0 || !text.includes("| 仓库 | 谁来合 |")) return;
  const end = text.indexOf("\n## ", at + head.length);
  const section = text.slice(at, end < 0 ? undefined : end + 1);
  for (const m of section.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)) {
    const [repo, who] = [m[1], m[2]];
    if (repo === "仓库" || /^-+$/.test(repo)) continue;
    if (repo === "其他仓库") {
      if (who === "你直接合") addLine(ctx, GENERAL, MERGE_ANY);
      else if (who !== "先问我") addLine(ctx, GENERAL, `MR 能合了：${who}，没单独说的仓库都这样（原来是 mr.md「谁来合」表里的「其他仓库」）`);
    } else addLine(ctx, nameOf(repo), `MR 能合了谁来合：${who}（原来是 mr.md「谁来合」表里的）`);
  }
  const shared = ctx.fs.stat(MR) ? ctx.fs.read(MR) : "";
  const sAt = shared.indexOf(head);
  const sEnd = shared.indexOf("\n## ", sAt + head.length);
  const fresh = sAt < 0 ? "" : shared.slice(sAt, sEnd < 0 ? undefined : sEnd + 1);
  if (fresh) ctx.fs.write(own, text.replace(section, fresh));
}
