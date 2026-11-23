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
