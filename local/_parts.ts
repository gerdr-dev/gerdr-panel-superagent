// Where the board's tasks are kept: one file per part.
//
// A part is one agent task plus the human steps it asked for (a human step nobody asked for is a part of its own):
// the unit with exactly one writer. _store.ts reads every part into the one Store the code works on, and writes back
// only the parts a change touched — a change no longer rewrites the whole board, and two runs changing different
// tasks don't make each other start over.
//
// A requirement's activity lives on its root task in the Store, but each line is kept in the part of the member that
// wrote it (`by`), so no part is written by two members. Merged by time when read.

import { DATA } from "./_user";
import type { Activity, Store, Task } from "./_store";

export const DIR = `${DATA}/reqs`;
export const META = `${DATA}/meta.json`;
const OLD = `${DATA}/tasks.json`;
const KEEP_ACTIVITY = 200;

export type PartFile = { id: string; tasks: Task[]; activity: Activity[] };
export type Meta = { next: number; v: number };

/** The file of a part: its id with anything a file name shouldn't have replaced. */
export const pathOf = (key: string) => `${DIR}/${key.replace(/[^\w.-]/g, "_")}.json`;

/** Which part a task is kept in: an agent task is its own, a human step goes with the agent task that asked for it. */
export function partOf(byId: Map<string, Task>, tasks: Task[], t: Task): string {
  if (t.owner !== "human") return t.id;
  const by = t.askedBy ? byId.get(t.askedBy) : tasks.find((x) => x.owner === "agent" && x.blockedBy?.includes(t.id));
  return by && by.id !== t.id && by.owner === "agent" ? by.id : t.id;
}

/** The root a task's activity shows on (reqOf in _store.ts, kept here so the two files don't import each other). */
type RootOf = (s: Store, t: Task) => Task | undefined;

/** The Store as files: part key → file text, and the meta file's text. */
export function split(s: Store): { parts: Record<string, string>; meta: string } {
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  const files = new Map<string, PartFile>();
  const fileOf = (key: string) => {
    let f = files.get(key);
    if (!f) files.set(key, (f = { id: key, tasks: [], activity: [] }));
    return f;
  };
  for (const t of s.tasks) {
    const { activity, bounces, ...kept } = t as Task & { bounces?: number };
    fileOf(partOf(byId, s.tasks, t)).tasks.push(kept as Task);
    for (const a of activity ?? []) {
      const by = a.by ? byId.get(a.by) : undefined;
      fileOf(by ? partOf(byId, s.tasks, by) : t.id).activity.push(a);
    }
  }
  const parts: Record<string, string> = {};
  for (const [k, f] of files) parts[k] = JSON.stringify(f, null, 2) + "\n";
  return { parts, meta: JSON.stringify({ next: s.next, v: s.v ?? 2 } satisfies Meta, null, 2) + "\n" };
}

/** Files back into the Store: tasks side by side, each requirement's activity merged by time onto its root. */
export function join(parts: PartFile[], meta: Meta | null, rootOf: RootOf): Store {
  const s: Store = { next: meta?.next ?? 1, tasks: parts.flatMap((p) => p.tasks), v: meta?.v ?? 2 };
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  const roots = new Set<Task>();
  for (const p of parts) {
    if (!p.activity?.length) continue;
    const owner = byId.get(p.id) ?? p.tasks[0];
    if (!owner) continue;
    const root = rootOf(s, owner) ?? owner;
    root.activity = [...(root.activity ?? []), ...p.activity];
    roots.add(root);
  }
  for (const r of roots) r.activity = r.activity!.sort((a, b) => a.at - b.at).slice(-KEEP_ACTIVITY);
  return s;
}

export type Loaded = { store: Store; files: Record<string, { etag: string; text: string }>; meta?: { etag: string; text: string } };

export function readAll(ctx: Ctx, rootOf: RootOf): Loaded {
  moveOld(ctx);
  const files: Loaded["files"] = {};
  const parts: PartFile[] = [];
  for (const f of ctx.fs.list(DIR)) {
    if (f.dir || !f.path.endsWith(".json")) continue;
    const text = ctx.fs.read(f.path);
    const p = JSON.parse(text) as PartFile;
    parts.push(p);
    files[p.id] = { etag: f.etag, text };
  }
  const mst = ctx.fs.stat(META);
  const mtext = mst ? ctx.fs.read(META) : "";
  return { store: join(parts, mtext ? JSON.parse(mtext) : null, rootOf), files, meta: mst ? { etag: mst.etag, text: mtext } : undefined };
}

/**
 * Writes the parts that changed. Every file is checked first and nothing is written if any moved since it was read
 * (another run wrote in between): the caller runs its change again on the fresh data. Returns false then. The check
 * and the writes aren't one step, but two runs writing the same part in that instant is the only way to lose one.
 */
export function writeChanged(ctx: Ctx, loaded: Loaded, next: { parts: Record<string, string>; meta: string }): boolean | "same" {
  // A part whose tasks all went elsewhere (a step that was its own part, then blocked an agent task and went with it):
  // written empty, or its old copy of them would come back on the next read beside the new one
  const parts = { ...next.parts };
  for (const k of Object.keys(loaded.files)) if (!(k in parts) && loaded.files[k].text !== emptyText(k)) parts[k] = emptyText(k);
  next = { ...next, parts };
  const changed = Object.keys(next.parts).filter((k) => next.parts[k] !== loaded.files[k]?.text);
  const metaChanged = next.meta !== loaded.meta?.text;
  if (!changed.length && !metaChanged) return "same";
  for (const k of changed) if (ctx.fs.stat(pathOf(k))?.etag !== loaded.files[k]?.etag) return false;
  if (metaChanged && ctx.fs.stat(META)?.etag !== loaded.meta?.etag) return false;
  for (const k of changed) {
    const was = loaded.files[k];
    ctx.fs.write(pathOf(k), next.parts[k], was ? { etag: was.etag } : undefined);
  }
  if (metaChanged) ctx.fs.write(META, next.meta, loaded.meta ? { etag: loaded.meta.etag } : undefined);
  return true;
}

const emptyText = (id: string) => JSON.stringify({ id, tasks: [], activity: [] } satisfies PartFile, null, 2) + "\n";

/** Once: the single tasks.json of before becomes part files; it is kept as tasks.json.bak. */
function moveOld(ctx: Ctx) {
  if (!ctx.fs.stat(OLD) || ctx.fs.list(DIR).some((f) => !f.dir)) return;
  // Its activity is on root tasks, as in the Store, so it splits the same way
  const out = split(JSON.parse(ctx.fs.read(OLD)) as Store);
  ctx.fs.mkdir(DIR);
  for (const [k, text] of Object.entries(out.parts)) ctx.fs.write(pathOf(k), text);
  ctx.fs.write(META, out.meta);
  let bak = `${OLD}.bak`;
  for (let i = 2; ctx.fs.stat(bak); i++) bak = `${OLD}.bak${i}`;
  ctx.fs.move(OLD, bak);
}
