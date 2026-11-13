// Archive: requirements finished long ago leave user/data/reqs/ for user/data/archive/, so every run (tasks.list each
// minute, every tool call) stops reading them and asking Gerdr about their sessions. Nothing is deleted. A helper file
// (leading _): nothing here is callable from a page.
//
// The unit is a requirement (a card): its root's part and every member's, with the human steps they asked for — all of
// them ended, the last one longer ago than settings.archiveDays, and nothing still going pointing at any of them. They
// come back (moved into reqs/ again) when something asks for one of them by id (_store.ts update / find), when the
// user opens one from the board's archive list, or when one of their workers is running again (the user typed in its
// chat: tasks.list then reopens the task as it would any done one). DESIGN.md「归档」.

import { DATA } from "./_user";
import { DIR, partOf, pathOf, type Loaded } from "./_parts";
import type { Store, Task } from "./_store";

export const ARCHIVE = `${DATA}/archive`;
const INDEX = `${ARCHIVE}/index.json`;
/** Session id → archived requirement: small, so every run made by a conversation can check it (byCaller). */
const SESSIONS = `${ARCHIVE}/sessions.json`;
/** How often tasks.list looks for requirements to archive. */
const EVERY = 3600_000;

/** What the index keeps of an archived task: enough to list it, search it and tell when it's wanted again. */
export type ArchivedTask = { id: string; title: string; owner: Task["owner"]; status: Task["status"]; createdAt: number; doneAt?: number; summary?: string; repo?: string; sessions?: string[] };
export type Group = { root: string; parts: string[]; at: number; tasks: ArchivedTask[] };
type Index = { checkedAt?: number; groups: Record<string, Group> };

const archivedPath = (key: string) => pathOf(key).replace(DIR, ARCHIVE);

function readIndex(ctx: Ctx): { index: Index; etag?: string } {
  const st = ctx.fs.stat(INDEX);
  if (!st) return { index: { groups: {} } };
  try {
    const raw = JSON.parse(ctx.fs.read(INDEX));
    return { index: { checkedAt: raw.checkedAt, groups: raw.groups ?? {} }, etag: st.etag };
  } catch {
    return { index: { groups: {} }, etag: st.etag };
  }
}

function writeIndex(ctx: Ctx, index: Index) {
  ctx.fs.write(INDEX, JSON.stringify(index, null, 2) + "\n");
  const sessions: Record<string, string> = {};
  for (const g of Object.values(index.groups)) for (const t of g.tasks) for (const id of t.sessions ?? []) sessions[id] = g.root;
  ctx.fs.write(SESSIONS, JSON.stringify(sessions) + "\n");
}

/**
 * A run made by one of an archived task's conversations (its worker calling a panel tool after the user wrote to it):
 * that requirement comes back first, so the worker finds its task. Called by load in _store.ts.
 */
export function byCaller(ctx: Ctx) {
  const who = ctx.caller?.session;
  if (!who || !ctx.fs.stat(SESSIONS)) return;
  let root: string | undefined;
  try {
    root = JSON.parse(ctx.fs.read(SESSIONS))[who];
  } catch {
    return;
  }
  if (root) unarchive(ctx, root);
}

const ended = (t: Task) => t.status === "done" || t.status === "dropped";

/**
 * Moves the requirements finished more than `days` days ago into the archive; at most once an hour. `read` reads the
 * board (load in _store.ts; only called when it's time), `rootOf` is its reqOf. Returns how many tasks went.
 */
