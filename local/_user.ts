// This person's folder (Gerdr's `user/`, see its AGENTS.md): everything one person's use of the panel produces or
// decides, never shared — the tasks, the Superagent's log, the triggers they turned on, their edits of the skills.
// It ignores itself, so the panel's repository can't carry anyone's data or settings along. A file under
// user/triggers/, user/schedules/ or user/skills/ replaces the shared one of the same path; Gerdr reads them that way
// (and gives sessions the merged skills), and so does this code.

export const USER = "user";
export const DATA = `${USER}/data`;

/** The personal copy of a shared path: skills/a/b.md → user/skills/a/b.md. */
export function mine(rel: string) {
  return `${USER}/${rel}`;
}

/** The file that counts for this person: their copy if they have one, else the shared one; null when neither. */
export function effective(ctx: Ctx, rel: string): string | null {
  if (ctx.fs.stat(mine(rel))) return mine(rel);
  return ctx.fs.stat(rel) ? rel : null;
}

/**
 * The absolute path of a skill's file as it counts for this person (`my-workflow/references/board.md`), for a message
 * to an agent: "the skill, references/x.md" sends it searching the disk for the file, a path it can just read.
 */
export function skillFile(ctx: Ctx, rel: string): string {
  return `${ctx.fs.root}/${effective(ctx, `skills/${rel}`) ?? `skills/${rel}`}`;
}

/**
 * Every file of a shared folder and of its personal copy, by path inside the folder, the personal one winning:
 * { rel, path (to read), mine (they have their own), shared (the panel has one) }.
 */
export function overlay(ctx: Ctx, dir: string): { rel: string; path: string; mine: boolean; shared: boolean }[] {
  const out = new Map<string, { rel: string; path: string; mine: boolean; shared: boolean }>();
  for (const f of ctx.fs.list(dir)) if (!f.dir) out.set(f.path.slice(dir.length + 1), { rel: f.path.slice(dir.length + 1), path: f.path, mine: false, shared: true });
  const own = mine(dir);
  for (const f of ctx.fs.list(own)) {
    if (f.dir) continue;
    const rel = f.path.slice(own.length + 1);
    out.set(rel, { rel, path: f.path, mine: true, shared: out.has(rel) });
  }
  return [...out.values()];
}

/**
 * Before user/: tasks and the log were in data/, triggers turned on in triggers/inbox-*.json. Moved once, the first
 * time anything reads them; nothing to do afterwards.
 */
export function migrate(ctx: Ctx) {
  if (ctx.fs.stat("data")) {
    for (const f of ctx.fs.list("data")) {
      if (f.dir) continue;
      const to = `${DATA}/${f.path.slice("data/".length)}`;
      if (!ctx.fs.stat(to)) {
        ctx.fs.mkdir(to.slice(0, to.lastIndexOf("/")));
        ctx.fs.move(f.path, to);
      }
    }
    if (!ctx.fs.list("data").some((f) => !f.dir)) ctx.fs.trash("data");
  }
  if (ctx.fs.stat("triggers")) {
    for (const f of ctx.fs.list("triggers")) {
      const name = f.path.split("/").pop() ?? "";
      if (f.dir || !name.startsWith("inbox-")) continue;
      const to = mine(f.path);
      if (!ctx.fs.stat(to)) {
        ctx.fs.mkdir(`${USER}/triggers`);
        ctx.fs.move(f.path, to);
      }
    }
  }
}
