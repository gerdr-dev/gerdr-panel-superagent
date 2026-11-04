// Values from the user's skills (skills/<name>/SKILL.md and its references), for code (see ui/src/lib/vars.ts for
// the {{name: value ; type}} syntax). A skill is the user's prose, given to agents as a skill (they read what they
// need); the code only knows the variable names it looks for, under any of a few aliases
// (so someone writing their skill in English works too), and falls back to its careful default when the variable
// is missing or its value doesn't fit.

import { parse, render, typed, type Var } from "../ui/src/lib/vars";

export const DIR = "skills";

function textOf(ctx: Ctx, file: string) {
  const p = `${DIR}/${file}`;
  return ctx.fs.stat(p) ? ctx.fs.read(p) : "";
}

/** Every variable in every skill file (all levels), the first of each name winning (names are meant to be unique). */
function allVars(ctx: Ctx): Var[] {
  const out: Var[] = [];
  for (const f of ctx.fs.list(DIR)) if (f.path.endsWith(".md")) out.push(...parse(textOf(ctx, f.path.slice(DIR.length + 1))));
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
  for (const f of ctx.fs.list(DIR)) {
    if (!f.path.endsWith(".md")) continue;
    const text = textOf(ctx, f.path.slice(DIR.length + 1));
    if (parse(text).some((v) => names.includes(v.name))) return render(text).trim();
  }
  return "";
}
