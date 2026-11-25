// A colour per repository (设置 → 仓库): the person tells their projects apart at a glance in the list (the
// repository's name on a task's row) and on the new-conversation page's folder buttons. Stored as the colour itself
// (#rrggbb), a preset or one they picked: mid tones, readable as text on the dark theme and the light one.
export const PRESETS: { name: string; hex: string }[] = [
  { name: "红", hex: "#e5484d" },
  { name: "橙", hex: "#f76b15" },
  { name: "黄", hex: "#d4a017" },
  { name: "绿", hex: "#30a46c" },
  { name: "青", hex: "#12a594" },
  { name: "蓝", hex: "#0090ff" },
  { name: "靛", hex: "#6e56cf" },
  { name: "紫", hex: "#ab4aba" },
  { name: "粉", hex: "#e93d82" },
  { name: "灰", hex: "#8b8d98" },
];

export const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

const trim = (p: string) => p.replace(/\/+$/, "");

/** The colour of the repository `path` is in (itself or a folder under it, a worktree beside it), if it has one. */
export function colorOf(repos: { path: string; color?: string }[], path?: string): string | undefined {
  if (!path) return undefined;
  const p = trim(path);
  let best: { path: string; color?: string } | undefined;
  for (const r of repos) {
    const rp = trim(r.path);
    // A task's worktree is <repo>.worktrees/<task>: still that repository
    if ((p === rp || p.startsWith(rp + "/") || p.startsWith(rp + ".worktrees/")) && (!best || rp.length > trim(best.path).length)) best = r;
  }
  return best?.color;
}
