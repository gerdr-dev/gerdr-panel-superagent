import { DATA } from "./_user";

// Before 2026-11-12: the secretary's conversation with the user as the page drew it (DESIGN.md「秘书」). The page is the
// secretary's own chat now; this log is only read once more, copied to a file the secretary can look things up in
// (_main.ts migrateLog). What follows is how it was.
//
// The secretary's conversation with the user, as the user sees it: what they said, the messages
// the secretary sent them (its message tool, board.ts), and the briefings. The same lines as a requirement's feed
// (Activity in _store.ts), so both pages draw them alike. Kept by the panel, not read from the agent's transcript, because the agent
// session behind it is replaced whenever the old one's prompt cache has expired anyway (_main.ts toMain): the page
// shows one conversation across all of them, and a new session starts from the last WINDOW of this log.
//
// Tool calls and the triage of outside messages aren't here: the page draws the triage from the 去向 log
// (superagent.json items), folded to a line.

const LOG = `${DATA}/secretary.json`;
/** Entries kept on disk (what the page can scroll back to). */
const KEEP = 2000;
/** What a new session is given of the conversation: the last 7 days, like a person's memory of last week. */
export const WINDOW = 7 * 24 * 3600_000;
/** And at most this many characters of it (the newest kept): a chatty week mustn't fill the context. */
const WINDOW_CHARS = 30_000;

/** The secretary as a line's `by`: the one speaker on its page that isn't a task. */
export const SECRETARY = "secretary";

/**
 * A line, shaped as a requirement's feed line (Activity): kind user (the user's words, no `by`), message (the
 * secretary to the user, by SECRETARY) or brief (a briefing). id for the page's rows; session: the secretary session
 * it was said in (its face opens it).
 */
export type Entry = {
  id: string;
  at: number;
  kind: "user" | "message" | "brief";
  by?: string;
  text: string;
  files?: { path: string; name?: string; mime?: string }[];
  session?: string;
  /**
   * A worker's own words the secretary's message points at (a result, a plan): its last reply when quoted (`text`;
   * older entries point at a feed line by `at`). The page draws it under the message, as the worker wrote it, with a way into the requirement and to reply. The secretary says why it matters, never
   * the content again in fewer words (the user lost what a long plan said that way, 2026-11-11).
   */
  quote?: { task: string; at: number; text?: string };
  /**
   * The member a question went to from this page: the user's reply to a worker's line (secretary.reply), or what the
   * secretary passed on for them (tasks.message). The page draws that member's answers from its requirement's feed
   * under it, so the answer reaches the page it was asked on.
   */
  follow?: string;
};

type Log = { next: number; entries: Entry[] };

/** A line written before the lines were feed lines ({ who: user | agent, kind: reply / notice / brief }). */
function upgrade(e: any): Entry {
  // Every line not the user's is the secretary's (a few on 2026-11-10 were written with the wrong `by`)
  if (!e.who) return e.kind === "user" ? e : { ...e, by: SECRETARY };
  const { who, kind, ...rest } = e;
  return who === "user" ? { ...rest, kind: "user" } : { ...rest, kind: kind === "brief" ? "brief" : "message", by: SECRETARY };
}

function load(ctx: Ctx): { l: Log; etag?: string } {
  const st = ctx.fs.stat(LOG);
  if (!st) return { l: { next: 1, entries: [] } };
  const l: Log = JSON.parse(ctx.fs.read(LOG));
  l.entries = l.entries.map(upgrade);
  return { l, etag: st.etag };
}

export function entries(ctx: Ctx): Entry[] {
  return load(ctx).l.entries;
}

export function append(ctx: Ctx, e: Omit<Entry, "id" | "at"> & { at?: number }): Entry {
  for (let i = 0; ; i++) {
    const { l, etag } = load(ctx);
    const out: Entry = { id: `m${l.next++}`, at: Date.now(), ...e };
    l.entries.push(out);
    if (l.entries.length > KEEP) l.entries = l.entries.slice(-KEEP);
    try {
      ctx.fs.write(LOG, JSON.stringify(l, null, 2), etag ? { etag } : undefined);
      return out;
    } catch (err) {
      if (i >= 4) throw err;
    }
  }
}

function stamp(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The last `window` ms of the conversation as text (newest WINDOW_CHARS kept, unless `window` is Infinity: all of
 * it); "" when there's none. Since 2026-11-12 only for the one-time copy the secretary can read (_main.ts migrateLog).
 */
export function windowText(ctx: Ctx, window = WINDOW): string {
  const from = Date.now() - window;
  const cap = window === Infinity ? Infinity : WINDOW_CHARS;
  const lines: string[] = [];
  let size = 0;
  for (const e of [...entries(ctx)].reverse()) {
    if (e.at < from) break;
    const who = e.kind === "user" ? (e.follow ? `用户（在秘书页上直接对 ${e.follow} 说）` : "用户") : e.kind === "brief" ? "你（简报）" : e.quote ? `你（附上了 ${e.quote.task} 的原话）` : e.follow ? `你（转给了 ${e.follow}）` : "你";
    const files = e.files?.length ? `\n（附件：${e.files.map((f) => f.path).join("、")}）` : "";
    const line = `[${stamp(e.at)}] ${who}：${e.text}${files}`;
    if (size + line.length > cap) break;
    size += line.length;
    lines.push(line);
  }
  return lines.reverse().join("\n\n");
}
