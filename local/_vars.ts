// Values from the user's skills (skills/<name>/SKILL.md and its references), for code (see ui/src/lib/vars.ts for
// the {{name: value ; type}} syntax). A skill is the user's prose, given to agents as a skill (they read what they
// need); the code only knows the variable names it looks for, under any of a few aliases
// (so someone writing their skill in English works too), and falls back to its careful default when the variable
// is missing or its value doesn't fit.

import { parse, render, typed, type Var } from "../ui/src/lib/vars";
import { overlay } from "./_user";

export const DIR = "skills";

/** The skill files as this person has them: their edits (user/skills/) over the panel's (skills/), by path. */
function files(ctx: Ctx) {
  return overlay(ctx, DIR)
    .filter((f) => f.rel.endsWith(".md"))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Every variable in every skill file (all levels), the first of each name winning (names are meant to be unique). */
function allVars(ctx: Ctx): Var[] {
  const out: Var[] = [];
  for (const f of files(ctx)) out.push(...parse(ctx.fs.read(f.path)));
  return out;
}

/**
 * A value by name (any alias, any skill file). `choices` maps the code's own words to what a user may write
 * ({ auto: ["自动", "auto"] }): the result is the code's word, or `fallback` when nothing fits.
 */
export function pick<T extends string>(ctx: Ctx, names: string[], choices: Record<T, string[]>, fallback: T): T {
  const v = allVars(ctx).find((x) => names.includes(x.name) && !x.error);
  if (!v) return fallback;
  const val = String(typed(v)).trim().toLowerCase();
  for (const [word, says] of Object.entries(choices) as [T, string[]][]) if (says.some((s) => s.toLowerCase() === val)) return word;
  return fallback;
}

export function num(ctx: Ctx, names: string[], fallback: number): number {
  const v = allVars(ctx).find((x) => names.includes(x.name) && !x.error && x.type === "number");
  return v ? (typed(v) as number) : fallback;
}

export function str(ctx: Ctx, names: string[], fallback: string): string {
  const v = allVars(ctx).find((x) => names.includes(x.name) && !x.error);
  return v ? String(typed(v)) : fallback;
}

export function list(ctx: Ctx, names: string[]): string[] {
  const v = allVars(ctx).find((x) => names.includes(x.name) && !x.error);
  if (!v) return [];
  const t = typed(v);
  return Array.isArray(t) ? t : [String(t)];
}

/** The text of the skill file that holds one of these variables, as an agent reads it (values filled in); "" if none. */
export function fileWith(ctx: Ctx, names: string[]): string {
  for (const f of files(ctx)) {
    const text = ctx.fs.read(f.path);
    if (parse(text).some((v) => names.includes(v.name))) return render(text).trim();
  }
  return "";
}
