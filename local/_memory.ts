// The user's memory: facts about their projects that the agents learn while working (this repository goes without an
// MR, that one's release is approved by someone) and that every later task should start with. Not a skill: the skill
// (superagent-panel) is how the user works in general, in their words; memory is what holds for one repository, collected
// along the way. When to write one is the skill's (references/memory.md), the files are here.
//
// One markdown file per repository, named after its folder, plus one for what holds everywhere: user/memory/, this
// person's and never shared, so each install of the panel remembers on its own. Plain bullet lines, so the user can
// read and edit them as they are (设置 → 记忆) and the agents get them as they are.

import { USER } from "./_user";
import { workflow } from "./_config";

export const MEMORY = `${USER}/memory`;
/** The file for what holds for every repository. Starts with _ so no repository folder can take its name. */
export const GENERAL = "_general";
/**
 * Mid-term memory: what is going on right now and who it involves (someone the user asked on a task's behalf, who a
 * task waits on, what a colleague is working on with the user), written by any agent on its own judgement, tied to a
 * task when there is one, deleted once it's settled. Not pushed into any message: agents look it up (memory.mid) when
 * they need to connect a message or a person to work. DESIGN.md「中期记忆」.
 */
export const MID = "_mid";

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

// ---- a repository's notes: Gerdr's since 2026-11-27 ----
//
// What holds for one repository moved into Gerdr (ctx.repoMemory, its internal/repomem): kept per repository path for
// every project and agent, and put into every session working there by Gerdr itself — a helper session a worker opens
// in another repository included, which the panel's own injection never reached (the user: "这个记忆能力……应该由本体
// 提供"). The panel keeps what is its own: what holds for all its repositories (_general) and the mid-term memory
// (_mid). On a Gerdr without ctx.repoMemory, the panel's files as before.

type RepoNotes = { repo: string; path: string; text: string };
type RepoStore = { list(): RepoNotes[]; read(repo: string): RepoNotes; write(repo: string, text: string): RepoNotes; add(repo: string, line: string): RepoNotes & { added: boolean } };

/** Gerdr's per-repository notes, or null on a Gerdr without them (the panel's files then). Moves old files over first. */
export function repoStore(ctx: Ctx): RepoStore | null {
  const store = (ctx as any).repoMemory as RepoStore | undefined;
  if (!store) return null;
  migrate(ctx, store);
  return store;
}

/**
 * A repository's notes kept in the panel before (user/memory/<folder>.md) go to Gerdr once, line by line (one already
 * there isn't doubled), and the file is kept as <name>.md.migrated. A file whose repository isn't in the settings any
 * more stays: its name alone doesn't say which path it was.
 */
function migrate(ctx: Ctx, store: RepoStore) {
  let files: { path: string; dir?: boolean }[] = [];
  try {
    files = ctx.fs.list(MEMORY);
  } catch {
    return;
  }
  const repos = workflow(ctx).repos;
  for (const f of files) {
    const name = f.path.slice(MEMORY.length + 1).replace(/\.md$/, "");
    if (f.dir || !f.path.endsWith(".md") || name === GENERAL || name === MID || name.includes("/")) continue;
    const repo = repos.find((r) => nameOf(r.path) === name)?.path;
    if (!repo) continue;
    try {
      for (const l of ctx.fs.read(f.path).split("\n")) if (l.trim().startsWith("- ")) store.add(repo, l.trim().slice(2));
      ctx.fs.move(f.path, `${f.path}.migrated`);
    } catch (e: any) {
      ctx.log(`把 ${name} 的记忆挪进 Gerdr 失败：${e?.message ?? e}`);
    }
  }
}

/** A version stamp for text kept in Gerdr (it has no etag): the 记忆 page's "changed elsewhere" check. */
export function stamp(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `r${text.length}.${(h >>> 0).toString(36)}`;
}

/** Where one memory lives — the panel's file (name), or Gerdr's notes of a repository — read and changed alike. */
export function memoryOf(ctx: Ctx, name: string, repo?: string) {
  const store = repo ? repoStore(ctx) : null;
  if (store && repo)
    return {
      file: store.read(repo).path,
      read: () => store.read(repo).text,
      edit: (fn: (text: string) => string) => void store.write(repo, fn(store.read(repo).text).trim()),
      add: (line: string) => store.add(repo, line).added,
    };
  return {
    file: `${ctx.fs.root}/${pathOf(name)}`,
    read: () => readMemory(ctx, name),
    edit: (fn: (text: string) => string) => editMemory(ctx, name, fn),
    add: (line: string) => (addLine(ctx, name, line), true),
  };
}
