// The panel's settings as the code reads them: this person's user/settings.json over the defaults
// (ui/src/lib/settings.ts has the shape, the defaults and why these are settings and not prose).

import { DEFAULTS, normalize, type Settings } from "../ui/src/lib/settings";
import { USER } from "./_user";

export type { Settings, Who, Repo } from "../ui/src/lib/settings";

export const FILE = `${USER}/settings.json`;

/** What this person set (only that: the rest stays the default), with its etag. */
export function stored(ctx: Ctx): { raw: any; etag?: string; broken?: boolean } {
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
  seedGeneral(ctx);
  return normalize(stored(ctx).raw);
}

// The general working directory: where work that belongs to no repository runs (research, writing, one-off scripts,
// a change across several repositories with none in charge). Before it a task without a repository had nowhere to
// go: the secretary had to pick some repository, split the task, or ask (t175, 2026-11-27). Not the task's artifacts
// folder: that one is renamed with the task and only exists once something is put in it. Its path comes from Gerdr's
// artifacts (~/Gerdr/<project>/general, English on the user's word), reserved by key so it is found again if moved.
const GENERAL_KEY = "general";
export const GENERAL_NOTE = "通用：不属于任何仓库的活（调研、文案、一次性脚本），和几个仓库一起改、又没有哪个是主的活";

/** The general working directory's path (whether or not it exists yet); null on a Gerdr without artifacts. */
export function generalDir(ctx: Ctx): string | null {
  const a = (ctx as any).artifacts;
  if (!a) return null;
  try {
    return a.folder({ key: GENERAL_KEY, name: "general" }).path || null;
  } catch {
    return null;
  }
}

/**
 * Puts the general working directory into the list once (generalSeeded), so it is there by default yet stays gone
 * when the person removes it. Not a default in code: that would bring it back after every removal.
 */
export function seedGeneral(ctx: Ctx) {
  const s = stored(ctx);
  if (s.broken || s.raw?.generalSeeded === true) return;
  const p = generalDir(ctx);
  if (!p) return;
  const cur = normalize(s.raw);
  if (!cur.repos.some((r) => r.path === p)) cur.repos.push({ path: p, note: GENERAL_NOTE });
  cur.generalSeeded = true;
  try {
    ctx.fs.write(FILE, JSON.stringify(diff(cur), null, 2) + "\n", s.etag ? { etag: s.etag } : undefined);
  } catch (e: any) {
    ctx.log(`加通用工作目录失败：${e?.message ?? e}`);
  }
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

/** The general working directory is made when work first goes there (a folder nobody used stays out of Finder). */
export async function makeGeneral(ctx: Ctx, path: string) {
  if (!path || ctx.dirs.stat(path)?.dir || path !== generalDir(ctx)) return;
  const r = await ctx.exec("mkdir", ["-p", path], { timeout: 10_000 });
  if (r.code !== 0) throw new Error(`建通用工作目录失败：${r.stderr.trim()}`);
}
