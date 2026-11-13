// The 设置 page and the panel's agent: read and change this person's settings (local/_config.ts, ui/src/lib/settings.ts),
// plus the pickers the page needs (folders, agents).

import { DEFAULTS, normalize, type Settings } from "../ui/src/lib/settings";
import { diff, FILE, stored } from "./_config";
import { allAgents } from "./_agents";

/** → { settings (complete), defaults, etag, broken (the file isn't JSON: defaults in use) } */
export function get(input: unknown, ctx: Ctx) {
  const s = stored(ctx);
  return { settings: normalize(s.raw), defaults: DEFAULTS, etag: s.etag, broken: !!s.broken };
}

/**
 * { settings, etag? } → the new etag. The whole of them, as the page has them; stored is only what differs from the
 * defaults. Pass the etag read, so two editors don't overwrite each other.
 */
export function save(input: { settings: Settings; etag?: string }, ctx: Ctx) {
  // Missing keys would be normalized to the defaults and the file rewritten with them: an agent that passed
  // { repos: [...] } (no settings wrapper) once wiped every other setting and got a success back.
  const s: any = input?.settings;
  const missing = s && typeof s === "object" && !Array.isArray(s) ? Object.keys(DEFAULTS).filter((k) => !(k in s)) : null;
  if (!missing || missing.length)
    throw new Error(
      `settings.save 要的是 { settings: 完整的设置, etag? }（settings.get 拿到的那份改完传回）${missing ? `，缺 ${missing.join(" / ")}` : ""}。只改其中几项用 settings.set`,
    );
  const text = JSON.stringify(diff(normalize(input.settings)), null, 2) + "\n";
  try {
    return ctx.fs.write(FILE, text, input.etag && ctx.fs.stat(FILE) ? { etag: input.etag } : undefined);
  } catch (e: any) {
    if (/etag|changed|modified/i.test(String(e.message))) throw new Error("设置在别处被改过了：重新打开再改");
    throw e;
  }
}

/**
 * For the panel's agent when the user says "from now on…": a part of the settings, merged into what's there.
 * { mr: { merge: "auto" } }, { worker: { model: "opus" } }, { repos: [...] } (a list replaces the list). → the settings.
 */
export function set(input: Partial<Record<keyof Settings, any>>, ctx: Ctx) {
  const cur: any = normalize(stored(ctx).raw);
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!(k in DEFAULTS)) throw new Error(`没有这项设置：${k}（有 ${Object.keys(DEFAULTS).join(" / ")}）`);
    cur[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...cur[k], ...v } : v;
  }
  const next = normalize(cur);
  ctx.fs.write(FILE, JSON.stringify(diff(next), null, 2) + "\n");
  return next;
}

/** For a repository: { path? } → the folders in it, plus the user's recent projects to start from. */
export function browse(input: { path?: string }, ctx: Ctx) {
  const recent = ctx.dirs
    .recent()
    .map((d) => d.path)
    .filter((p) => !p.includes("/.gerdr/"))
    .slice(0, 12);
  // ~ expanded (dirs.stat does it)
  const path = ctx.dirs.stat(input.path || ctx.dirs.home())?.path ?? ctx.dirs.home();
  const entries = ctx.dirs.list(path).map((d) => ({ name: d.name, path: d.path }));
  return { path, home: ctx.dirs.home(), recent, entries };
}

/** The agents and roles set up in Gerdr. */
export async function agents(input: unknown, ctx: Ctx) {
  return (await allAgents(ctx)).map((a) => ({ id: a.id, name: a.name }));
}
