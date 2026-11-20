// The user's memory (local/_memory.ts says what it is and where): the remember tool every conversation of the panel
// gets, the 记忆 page's reads and writes, and the text the code puts in a worker's and the router's first message.

import { workflow } from "./_config";
import { addLine, editMemory, GENERAL, MEMORY, MID, nameOf, pathOf, readMemory } from "./_memory";
import { load } from "./_store";
import { skillFile } from "./_user";
import { eventCard } from "./_cards";

export const tools = {
  remember: {
    description:
      "Write down something the user's later tasks must know about a repository (or about all of them), in the user's own memory for this board: whether it ships through an MR or straight to the target branch, who merges, who approves a release and where, a pitfall they told you about. Every later worker in that repository starts with it. Only what the user said or confirmed, never your own guess. When to remember and how to word it: the superagent-panel skill, references/memory.md.",
    input: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact in one sentence, as the user would say it (billing-service 发布要在发布平台发审批，找张三批). Empty with replaces: forget that line" },
        repo: { type: "string", description: "Absolute path of the repository it is about, or \"general\" when it holds for all of them. Left out: your task's repository" },
        replaces: { type: "string", description: "A few words of the line it corrects (the user changed their mind): that line is replaced rather than a second, contradicting one added" },
      },
      required: ["text"],
    },
  },
  note: {
    description:
      "Write down, change or delete a line of the user's mid-term memory: what is going on right now and who it involves, for any agent of this board to look up later (memory.mid) when a message or a person needs connecting to work. E.g. who a task is waiting on and for what, a colleague the user asked something on a task's behalf, what someone is working on with the user lately, news on something under way. Your own observations count (unlike remember); delete the line once it's settled. When to write one and how to word it: the superagent-panel skill, references/mid-memory.md.",
    input: {
      type: "object",
      properties: {
        text: { type: "string", description: "One sentence, the person or the matter first (老王：今天会把 X 服务发到 prod，发了 t12 要让提问的同事复测). Empty with replaces: delete that line" },
        task: { type: "string", description: "The task it belongs to (tN), if any. Left out: your own task when you are a worker; none for the secretary" },
        until: { type: "string", description: "A date (YYYY-MM-DD) after which it is probably stale and should be looked at again; leave out when it ends with its task" },
        replaces: { type: "string", description: "A few words of the line it updates or deletes: that line is replaced rather than a second one added" },
      },
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

/** Who is calling, for the line's note: the task when it's a worker, 秘书 for the secretary, "" otherwise. */
function callerName(ctx: Ctx) {
  const mine = callerRepo(ctx);
  if (mine) return mine.id;
  const id = ctx.caller.session;
  return id && (ctx.sessions.get(id) as any)?.tags?.superagent === "main" ? "秘书" : "";
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

/**
 * The note tool (and `gerdr panel run memory.note`): { text, task?, until?, replaces? }. A line of _mid.md reads
 * "- text（11-16 · t134 · 到 2026-11-20 · 秘书）": when, the task, until, who wrote it — the parts the list annotates.
 */
export function note(input: { text?: string; task?: string; until?: string; replaces?: string }, ctx: Ctx) {
  const text = (input?.text ?? "").replace(/\s+/g, " ").trim();
  const old = (input?.replaces ?? "").trim();
  if (!text && !old) throw new Error("text 是空的：写下要记的事；要删一条就只给 replaces");
  const until = (input?.until ?? "").trim();
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error(`until 写成 YYYY-MM-DD，不是「${until}」`);
  const mine = callerRepo(ctx);
  const task = (input?.task ?? "").trim() || (mine ? mine.id : "");
  if (task && !/^t\d+$/.test(task)) throw new Error(`task 是任务编号（tN），不是「${task}」`);
  const by = callerName(ctx);
  const tags = [today().slice(5), task, until && `到 ${until}`, by && by !== task ? by : ""].filter(Boolean).join(" · ");
  const line = text && `${text}（${tags}）`;
  const card = (body: string) => eventCard(ctx, mine ? mine.id : undefined, "remember", text || `删掉：${old}`, { body });
  if (!old) {
    addLine(ctx, MID, line);
    return { ok: true, gerdrCard: card("记在中期记忆里") };
  }
  let found = 0;
  editMemory(ctx, MID, (cur) => {
    found = 0;
    return cur
      .split("\n")
      .flatMap((l) => {
        if (!l.includes(old)) return [l];
        found++;
        return line ? [`- ${line}`] : [];
      })
      .join("\n");
  });
  if (!found) throw new Error(`「${old}」不在中期记忆里：先 gerdr panel run memory.mid 看看原来那条怎么写的`);
  return { ok: true, gerdrCard: card(text ? `中期记忆：换掉了「${old}」` : "从中期记忆里删掉了"), ...(found > 1 ? { note: `「${old}」对上了 ${found} 行，都改了` } : {}) };
}

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${Math.max(m, 0)} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};
const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return [...t].length > n ? [...t].slice(0, n).join("") + "…" : t;
};

/**
 * The mid-term memory lines, each with what has become of its task and whether its date passed — facts the reader
 * judges by, nothing removed here. stale: only the lines that look settled or stale.
 */
export function midLines(ctx: Ctx, stale = false) {
  const tasks = load(ctx).store.tasks;
  const day = today();
  const out: string[] = [];
  for (const l of readMemory(ctx, MID).split("\n")) {
    if (!l.trim()) continue;
    const tail = l.match(/（([^（）]*)）\s*$/)?.[1] ?? "";
    const marks: string[] = [];
    const id = tail.match(/\bt\d+\b/)?.[0];
    if (id) {
      const t = tasks.find((x) => x.id === id);
      if (!t) marks.push(`${id} 已归档`);
      else if (t.status === "done" || t.status === "dropped") marks.push(`${id} ${t.status === "done" ? "已完成" : "已放弃"}`);
    }
    const until = tail.match(/到 (\d{4}-\d{2}-\d{2})/)?.[1];
    if (until && until < day) marks.push("已过期");
    if (stale && !marks.length) continue;
    out.push(marks.length ? `${l}【${marks.join("，")}】` : l);
  }
  return out;
}

/**
 * Mid-term memory for an agent to look things up in: the lines agents wrote, then what every open task waits on
 * outside the board (wait_for, in the worker's words) — the same kind of fact, kept by the board. { q?: keep only the
 * lines with one of these words (space-separated) }. The reader connects things; the code only lists.
 */
export function mid(input: { q?: string } | null, ctx: Ctx) {
  const words = (input?.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const keep = (s: string) => !words.length || words.some((w) => s.toLowerCase().includes(w));
  const notes = midLines(ctx).filter(keep);
  const waits: string[] = [];
  for (const t of load(ctx).store.tasks as any[]) {
    if (t.status === "done" || t.status === "dropped") continue;
    const ws = (t.waits ?? []).filter((w: any) => !w.end && !w.user && ["reply", "check", "time", "teammate"].includes(w.kind));
    if (!ws.length) continue;
    // One wait_for gives several waits sharing `what` (one per thing that wakes it): said once
    const whats = [...new Set(ws.map((w: any) => w.what))];
    const wake = ws
      .map((w: any) =>
        w.kind === "reply"
          ? `${w.where || `${w.on?.source} ${w.on?.key}`} 上有新消息`
          : w.kind === "check"
            ? `检查命令${w.check?.last ? `（上次：${cut(w.check.last.out || `exit ${w.check.last.code}`, 60)}）` : ""}`
            : w.kind === "teammate"
              ? `${w.where ?? w.item} 回话`
              : null,
      )
      .filter(Boolean);
    const line =
      `- ${t.id}「${t.title}」${ago(Math.min(...ws.map((w: any) => w.since)))}起在等：${whats.join("；")}` +
      (wake.length ? `\n    叫醒它的：${wake.join("、")}` : "") +
      (t.summary ? `\n    它最后说：${cut(t.summary, 160)}` : "");
    if (keep(line)) waits.push(line);
  }
  return [
    `## 中期记忆（agent 记下的，${notes.length} 条）\n${notes.join("\n") || "无"}`,
    `## 任务在等外面的（${waits.length}）\n${waits.join("\n") || "无"}`,
  ].join("\n\n");
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
  out.set(MID, { name: MID, label: "中期", ...of(MID) });
  for (const r of workflow(ctx).repos) {
    const name = nameOf(r.path);
    if (!out.has(name)) out.set(name, { name, label: name, repo: r.path, note: r.note, ...of(name) });
  }
  for (const f of ctx.fs.list(MEMORY)) {
    const name = f.path.slice(MEMORY.length + 1).replace(/\.md$/, "");
    if (f.dir || !f.path.endsWith(".md") || name.includes("/") || out.has(name)) continue;
    out.set(name, { name, label: name, ...of(name) });
  }
  const [general, midterm, ...rest] = [...out.values()];
  return [general, midterm, ...rest.sort((a, b) => a.name.localeCompare(b.name))];
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
    `with the remember tool when they say otherwise (when: their superagent-panel skill, ${skillFile(ctx, "superagent-panel/references/memory.md")}):\n` +
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
