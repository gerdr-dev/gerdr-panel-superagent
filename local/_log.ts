import { DATA } from "./_user";

// The secretary's conversation with the user, as the user sees it (DESIGN.md「秘书」): what they said, what the
// secretary said back, and the briefings. Kept by the panel, not read from the agent's transcript, because the agent
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

export type Entry = {
  id: string;
  at: number;
  who: "user" | "agent";
  text: string;
  files?: { path: string; name?: string; mime?: string }[];
  /** agent: why it spoke — answering the user, a briefing, or on its own (news about a task). */
  kind?: "reply" | "brief" | "notice";
  /** The agent session it was said in (to open "what was it doing"). */
  session?: string;
};

type Log = { next: number; entries: Entry[] };

function load(ctx: Ctx): { l: Log; etag?: string } {
  const st = ctx.fs.stat(LOG);
  if (!st) return { l: { next: 1, entries: [] } };
  return { l: JSON.parse(ctx.fs.read(LOG)), etag: st.etag };
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

/** The last WINDOW of the conversation as text, for a new session's first message; "" when there's none. */
export function windowText(ctx: Ctx): string {
  const from = Date.now() - WINDOW;
  const lines: string[] = [];
  let size = 0;
  for (const e of [...entries(ctx)].reverse()) {
    if (e.at < from) break;
    const who = e.who === "user" ? "用户" : e.kind === "brief" ? "你（简报）" : "你";
    const files = e.files?.length ? `\n（附件：${e.files.map((f) => f.path).join("、")}）` : "";
    const line = `[${stamp(e.at)}] ${who}：${e.text}${files}`;
    if (size + line.length > WINDOW_CHARS) break;
    size += line.length;
    lines.push(line);
  }
  return lines.reverse().join("\n\n");
}
