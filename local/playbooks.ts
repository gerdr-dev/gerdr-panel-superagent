// The 流程 page: the user's skills (skills/<name>/SKILL.md + references/*.md, prose with {{variables}}), and the
// pickers its variable editor needs (folders, files, agents). Nothing here interprets a skill: that's the code that
// reads its values (_vars.ts) and the agents that read it as a skill.

import { parse } from "../ui/src/lib/vars";
import { DIR } from "./_vars";

// Paths inside skills/: a skill's SKILL.md or one of its references (my-workflow/references/mr.md). No "..".
const PATH = /^[\w\u4e00-\u9fff-]+(\/[\w\u4e00-\u9fff.-]+)*\.md$/;
const ok = (p: string) => PATH.test(p) && !p.split("/").includes("..");

/** The skills' files: each skill's SKILL.md (its index) first, then its references, with variable counts. */
export function list(input: unknown, ctx: Ctx) {
  return ctx.fs
    .list(DIR)
    .filter((f) => f.path.endsWith(".md"))
    .map((f) => {
      const name = f.path.slice(DIR.length + 1);
      const vars = parse(ctx.fs.read(f.path));
      const [skill, ...rest] = name.split("/");
      return { name, skill, index: rest.join("/") === "SKILL.md", vars: vars.length, errors: vars.filter((v) => v.error).length };
    })
    .sort((a, b) => a.skill.localeCompare(b.skill) || Number(b.index) - Number(a.index) || a.name.localeCompare(b.name));
}

/** { name } → its text and etag (pass the etag back to save, so two editors don't overwrite each other). */
export function read(input: { name: string }, ctx: Ctx) {
  if (!ok(input.name)) throw new Error("路径不对");
  const p = `${DIR}/${input.name}`;
  const st = ctx.fs.stat(p);
  if (!st) throw new Error(`没有 ${p}`);
  return { name: input.name, text: ctx.fs.read(p), etag: st.etag };
}

/** { name, text, etag? } → the new etag. */
export function save(input: { name: string; text: string; etag?: string }, ctx: Ctx) {
  if (!ok(input.name)) throw new Error("路径不对");
  try {
    return ctx.fs.write(`${DIR}/${input.name}`, input.text, input.etag ? { etag: input.etag } : undefined);
  } catch (e: any) {
    if (/etag|changed|modified/i.test(String(e.message))) throw new Error("文件在别处被改过了：重新打开再改");
    throw e;
  }
}

/**
 * A new reference in a skill: { skill, name, when } → references/<name>.md, and a row in the SKILL.md index saying
 * when to read it (the index is how agents find it). A new skill gets its SKILL.md first.
 */
export function addReference(input: { skill: string; name: string; when: string }, ctx: Ctx) {
  const name = input.name.trim().replace(/\.md$/, "");
  if (!/^[\w\u4e00-\u9fff-]+$/.test(input.skill) || !/^[\w\u4e00-\u9fff-]+$/.test(name)) throw new Error("名字只能有字母、数字、中文、- _");
  const index = `${DIR}/${input.skill}/SKILL.md`;
  if (!ctx.fs.stat(index))
    ctx.fs.write(index, `---\nname: ${input.skill}\ndescription: （写清楚什么时候该读这个 skill）\n---\n\n# ${input.skill}\n\n| 参考 | 什么时候看 |\n|---|---|\n`);
  const ref = `${DIR}/${input.skill}/references/${name}.md`;
  if (ctx.fs.stat(ref)) throw new Error(`已经有 ${name} 了`);
  ctx.fs.write(ref, `# ${name}\n\n`);
  const st = ctx.fs.stat(index)!;
  const text = ctx.fs.read(index).replace(/\n*$/, "\n");
  ctx.fs.write(index, `${text}| [references/${name}.md](references/${name}.md) | ${input.when.trim() || "（什么时候看）"} |\n`, { etag: st.etag });
  return { name: `${input.skill}/references/${name}.md` };
}

/** For a dir / file variable: { path? } → what's in it (folders first), plus the user's projects to start from. */
export async function browse(input: { path?: string; files?: boolean }, ctx: Ctx) {
  const recent = ctx.dirs.recent().slice(0, 12).map((d) => d.path);
  // ~ expanded (dirs.stat does it; ls wouldn't)
  const path = ctx.dirs.stat(input.path || ctx.dirs.home())?.path ?? ctx.dirs.home();
  const dirs = ctx.dirs.list(path).map((d) => ({ name: d.name, path: d.path, dir: true }));
  let files: { name: string; path: string; dir: boolean }[] = [];
  if (input.files) {
    const r = await ctx.exec("ls", ["-1Ap", path], { timeout: 10_000 });
    if (r.code === 0)
      files = r.stdout
        .split("\n")
        .filter((n) => n && !n.endsWith("/") && !n.startsWith("."))
        .map((n) => ({ name: n, path: `${path.replace(/\/$/, "")}/${n}`, dir: false }));
  }
  return { path, home: ctx.dirs.home(), recent, entries: [...dirs, ...files] };
}

/** For an agent variable: the agents and roles set up in Gerdr. */
export async function agents(input: unknown, ctx: Ctx) {
  const r = await ctx.exec("gerdr", ["session", "agents"], { timeout: 15_000 });
  if (r.code !== 0) return [];
  try {
    return (JSON.parse(r.stdout) as any[]).map((a) => ({ id: a.id, name: a.name ?? a.id }));
  } catch {
    return [];
  }
}
