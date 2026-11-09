// The user's memory (local/_memory.ts says what it is and where): the remember tool every conversation of the panel
// gets, the 记忆 page's reads and writes, and the text the code puts in a worker's and the router's first message.

import { workflow } from "./_config";
import { addLine, editMemory, GENERAL, MEMORY, nameOf, pathOf, readMemory } from "./_memory";
import { load } from "./_store";
import { eventCard } from "./_cards";

export const tools = {
  remember: {
    description:
      "Write down something the user's later tasks must know about a repository (or about all of them), in the user's own memory for this board: whether it ships through an MR or straight to the target branch, who merges, who approves a release and where, a pitfall they told you about. Every later worker in that repository starts with it. Only what the user said or confirmed, never your own guess. When to remember and how to word it: the my-workflow skill, references/memory.md.",
    input: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact in one sentence, as the user would say it (billing-service 发布要在 maersk 发审批，找张三批). Empty with replaces: forget that line" },
        repo: { type: "string", description: "Absolute path of the repository it is about, or \"general\" when it holds for all of them. Left out: your task's repository" },
        replaces: { type: "string", description: "A few words of the line it corrects (the user changed their mind): that line is replaced rather than a second, contradicting one added" },
      },
      required: ["text"],
    },
  },
};

/** The caller's task's repository, when the caller is one of the board's workers. */
function callerRepo(ctx: Ctx) {
  const who = ctx.caller.session;
  if (!who) return "";
  const t = load(ctx).store.tasks.find((x) => x.session === who || x.sessions?.includes(who));
  return t ? { repo: t.repo ?? "", id: t.id } : "";
}

function today() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function remember(input: { text?: string; repo?: string; replaces?: string }, ctx: Ctx) {
  const text = (input?.text ?? "").replace(/\s+/g, " ").trim();
  const old = (input?.replaces ?? "").trim();
  if (!text && !old) throw new Error("text 是空的：写下要记的事");
  const mine = callerRepo(ctx);
  const repo = (input?.repo ?? "").trim() || (mine ? mine.repo : "");
  if (!repo) throw new Error('说清记在哪个仓库：repo 写仓库的绝对路径，对所有仓库都成立的写 "general"');
  const name = repo === "general" ? GENERAL : nameOf(repo);
  const where = repo === "general" ? "记在所有仓库通用的记忆里" : `记在 ${nameOf(repo)} 的记忆里`;
  const line = text && `${text}（${today()}${mine ? `，${mine.id}` : ""}）`;
  if (!old) {
    if (readMemory(ctx, name).split("\n").some((l) => l.replace(/（[^（）]*）\s*$/, "").replace(/^- /, "").trim() === text)) return { ok: true, note: "已经记着这一条了" };
    addLine(ctx, name, line);
    return { ok: true, file: `${ctx.fs.root}/${pathOf(name)}`, gerdrCard: eventCard(ctx, mine ? mine.id : undefined, "remember", text, { body: where }) };
  }
  let found = 0;
  editMemory(ctx, name, (cur) => {
    found = 0;
    const lines = cur.split("\n").flatMap((l) => {
      if (!l.includes(old)) return [l];
      found++;
      return line ? [`- ${line}`] : [];
    });
    return lines.join("\n");
  });
  if (!found) throw new Error(`「${old}」不在 ${name} 的记忆里：先看看原来那条怎么写的（${ctx.fs.root}/${pathOf(name)}）`);
  const gerdrCard = eventCard(ctx, mine ? mine.id : undefined, "remember", text || `删掉：${old}`, { body: text ? `${where}，换掉了「${old}」` : where });
  if (found > 1) return { ok: true, gerdrCard, note: `「${old}」对上了 ${found} 行，都换掉了：去文件里看一眼对不对（${ctx.fs.root}/${pathOf(name)}）` };
  return { ok: true, file: `${ctx.fs.root}/${pathOf(name)}`, gerdrCard };
}

// ---- the 记忆 page ----

export type Entry = { name: string; label: string; repo?: string; note?: string; text: string; etag?: string };

/** Every memory file, plus every repository in the settings that has none yet: the general one first, then by name. */
export function list(input: unknown, ctx: Ctx): Entry[] {
  const out = new Map<string, Entry>();
  const of = (name: string): Pick<Entry, "text" | "etag"> => {
    const st = ctx.fs.stat(pathOf(name));
    return st ? { text: ctx.fs.read(pathOf(name)), etag: st.etag } : { text: "" };
  };
  out.set(GENERAL, { name: GENERAL, label: "通用", ...of(GENERAL) });
  for (const r of workflow(ctx).repos) {
    const name = nameOf(r.path);
    if (!out.has(name)) out.set(name, { name, label: name, repo: r.path, note: r.note, ...of(name) });
  }
  for (const f of ctx.fs.list(MEMORY)) {
    const name = f.path.slice(MEMORY.length + 1).replace(/\.md$/, "");
    if (f.dir || !f.path.endsWith(".md") || name.includes("/") || out.has(name)) continue;
    out.set(name, { name, label: name, ...of(name) });
  }
  const [general, ...rest] = [...out.values()];
  return [general, ...rest.sort((a, b) => a.name.localeCompare(b.name))];
}

/** { name, text, etag? } → the new etag; an empty text removes the file. */
export function save(input: { name: string; text: string; etag?: string }, ctx: Ctx) {
  const p = pathOf(input.name);
  const st = ctx.fs.stat(p);
  if (st && input.etag && st.etag !== input.etag) throw new Error("这份记忆在别处被改过了（可能是 agent 刚记了一条）：重新打开再改");
  if (!input.text.trim()) {
    if (st) ctx.fs.trash(p);
    return { etag: undefined };
  }
  return ctx.fs.write(p, input.text.replace(/\n*$/, "\n"), st ? { etag: st.etag } : undefined);
}

// ---- what the code tells the agents ----

/**
 * For a worker's first message: what is remembered about its repository and about all of them. "" when nothing is.
 * In the message rather than "go read the file": a worker that has to remember to look won't, every time.
 */
export function forWorker(ctx: Ctx, repo: string) {
  const name = nameOf(repo);
  const own = readMemory(ctx, name);
  const all = readMemory(ctx, GENERAL);
  if (!own && !all) return "";
  return (
    `\nThe user's memory for this board — what earlier tasks learned from them; follow it like their rules, and correct it ` +
    `with the remember tool when they say otherwise (when: their my-workflow skill, references/memory.md):\n` +
    (own ? `\n### ${name}\n${own}\n` : "") +
    (all ? `\n### 所有仓库\n${all}\n` : "")
  );
}

/**
 * For the router's brief: only what holds everywhere (where kinds of work go, who is who). A repository's own facts
 * are for its workers; in the brief they would restart the router at every line learned (it's re-sent when it changes).
 */
export function forRouter(ctx: Ctx) {
  const all = readMemory(ctx, GENERAL);
  return all ? `## 用户的记忆（所有仓库通用，之前的任务从用户那里学到的）\n${all}` : "";
}
