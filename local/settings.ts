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

/** The user's projects, most recently used first (gerdr's own panel folders left out). */
const recentProjects = (ctx: Ctx) =>
  ctx.dirs
    .recent()
    .map((d) => d.path)
    .filter((p) => !p.includes("/.gerdr/"));

const parentOf = (p: string) => p.replace(/\/[^/]*\/?$/, "") || "/";

// Half-typed text reaches these on every keystroke (~someone, a folder that can't be read): nothing, not an error
const statOf = (ctx: Ctx, p: string) => {
  try {
    return ctx.dirs.stat(p);
  } catch {
    return null;
  }
};
const listOf = (ctx: Ctx, p: string) => {
  try {
    return ctx.dirs.list(p);
  } catch {
    return [];
  }
};

/**
 * For a repository: { path? } → the folders in it, plus the user's recent projects to start from. A path that isn't a
 * folder (half typed, a file, gone) opens at the nearest folder above it, so the browser starts where the field points.
 */
export function browse(input: { path?: string }, ctx: Ctx) {
  let path = input?.path?.trim() || ctx.dirs.home();
  // ~ expanded (dirs.stat does it)
  let st = statOf(ctx, path);
  for (let i = 0; (!st || !st.dir) && path !== "/" && i < 64; i++) st = statOf(ctx, (path = parentOf(path)));
  path = st?.dir ? st.path : ctx.dirs.home();
  const entries = listOf(ctx, path).map((d) => ({ name: d.name, path: d.path, git: d.git }));
  return { path, home: ctx.dirs.home(), recent: recentProjects(ctx).slice(0, 12), entries };
}

/**
 * The folder field as it's typed: { text } → { home, items: up to 12 folders it could mean }. A path (starting with / or ~)
 * lists the folders next to its last part whose names start with it, then those containing it, case-insensitive:
 * ~/GolandProjects/ger → gerdr, gerdr-addon… A bare name looks among the recent projects (name, then full path).
 */
export function complete(input: { text?: string }, ctx: Ctx) {
  const text = input?.text?.trim() ?? "";
  const home = ctx.dirs.home();
  if (!text) return { home, items: [] };
  const rank = <T>(all: T[], key: (x: T) => string, q: string) => {
    const s = q.toLowerCase();
    const starts = all.filter((x) => key(x).toLowerCase().startsWith(s));
    return [...starts, ...all.filter((x) => !starts.includes(x) && key(x).toLowerCase().includes(s))];
  };
  if (text.startsWith("/") || text.startsWith("~")) {
    const cut = text.lastIndexOf("/");
    // "~" alone: what's in the home folder; "/a/b/c" → the folders of /a/b/ starting with c
    const [dir, part] = cut < 0 ? [text, ""] : [text.slice(0, cut + 1), text.slice(cut + 1)];
    const st = statOf(ctx, dir);
    if (!st?.dir) return { home, items: [] };
    const items = rank(listOf(ctx, st.path), (d) => d.name, part).slice(0, 12);
    return { home, items: items.map((d) => ({ name: d.name, path: d.path, git: d.git })) };
  }
  const name = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
  const all = recentProjects(ctx);
  const hits = [...new Set([...rank(all, name, text), ...rank(all, (p) => p, text)])].slice(0, 12);
  return { home, items: hits.map((p) => ({ name: name(p), path: p, git: !!statOf(ctx, p)?.git })) };
}

/**
 * The agents and roles set up in Gerdr, for 设置's menus: what each takes as model / effort, and what an empty field
 * means — Gerdr's own defaults (Settings → its default agent, and per agent its model / effort / permission mode), so
 * the menu says 默认（Opus 5.5） rather than a bare 默认. `default`: the agent an empty agent field starts.
 */
export async function agents(input: unknown, ctx: Ctx) {
  const conf = await gerdrDefaults(ctx);
  return (await allAgents(ctx)).map((a) => ({
    id: a.id,
    name: a.name,
    base: a.base,
    models: a.models,
    efforts: a.efforts,
    default: a.id === conf.agent || undefined,
    defaults: { model: conf.config[a.id]?.model, effort: conf.config[a.id]?.effort, mode: conf.modes[a.id] },
  }));
}

/** Gerdr's defaults for new sessions (its config.json, through `gerdr config`); none known when that fails. */
async function gerdrDefaults(ctx: Ctx) {
  const get = async (key: string) => {
    const r = await ctx.exec("gerdr", ["config", "get", key], { timeout: 10_000 }).catch(() => null);
    try {
      return r?.code === 0 ? JSON.parse(r.stdout) : undefined;
    } catch {
      return undefined;
    }
  };
  const [agent, config, modes] = await Promise.all([get("defaultAgent"), get("defaultConfig"), get("defaultModes")]);
  return {
    agent: typeof agent === "string" ? agent : "",
    config: (config ?? {}) as Record<string, { model?: string; effort?: string }>,
    modes: (modes ?? {}) as Record<string, string>,
  };
}
