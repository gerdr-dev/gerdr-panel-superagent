// The 流程 page: the user's skills (skills/<name>/SKILL.md + references/*.md), prose in their own words that the
// agents read as a skill. Nothing here interprets it; values the code acts on are settings (local/settings.ts).

import { effective, mine, overlay } from "./_user";

export const DIR = "skills";

// Paths inside skills/: a skill's SKILL.md or one of its references (my-workflow/references/mr.md). No "..".
const PATH = /^[\w\u4e00-\u9fff-]+(\/[\w\u4e00-\u9fff.-]+)*\.md$/;
const ok = (p: string) => PATH.test(p) && !p.split("/").includes("..");

/**
 * The skills' files as this person has them (their edits in user/skills/ over the panel's skills/): each skill's
 * SKILL.md (its index) first, then its references. `changed`: they edited the panel's file
 * (reset brings the default back); `own`: a file only they have.
 */
export function list(input: unknown, ctx: Ctx) {
  return overlay(ctx, DIR)
    .filter((f) => f.rel.endsWith(".md"))
    .map((f) => {
      const name = f.rel;
      const [skill, ...rest] = name.split("/");
      return { name, skill, index: rest.join("/") === "SKILL.md", changed: f.mine && f.shared, own: f.mine && !f.shared };
    })
    .sort((a, b) => a.skill.localeCompare(b.skill) || Number(b.index) - Number(a.index) || a.name.localeCompare(b.name));
}

/** { name } → its text and etag (pass the etag back to save, so two editors don't overwrite each other). */
export function read(input: { name: string }, ctx: Ctx) {
  if (!ok(input.name)) throw new Error("路径不对");
  const p = effective(ctx, `${DIR}/${input.name}`);
  const st = p && ctx.fs.stat(p);
  if (!p || !st) throw new Error(`没有 ${DIR}/${input.name}`);
  return { name: input.name, text: ctx.fs.read(p), etag: st.etag, changed: p.startsWith("user/") && !!ctx.fs.stat(`${DIR}/${input.name}`) };
}

/**
 * { name, text, etag? } → the new etag. Always into this person's copy (user/skills/…): the panel's file stays the
 * shared default. The first save makes the copy; the etag read was the default's then, checked against it.
 */
export function save(input: { name: string; text: string; etag?: string }, ctx: Ctx) {
  if (!ok(input.name)) throw new Error("路径不对");
  const shared = `${DIR}/${input.name}`;
  const own = mine(shared);
  try {
    if (!ctx.fs.stat(own) && input.etag && ctx.fs.stat(shared) && ctx.fs.stat(shared)!.etag !== input.etag) throw new Error("etag changed");
    return ctx.fs.write(own, input.text, input.etag && ctx.fs.stat(own) ? { etag: input.etag } : undefined);
  } catch (e: any) {
    if (/etag|changed|modified/i.test(String(e.message))) throw new Error("文件在别处被改过了：重新打开再改");
    throw e;
  }
}

/** Back to the panel's default: { name } — this person's copy goes to the Trash. */
export function reset(input: { name: string }, ctx: Ctx) {
  if (!ok(input.name)) throw new Error("路径不对");
  const own = mine(`${DIR}/${input.name}`);
  if (!ctx.fs.stat(`${DIR}/${input.name}`)) throw new Error("这个文件只有你有，没有默认的可以恢复");
  if (ctx.fs.stat(own)) ctx.fs.trash(own);
  return read({ name: input.name }, ctx);
}

/**
 * A new reference in a skill: { skill, name, when } → references/<name>.md, and a row in the SKILL.md index saying
 * when to read it (the index is how agents find it). A new skill gets its SKILL.md first.
 */
export function addReference(input: { skill: string; name: string; when: string }, ctx: Ctx) {
  const name = input.name.trim().replace(/\.md$/, "");
  if (!/^[\w\u4e00-\u9fff-]+$/.test(input.skill) || !/^[\w\u4e00-\u9fff-]+$/.test(name)) throw new Error("名字只能有字母、数字、中文、- _");
  // Written as this person's (user/skills/): a reference they add is theirs, like an edit
  const index = mine(`${DIR}/${input.skill}/SKILL.md`);
  const shownIndex = effective(ctx, `${DIR}/${input.skill}/SKILL.md`);
  if (shownIndex && shownIndex !== index) ctx.fs.write(index, ctx.fs.read(shownIndex));
  if (!ctx.fs.stat(index))
    ctx.fs.write(index, `---\nname: ${input.skill}\ndescription: （写清楚什么时候该读这个 skill）\n---\n\n# ${input.skill}\n\n| 参考 | 什么时候看 |\n|---|---|\n`);
  const ref = mine(`${DIR}/${input.skill}/references/${name}.md`);
  if (effective(ctx, `${DIR}/${input.skill}/references/${name}.md`)) throw new Error(`已经有 ${name} 了`);
  ctx.fs.write(ref, `# ${name}\n\n`);
  const st = ctx.fs.stat(index)!;
  const text = ctx.fs.read(index).replace(/\n*$/, "\n");
  ctx.fs.write(index, `${text}| [references/${name}.md](references/${name}.md) | ${input.when.trim() || "（什么时候看）"} |\n`, { etag: st.etag });
  return { name: `${input.skill}/references/${name}.md` };
}

/** A skill file's text as this person has it ("" when there's none): for code that puts it in a message whole. */
export function textOf(ctx: Ctx, name: string) {
  const p = effective(ctx, `${DIR}/${name}`);
  return p ? ctx.fs.read(p).trim() : "";
}