export function archiveOld(ctx: Ctx, read: () => Loaded, days: number, rootOf: (s: Store, t: Task) => Task | undefined): number {
  if (!(days > 0)) return 0;
  const { index } = readIndex(ctx);
  const now = Date.now();
  if (index.checkedAt && now - index.checkedAt < EVERY) return 0;
  index.checkedAt = now;
  const loaded = read();
  const s = loaded.store;
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  // Requirement root → the parts it's kept in (the same split _parts.ts writes)
  const groups = new Map<string, { parts: Set<string>; tasks: Task[] }>();
  for (const t of s.tasks) {
    const root = rootOf(s, t) ?? t;
    let g = groups.get(root.id);
    if (!g) groups.set(root.id, (g = { parts: new Set(), tasks: [] }));
    g.parts.add(partOf(byId, s.tasks, t));
    g.tasks.push(t);
  }
  // Two requirements sharing a part (a step one asked and the other is blocked by) go together or not at all
  const partOwners = new Map<string, number>();
  for (const g of groups.values()) for (const p of g.parts) partOwners.set(p, (partOwners.get(p) ?? 0) + 1);
  // Everything still going, as text: a group whose id is quoted in it (blockedBy, from, a wait's item…) stays
  const live = s.tasks.filter((t) => !ended(t)).map((t) => JSON.stringify(t)).join("\n");
  const cutoff = now - days * 86400_000;
  let moved = 0;
  for (const [root, g] of groups) {
    if (!g.tasks.every(ended)) continue;
    if (Math.max(...g.tasks.map((t) => t.doneAt ?? t.updatedAt)) > cutoff) continue;
    if ([...g.parts].some((p) => partOwners.get(p)! > 1 || !loaded.files[p])) continue;
    if (g.tasks.some((t) => live.includes(`"${t.id}"`))) continue;
    // Changed since it was read (another run wrote it in between): left for the next look
    if ([...g.parts].some((p) => ctx.fs.stat(pathOf(p))?.etag !== loaded.files[p].etag)) continue;
    for (const p of g.parts) {
      const to = archivedPath(p);
      if (ctx.fs.stat(to)) ctx.fs.trash(to);
      ctx.fs.move(pathOf(p), to);
    }
    index.groups[root] = {
      root,
      parts: [...g.parts],
      at: now,
      tasks: g.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        owner: t.owner,
        status: t.status,
        createdAt: t.createdAt,
        doneAt: t.doneAt,
        summary: t.summary ? t.summary.slice(0, 300) : undefined,
        repo: t.repo,
        sessions: t.sessions?.length ? t.sessions : t.session ? [t.session] : undefined,
      })),
    };
    moved += g.tasks.length;
  }
  writeIndex(ctx, index);
  if (moved) ctx.log(`归档了 ${moved} 个完成超过 ${days} 天的任务`);
  return moved;
}

/** The archived requirement holding task `id` (or its root), if any. */
function groupOf(index: Index, id: string): Group | undefined {
  return index.groups[id] ?? Object.values(index.groups).find((g) => g.tasks.some((t) => t.id === id));
}

/** Brings the requirement holding task `id` back onto the board. False when it isn't archived. */
export function unarchive(ctx: Ctx, id: string): boolean {
  const { index } = readIndex(ctx);
  const g = groupOf(index, id);
  if (!g) return false;
  for (const p of g.parts) {
    const from = archivedPath(p);
    if (!ctx.fs.stat(from)) continue;
    // A part written meanwhile under the same name (shouldn't happen: ids aren't reused) keeps the newer one
    if (ctx.fs.stat(pathOf(p))) {
      ctx.fs.trash(from);
      continue;
    }
    ctx.fs.move(from, pathOf(p));
  }
  delete index.groups[g.root];
  writeIndex(ctx, index);
  ctx.log(`${g.root} 从归档里拿回来了`);
  return true;
}

/**
 * Archived requirements one of whose workers is running again since it was archived (the user wrote in its chat):
 * back on the board, where tasks.list reopens the task. `sessions` is ctx.sessions.list().
 */
export function revive(ctx: Ctx, sessions: { id: string; status: string; turnStartedAt?: number }[]) {
  const { index } = readIndex(ctx);
  const groups = Object.values(index.groups);
  if (!groups.length) return;
  const running = new Map(sessions.filter((x) => x.status === "running" || x.status === "waiting").map((x) => [x.id, x]));
  for (const g of groups) {
    const back = g.tasks.some((t) => t.sessions?.some((id) => (running.get(id)?.turnStartedAt ?? Infinity) > g.at));
    if (back) unarchive(ctx, g.root);
  }
}

/** Every archived requirement, newest first. */
export function archived(ctx: Ctx): Group[] {
  return Object.values(readIndex(ctx).index.groups).sort((a, b) => latest(b) - latest(a));
}

export const latest = (g: Group) => Math.max(...g.tasks.map((t) => t.doneAt ?? t.createdAt));

/** How many tasks are archived. */
export function archivedCount(ctx: Ctx): number {
  return Object.values(readIndex(ctx).index.groups).reduce((n, g) => n + g.tasks.length, 0);
}
