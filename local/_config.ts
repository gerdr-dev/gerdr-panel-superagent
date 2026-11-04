// The panel's settings as the code reads them: this person's user/settings.json over the defaults
// (ui/src/lib/settings.ts has the shape, the defaults and why these are settings and not prose).

import { DEFAULTS, normalize, type Settings } from "../ui/src/lib/settings";
import { effective, mine, overlay, USER } from "./_user";

export type { Settings, Who, Repo } from "../ui/src/lib/settings";

export const FILE = `${USER}/settings.json`;

/** What this person set (only that: the rest stays the default), with its etag. */
export function stored(ctx: Ctx): { raw: any; etag?: string; broken?: boolean } {
  migrate(ctx);
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
    gitlab: { host: v("GitLab", "gitlab") },
    mr: {
      merge: said(v("合并", "merge"), { auto: ["自动", "auto"], manual: ["手动", "manual"] }),
      minApprovals: num(v("批准人数", "approvals")),
      rebase: said(v("变基", "rebase"), { auto: ["自动", "auto"], manual: ["手动", "manual"], off: ["不做", "off", "no"] }),
      rebaseSkipCI: said(v("变基跑流水线", "rebase pipeline"), { run: ["跑", "run", "yes"], skip: ["跳过", "skip", "no"] }) === "skip" || undefined,
      maxRounds: num(v("最多轮数", "max rounds")),
    },
    proactive: said(v("主动工作", "proactive"), { off: ["关", "off"], observe: ["只记录", "observe"], on: ["照做", "on"] }),
  };
  ctx.fs.write(FILE, JSON.stringify(diff(normalize(raw)), null, 2) + "\n");
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
