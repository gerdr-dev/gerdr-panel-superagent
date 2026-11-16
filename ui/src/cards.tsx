import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Activity, AlarmClock, BookmarkPlus, Check, CircleCheck, CornerUpLeft, Eye, FileText, Hourglass, Link2, MessageSquare, Pencil, Send, SquareTerminal, Undo2, UserPlus, Users } from "lucide-react";
import { DefaultCard, registerCard, type CardProps } from "@gerdr/core";
import { run } from "./lib/gerdr";

// Cards the board's panel tools put in a worker's chat (local/board.ts). Gerdr loads this file at start, so they're drawn
// this way wherever the chat is shown: the board's drawer, or the worker's tab in Code.

type Step = { status: string; handedBack?: string; title?: string; kind?: string; reason?: string };

/**
 * A step or decision the worker put on the board (ask_human): the built-in card while it waits, so it can be answered
 * right there; once it's done or taken back on the board, a one-line record of how it ended instead of a card that
 * still looks open. The board is asked again every 30s while the card is on screen.
 */
/** Also drawn on the secretary's page for a step it showed that is answered now (board.tsx NeedRow). */
export function TaskStep({ card }: CardProps) {
  const id = String(card.ref ?? "");
  // Which board it belongs to: one person can have this panel in several projects, each with its own t4. Not the page's
  // project — this runs in Gerdr's own page. Older cards only carried it in their answer button (choose.project);
  // one with neither isn't asked about at all rather than asked of the wrong board.
  const c = card as { project?: string; choose?: { project?: string } };
  const board = c.project ?? c.choose?.project;
  const [st, setSt] = useState<Step>();
  // Changing an answer already sent: the built-in card again, its pick going to tasks.reanswer (with its few seconds
  // of undo too). The card's own undo only covers the seconds before a pick is sent.
  const [changing, setChanging] = useState<string | false>(false); // the answer it had when the change was opened
  // The new answer arrived (a poll after tasks.reanswer): back to the one-line record, showing it
  useEffect(() => {
    if (changing !== false && st?.handedBack !== changing) setChanging(false);
  }, [st?.handedBack]);
  useEffect(() => {
    if (!id || !board) return;
    let dead = false;
    const get = () => run<Step>("tasks.status", { id }, { project: board }).then((v) => !dead && setSt(v), () => {});
    void get();
    const timer = setInterval(get, 30000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [id, board]);
  const changeable = st?.status === "done" && (st.kind === "choice" || st.kind === "value") && !!card.choose && !!board;
  if (changing && changeable) {
    // A question of several is changed the way it's answered; an older single ask through tasks.reanswer
    const choose = { ...card.choose!, fn: card.choose!.fn === "tasks.answerQuestion" ? card.choose!.fn : "tasks.reanswer", project: board! };
    return (
      <div>
        {/* Its own ref: the first answer's pick (sent) is kept under the card's ref, and would show here as already made */}
        <DefaultCard card={{ ...card, ref: `${id}:change:${changing}`, kicker: `改答案 · ${id} · 现在是「${changing}」`, choose }} />
        <button className="mb-1.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setChanging(false)}>
          不改了
        </button>
      </div>
    );
  }
  if (st?.status === "done" || st?.status === "dropped") {
    const done = st.status === "done";
    return (
      // Done: a green edge; taken back: a grey one, with why — two different ends, not one look
      <div className={`my-1.5 flex items-center gap-2 rounded-lg border border-l-2 bg-card px-3 py-2 text-[12px] text-muted-foreground ${done ? "border-l-ok" : "border-l-muted-foreground/40"}`}>
        {done ? <Check className="size-3.5 shrink-0 text-ok" /> : <Undo2 className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">
          {id} {card.title}
        </span>
        <span className="min-w-0 shrink truncate" title={st.reason}>
          {done ? (st.handedBack ? `已处理：${st.handedBack}` : "已处理") : st.reason ? `已撤回：${st.reason}` : "已撤回"}
        </span>
        {changeable && (
          <button className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground" title="答错了？改成别的，worker 会收到新旧两个答案" onClick={() => setChanging(st.handedBack ?? "")}>
            <Pencil className="size-3" />
            改答案
          </button>
        )}
      </div>
    );
  }
  return <DefaultCard card={card} />;
}

registerCard("task-step", TaskStep);

/** A step / question the worker took back (cancel_human): a quiet line in its chat, with why. */
function TaskTakenBack({ card }: CardProps) {
  return (
    <div className="my-1 flex items-baseline gap-1.5 px-1 text-[12px] text-muted-foreground">
      <Undo2 className="size-3 shrink-0 translate-y-0.5" />
      <span className="min-w-0">
        {card.title}
        {card.body ? `：${card.body}` : ""}
      </span>
    </div>
  );
}

registerCard("task-taken-back", TaskTakenBack);

/** What a worker's tool changed on the board (local/_cards.ts eventCard). */
type Event = { kind?: string; level?: "card" | "line"; kicker?: string; title?: string; body?: string; links?: { label?: string; url: string }[] };

const EVENT_ICON: Record<string, typeof Activity> = {
  reply: Send,
  progress: Activity,
  working: FileText,
  review: Eye,
  done: CircleCheck,
  join: UserPlus,
  tell: Send,
  handBack: CornerUpLeft,
  remember: BookmarkPlus,
};

// The left edge says how much it matters: done green, review yellow (the user's turn), the rest the brand's
const EDGE: Record<string, string> = { done: "border-l-ok", review: "border-l-warn" };
const ICON_TONE: Record<string, string> = { done: "text-ok", review: "text-warn" };

/**
 * Every change a worker's tool made on the board, in its chat too: the user may be reading the chat, not the board, and
 * a folded "called task_update" row said nothing of what changed. Loud as it matters (eventCard's level): a result, a
 * teammate pulled in or a line for the feed is a card; bookkeeping (summary updated, a message to a teammate, a memory
 * kept) is one quiet line. A record, not something waiting: no pulse, no state to poll.
 */
function TaskEvent({ card }: CardProps) {
  const e = card as Event;
  const kind = e.kind ?? "progress";
  const Icon = EVENT_ICON[kind] ?? Activity;
  if (e.level === "line")
    return (
      <div className="my-1 flex items-baseline gap-1.5 px-1 text-[12px] text-muted-foreground">
        <Icon className="size-3 shrink-0 translate-y-0.5" />
        <span className="min-w-0 line-clamp-2">
          <span className="text-foreground/80">{e.kicker}</span>
          {e.title ? `：${e.title}` : ""}
          {e.body ? `（${e.body}）` : ""}
        </span>
      </div>
    );
  return (
    <div className={`my-1.5 rounded-lg border border-l-2 bg-card px-3 py-2 ${EDGE[kind] ?? "border-l-brand"}`}>
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Icon className={`size-3.5 shrink-0 ${ICON_TONE[kind] ?? ""}`} />
        <span>{e.kicker}</span>
      </div>
      {e.title && <p className="mt-1 whitespace-pre-wrap text-[13px]">{e.title}</p>}
      {e.body && <p className="mt-1 whitespace-pre-wrap text-[12px] text-muted-foreground">{e.body}</p>}
      {e.links && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
          {e.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
              <Link2 className="size-3 shrink-0" />
              {l.label || l.url}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

registerCard("task-event", TaskEvent);
// post_progress's cards from before task-event (2026-11-09): kicker and title only, drawn the same
registerCard("task-progress", (p: CardProps) => <TaskEvent {...p} card={{ ...p.card, kind: "progress", level: "card" }} />);

/** One thing that wakes it (local/_waits.ts wakeItem). */
type Wake = { kind: string; text: string; code?: string };
const WAKE_ICON: Record<string, typeof Hourglass> = { reply: MessageSquare, check: SquareTerminal, time: AlarmClock, teammate: Users };

type Wait = { state: "waiting" | "ended" | "gone"; body?: string; wakes?: Wake[]; how?: string; at?: number; woke?: { how: string; at: number }; check?: { at: number; code: number; out: string } };

/**
 * A worker ending its turn to wait on someone / something outside (wait_for, local/waits.ts). Without it the chat just
 * stopped after "I'll wait", and the user couldn't tell whether anything was still going on. While the wait is on: what
 * it waits for and what will wake it, with a pulse; once over, what woke it. The board is asked every 20s.
 */
function TaskWait({ card }: CardProps) {
  // waits: the task's waits it stands for (local/_waits.ts); cards made before those had ids carry since (+ kind "mr")
  const c = card as { project?: string; task?: string; waits?: string[]; since?: number; title?: string; body?: string; wakes?: Wake[]; kind?: string; url?: string };
  const [st, setSt] = useState<Wait>();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!c.project || !c.task || (!c.waits?.length && !c.since)) return;
    let dead = false;
    const get = () => run<Wait>("waits.status", { id: c.task, waits: c.waits, since: c.since, kind: c.kind }, { project: c.project }).then((v) => !dead && setSt(v), () => {});
    void get();
    const timer = setInterval(() => (get(), tick((n) => n + 1)), 20000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [c.project, c.task, c.waits?.join(","), c.since, c.kind]);
  const on = !st || st.state === "waiting";
  // Cards and boards from before wakeItem only have the prose, its parts joined by "；": one row each
  const body = st?.body ?? c.body;
  const wakes: Wake[] = st?.wakes ?? (st?.body ? undefined : c.wakes) ?? (body ? body.split("；").map((text) => ({ kind: text.includes("回来看") ? "time" : "", text })) : []);
  const mins = c.since ? Math.max(0, Math.round((Date.now() - c.since) / 60000)) : 0;
  const waited = mins < 1 ? "刚开始" : mins < 60 ? `等了 ${mins} 分钟` : `等了 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分`;
  if (!on)
    return (
      <div className="my-1.5 flex items-center gap-2 rounded-lg border border-l-2 border-l-ok bg-card px-3 py-2 text-[12px] text-muted-foreground">
        <Check className="size-3.5 shrink-0 text-ok" />
        <span className="min-w-0 flex-1 truncate">等：{c.title}</span>
        <span className="shrink-0">{st?.how ?? "不等了"}{st?.at ? ` · ${new Date(st.at).toTimeString().slice(0, 5)}` : ""}</span>
      </div>
    );
  return (
    <div className="my-1.5 space-y-1 rounded-lg border border-l-2 border-l-brand bg-card px-3 py-2">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-brand" />
        </span>
        <span>在等 · {c.task}</span>
        <span className="ml-auto shrink-0">{waited}</span>
      </div>
      <p className="text-[13px] font-medium">
        {c.url ? (
          <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">
            {c.title}
          </a>
        ) : (
          c.title
        )}
      </p>
      {wakes.length > 0 && (
        <div className="space-y-0.5 text-[12px] text-muted-foreground">
          <p>{wakes.length > 1 ? "哪个先到都会叫醒它：" : "叫醒它："}</p>
          <ul className="space-y-0.5">
            {wakes.map((w, i) => {
              const Icon = WAKE_ICON[w.kind] ?? Hourglass;
              return (
                <li key={i} className="flex items-start gap-1.5">
                  <Icon className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {w.text}
                    {w.code && (
                      <code title={w.code} className="mt-0.5 block truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {w.code}
                      </code>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {st?.check && (
        <p className="line-clamp-2 font-mono text-[11px] text-muted-foreground">
          {new Date(st.check.at).toTimeString().slice(0, 5)} 查：{st.check.out || `exit ${st.check.code}`}
        </p>
      )}
      {st?.woke && (
        <p className="text-[12px] text-muted-foreground">
          上次叫醒：{st.woke.how} · {new Date(st.woke.at).toTimeString().slice(0, 5)}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">它这一轮结束后不占着，等到了会被叫醒接着做；想催它或改主意，直接在下面说。</p>
    </div>
  );
}

registerCard("task-wait", TaskWait);

type Out = { state: "pending" | "sent" | "skipped" | "missing"; text?: string; where?: string; doneAt?: number; edited?: boolean };

/**
 * Words a worker wrote to the people in a chat its task follows, held for the user (local/outbox.ts, 设置 → 回话
 * "review"): 发送 / 不发, the words editable first. Nothing waits on it and the worker isn't told which; once chosen,
 * one line says how it ended. Asked again every 30s while on screen, since the board's card can answer it too.
 */
function TaskOutgoing({ card }: CardProps) {
  const c = card as { ref?: string; project?: string; task?: string; where?: string; text?: string };
  const [st, setSt] = useState<Out>();
  // The words are an input from the start, filled with what the worker wrote: edit them in place, then send
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const get = () => (c.ref && c.project ? run<Out>("outbox.status", { ref: c.ref }, { project: c.project }).then(setSt, () => {}) : Promise.resolve());
  useEffect(() => {
    void get();
    const timer = setInterval(get, 30000);
    return () => clearInterval(timer);
  }, [c.ref, c.project]);
  const text = st?.text ?? c.text ?? "";
  const where = st?.where ?? c.where ?? "";
  const value = draft ?? text;
  const edited = draft != null && draft !== text;
  // Grows with the text, so a long reply is read whole without scrolling inside the box
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value, st?.state]);
  const act = async (fn: "send" | "skip") => {
    setBusy(fn);
    setErr("");
    try {
      await run(`outbox.${fn}`, fn === "send" ? { ref: c.ref, text: value } : { ref: c.ref }, { project: c.project });
      setDraft(null);
      await get();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  };
  if (st && st.state !== "pending") {
    const sent = st.state === "sent";
    return (
      <div className={`my-1.5 rounded-lg border border-l-2 bg-card px-3 py-2 text-[12px] text-muted-foreground ${sent ? "border-l-ok" : "border-l-muted-foreground/40"}`}>
        <div className="flex items-center gap-2">
          {sent ? <Send className="size-3.5 shrink-0 text-ok" /> : <Undo2 className="size-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{st.state === "missing" ? "这条待发送的消息不在了" : `${sent ? (st.edited ? "改过后发给了" : "发给了") : "没发给"} ${where}`}</span>
          {st.doneAt && <span className="shrink-0">{new Date(st.doneAt).toTimeString().slice(0, 5)}</span>}
        </div>
        {st.state !== "missing" && <p className={`mt-1 line-clamp-3 whitespace-pre-wrap ${sent ? "" : "line-through"}`}>{text}</p>}
      </div>
    );
  }
  return (
    <div className="my-1.5 space-y-1.5 rounded-lg border border-l-2 border-l-warn bg-card px-3 py-2">
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <MessageSquare className="size-3.5 shrink-0 text-warn" />
        <span className="min-w-0 truncate">待发送 · 回给 {where}{c.task ? ` · ${c.task}` : ""}</span>
      </div>
      <textarea
        ref={box}
        rows={2}
        className="w-full resize-none overflow-hidden rounded-md border bg-background px-2 py-1.5 text-[13px] leading-relaxed outline-none focus:ring-1 focus:ring-brand"
        value={value}
        disabled={!!busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter sends, like the chat's own box with a modifier; a plain Enter is a new line
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value.trim() && !busy) {
            e.preventDefault();
            void act("send");
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <button className="inline-flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 font-medium text-background disabled:opacity-50" disabled={!!busy || !value.trim()} onClick={() => act("send")}>
          <Send className="size-3" />
          {busy === "send" ? "发送中…" : edited ? "发送改好的" : "发送"}
        </button>
        <button className="rounded-md border px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" disabled={!!busy} onClick={() => act("skip")}>
          不发
        </button>
        {edited && (
          <button className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground" disabled={!!busy} onClick={() => setDraft(null)}>
            <Undo2 className="size-3" />
            恢复原文
          </button>
        )}
        <span className="ml-auto text-muted-foreground/70">⌘↵ 发送</span>
        {err && <span className="w-full text-bad">{err}</span>}
      </div>
    </div>
  );
}

registerCard("task-outgoing", TaskOutgoing);
