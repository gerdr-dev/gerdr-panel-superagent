// The user's memory: facts about their projects that the agents learn while working (this repository goes without an
// MR, that one's release is approved by someone) and that every later task should start with. Not a skill: the skill
// (my-workflow) is how the user works in general, in their words; memory is what holds for one repository, collected
// along the way. When to write one is the skill's (references/memory.md), the files are here.
//
// One markdown file per repository, named after its folder, plus one for what holds everywhere: user/memory/, this
// person's and never shared, so each install of the panel remembers on its own. Plain bullet lines, so the user can
// read and edit them as they are (设置 → 记忆) and the agents get them as they are.

import { USER } from "./_user";

export const MEMORY = `${USER}/memory`;
/** The file for what holds for every repository. Starts with _ so no repository folder can take its name. */
export const GENERAL = "_general";

/** A memory file's name for a repository: its folder's name ("~/src/billing-service/" → "billing-service"). */
export function nameOf(repo: string) {
  return repo.replace(/\/+$/, "").split("/").pop() || repo;
}

const NAME = /^[\w一-鿿.-]+$/;

export function pathOf(name: string) {
  if (!NAME.test(name) || name.startsWith(".")) throw new Error(`记忆的名字不对：${name}`);
  return `${MEMORY}/${name}.md`;
}

/** A memory file's text ("" when there's none). */
export function readMemory(ctx: Ctx, name: string) {
  const p = pathOf(name);
  return ctx.fs.stat(p) ? ctx.fs.read(p).trim() : "";
}

/**
 * Changes one memory file through `edit` (current text → new text), retrying when someone else wrote it in between:
 * several workers may remember at once.
 */
export function editMemory(ctx: Ctx, name: string, edit: (text: string) => string) {
  const p = pathOf(name);
  for (let i = 0; ; i++) {
    const st = ctx.fs.stat(p);
    const next = edit(st ? ctx.fs.read(p) : "");
    try {
      if (!next.trim()) {
        if (st) ctx.fs.trash(p);
        return;
      }
      ctx.fs.write(p, next.replace(/\n*$/, "\n"), st ? { etag: st.etag } : undefined);
      return;
    } catch (e: any) {
      if (i >= 4 || !/etag|changed|modified/i.test(String(e.message))) throw e;
    }
  }
}

/** Adds one line to a memory file. */
export function addLine(ctx: Ctx, name: string, line: string) {
  editMemory(ctx, name, (text) => `${text.replace(/\n*$/, "")}${text.trim() ? "\n" : ""}- ${line}`);
}
