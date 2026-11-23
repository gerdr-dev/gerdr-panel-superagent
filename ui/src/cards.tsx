import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, Activity, AlarmClock, BookmarkPlus, Check, CircleCheck, CornerUpLeft, Eye, FileText, Hourglass, Link2, MessageSquare, Pencil, Send, SquareTerminal, Undo2, UserPlus, Users } from "lucide-react";
import { DefaultCard, registerCard, type CardProps } from "@gerdr/core";
import { run } from "./lib/gerdr";
import { boardFresh, cardState, onCardStates } from "./lib/cardstates";

// Cards the board's panel tools put in a worker's chat (local/board.ts). Gerdr loads this file at start, so they're drawn
// this way wherever the chat is shown: the board's drawer, or the worker's tab in Code.

type Step = { status: string; handedBack?: string; title?: string; kind?: string; reason?: string };

// Where a card stands, without asking: the board's last tasks.list carries every card's state (lib/cardstates.ts),
// so a card in a chat opened from the board draws its real state at once. Before this each card asked on mount and
// drew "still open" until the answer came, then collapsed — a flash on every switch of task (2026-11-19). A card the
// board doesn't know (the chat opened in Code before the board, a task archived) asks itself, starting from the last
// answer it got: in memory for this page, and the final ones (nothing changes them any more) in localStorage.
const seen = new Map<string, unknown>();
const KEPT = "superagent.cardStatus";
const KEPT_MAX = 500;
function kept(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(KEPT) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function keep(key: string, v: unknown) {
  try {
    const all = kept();
    delete all[key]; // re-added last, so the oldest go first when trimming
    all[key] = v;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - KEPT_MAX))) delete all[k];
    localStorage.setItem(KEPT, JSON.stringify(all));
  } catch {}
}
function known<T>(project: string, key: string, final: (v: T) => boolean): T | undefined {
  const k = `${project}\n${key}`;
  let mine = seen.get(k) as T | undefined;
  if (mine === undefined) {
    mine = kept()[k] as T | undefined;
    if (mine !== undefined) seen.set(k, mine);
  }
  return newer(mine, cardState<T>(project, key), final);
}

/**
 * Which of two answers about one card to draw: `next`, unless `cur` is final and `next` isn't. A final state can't
 * change any more, so a pending one arriving after it is stale: the board's tasks.list sent before the user clicked
 * 不发, answered after the card's own outbox.status. Drawing it flipped the card back to 待发送 until the board's next
 * poll (2026-11-20).
 */
function newer<T>(cur: T | undefined, next: T | undefined, final: (v: T) => boolean): T | undefined {
  if (next === undefined) return cur;
  if (cur !== undefined && final(cur) && !final(next)) return cur;
  return next;
}

/**
 * A card's status: what the board knows, else asked with `ask` now and every `every` ms while on screen (skipped while
 * the board is loaded and knows the card). `key` as local/_cardstate.ts cardStates names it; project or key empty:
 * nothing to ask. `final`: a status that can't change any more. → the status, and a function asking again now.
 */
function useCardStatus<T>(project: string | undefined, key: string | null, ask: () => Promise<T>, final: (v: T) => boolean, every: number): [T | undefined, () => Promise<void>] {
  const p = project && key ? project : "";
  const [st, setSt] = useState<T | undefined>(() => (p ? known<T>(p, key!, final) : undefined));
  const finalRef = useRef(final);
  finalRef.current = final;
  const settle = (v: T | undefined) => setSt((cur) => newer(cur, v, finalRef.current));
  const askRef = useRef(ask);
  askRef.current = ask;
  const alive = useRef(true);
  const get = () => {
    if (!p) return Promise.resolve();
    return askRef.current().then(
      (v) => {
        const k = `${p}\n${key}`;
        seen.set(k, newer(seen.get(k) as T | undefined, v, finalRef.current));
        if (finalRef.current(v)) keep(k, v);
        if (alive.current) settle(v);
      },
      () => {},
    );
  };
  useEffect(() => {
    alive.current = true;
    if (!p) return;
    setSt(known<T>(p, key!, finalRef.current));
    // The board answered for it (its poll runs every few seconds while it's loaded): nothing to ask
    const byBoard = () => boardFresh(p, every * 2) && cardState(p, key!) !== undefined;
    if (!byBoard()) void get();
    const timer = setInterval(() => !byBoard() && get(), every);
    const off = onCardStates(() => {
      const v = cardState<T>(p, key!);
      if (v !== undefined && alive.current) settle(v);
    });
    return () => {
      alive.current = false;
      clearInterval(timer);
      off();
    };
  }, [p, key]);
  return [st, get];
}

/**
 * A step or decision the worker asked the user for (ask_human; an ask on its task, ref a5 or a5#2 — a human task's old
 * id, t206, on cards drawn before 2026-11-19): the built-in card while it waits, so it can be answered right there;
 * once it's done or taken back, the same card settled (green with the answer, or grey), keeping its height. Its state
 * comes from the board's list, else it asks every 30s while on screen.
 */
export function TaskStep({ card }: CardProps) {
  const id = String(card.ref ?? "");
  // Which board it belongs to: one person can have this panel in several projects, each with its own a4. Not the page's
  // project — this runs in Gerdr's own page. Older cards only carried it in their answer button (choose.project);
  // one with neither isn't asked about at all rather than asked of the wrong board.
  const c = card as { project?: string; choose?: { project?: string } };
  const board = c.project ?? c.choose?.project;
  const [st, refresh] = useCardStatus<Step>(board, id ? `step:${id}` : null, () => run<Step>("tasks.status", { id }, { project: board }), (v) => v.status === "done" || v.status === "dropped", 30000);
  // Changing an answer already sent: the built-in card again, its pick going to tasks.reanswer (with its few seconds
  // of undo too). The card's own undo only covers the seconds before a pick is sent.
  const [changing, setChanging] = useState<string | false>(false); // the answer it had when the change was opened
  // The new answer arrived (a poll after tasks.reanswer): back to the settled card, showing it
  useEffect(() => {
    if (changing !== false && st?.handedBack !== changing) setChanging(false);
  }, [st?.handedBack]);
  // The secretary's own questions (sN, answered through secretary.answer) aren't changed here: it already acted on the answer
  const changeable = st?.status === "done" && (st.kind === "choice" || st.kind === "value") && !!card.choose && !!board && card.choose.fn !== "secretary.answer";
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
    // The whole card, settled: the answer picked and green, or grey when taken back — never a one-line record instead,
    // whose change of height moved the chat being read (2026-11-19)
    return (
      <DefaultCard
        card={card}
        done={{
          value: done ? st.handedBack : undefined,
          dropped: !done,
          note: done ? "已处理" : st.reason?.startsWith("你") ? st.reason : st.reason ? `已撤回：${st.reason}` : "已撤回",
          action: changeable && (
            <button className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground" title="答错了？改成别的，worker 会收到新旧两个答案" onClick={() => setChanging(st.handedBack ?? "")}>
              <Pencil className="size-3" />
              改答案
            </button>
          ),
        }}
      />
    );
  }
  // Still open: an ✕ in its corner ignores it (tasks.ignore, 2026-11-19) — mostly a question gone moot that the agent
  // never took back. Nobody is woken; the agent hears at the start of its next turn
  return (
    <div className="relative">
      <DefaultCard card={card} />
      {board && st?.status === "todo" && <IgnoreButton id={id} board={board} onDone={refresh} />}
    </div>
  );
}

/** The ✕ on an open question card: greyed while it goes, the card settling (grey, 你忽略了) once its state comes back. */
function IgnoreButton({ id, board, onDone }: { id: string; board: string; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      title="忽略：不答了（多半已经过时），它下一轮开头会知道"
      aria-label="忽略"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        run("tasks.ignore", { id }, { project: board }).then(onDone, () => setBusy(false));
      }}
      className="absolute top-5 right-2.5 flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
    >
      <X className="size-3.5" />
    </button>
  );
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
 * it waits for and what will wake it, with a pulse; once over, the same card green with how it ended. The board is asked every 20s.
 */
function TaskWait({ card }: CardProps) {
  // waits: the task's waits it stands for (local/_waits.ts); cards made before those had ids carry since (+ kind "mr")
  const c = card as { project?: string; task?: string; waits?: string[]; since?: number; title?: string; body?: string; wakes?: Wake[]; kind?: string; url?: string };
  // Keyed by its since: one wait_for's waits share it (local/_cardstate.ts); every card has it, old ones too
  const [st] = useCardStatus<Wait>(
    c.project,
    c.task && c.since ? `wait:${c.task}:${c.since}` : null,
    () => run<Wait>("waits.status", { id: c.task, waits: c.waits, since: c.since, kind: c.kind }, { project: c.project }),
    (v) => v.state !== "waiting",
    20000,
  );
  // Redrawn every 20s for "等了 n 分钟", even when the status didn't change
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 20000);
    return () => clearInterval(timer);
  }, []);
  const on = !st || st.state === "waiting";
  // Cards and boards from before wakeItem only have the prose, its parts joined by "；": one row each
  const body = st?.body ?? c.body;
  const wakes: Wake[] = st?.wakes ?? (st?.body ? undefined : c.wakes) ?? (body ? body.split("；").map((text) => ({ kind: text.includes("回来看") ? "time" : "", text })) : []);
  const mins = c.since ? Math.max(0, Math.round((Date.now() - c.since) / 60000)) : 0;
  const waited = mins < 1 ? "刚开始" : mins < 60 ? `等了 ${mins} 分钟` : `等了 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分`;
  return (
    // Over: the same card, green, its last line saying how — not a one-line record, whose change of height moved the
    // chat being read (2026-11-19)
    <div className={`my-1.5 space-y-1 rounded-lg border border-l-2 bg-card px-3 py-2 ${on ? "border-l-brand" : "border-l-ok"}`}>
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        {on ? (
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-brand" />
          </span>
        ) : (
          <Check className="size-3.5 shrink-0 text-ok" />
        )}
        <span>
          {on ? "在等" : "等完了"} · {c.task}
        </span>
        <span className="ml-auto shrink-0">{on ? waited : st?.at ? new Date(st.at).toTimeString().slice(0, 5) : ""}</span>
      </div>
      <p className={`text-[13px] font-medium ${on ? "" : "text-muted-foreground"}`}>
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
      {on ? (
        <p className="text-[11px] text-muted-foreground">它这一轮结束后不占着，等到了会被叫醒接着做；想催它或改主意，直接在下面说。</p>
      ) : (
        // `how` can be a whole MR condition (onState's title): one line, cut, so the height stays
        <p className="truncate text-[11px] text-ok" title={st?.how}>
          {st?.how ?? "不等了"}
        </p>
      )}
    </div>
  );
}

registerCard("task-wait", TaskWait);

type Out = { state: "pending" | "sent" | "skipped" | "withdrawn" | "missing"; text?: string; where?: string; doneAt?: number; edited?: boolean; reason?: string };

/**
 * Words a worker wrote to the people in a chat its task follows, held for the user (local/outbox.ts, 设置 → 回话
 * "review"): 发送 / 不发, the words editable first. Nothing waits on it and the worker isn't told which; once chosen,
 * the same card, read-only, coloured by how it ended. Asked again every 30s while on screen, since the board's card
 * can answer it too.
 */
function TaskOutgoing({ card }: CardProps) {
  const c = card as { ref?: string; project?: string; task?: string; where?: string; text?: string };
  const [st, get] = useCardStatus<Out>(
    c.project,
    c.ref ? `out:${c.ref}` : null,
    () => run<Out>("outbox.status", { ref: c.ref }, { project: c.project }),
    (v) => v.state !== "pending",
    30000,
  );
  // The words are an input from the start, filled with what the worker wrote: edit them in place, then send
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
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
  // Sent, let go or gone: the same card, its colour and last row changed. It used to collapse into one line, and the
  // chat moved under the reader every time it did (2026-11-19)
  const over = !!st && st.state !== "pending";
  const sent = st?.state === "sent";
  const edge = !over ? "border-l-warn" : sent ? "border-l-ok" : "border-l-muted-foreground/40";
  const head = !over
    ? "待发送"
    : st!.state === "missing"
      ? "这条待发送的消息不在了"
      : sent
        ? st!.edited
          ? "改过后发了"
          : "已发送"
        : st!.state === "withdrawn"
          ? "worker 撤回了"
          : "没发";
  return (
    <div className={`my-1.5 space-y-1.5 rounded-lg border border-l-2 bg-card px-3 py-2 ${edge}`}>
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {!over ? <MessageSquare className="size-3.5 shrink-0 text-warn" /> : sent ? <Send className="size-3.5 shrink-0 text-ok" /> : <Undo2 className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">
          {head} · 回给 {where}
          {c.task ? ` · ${c.task}` : ""}
        </span>
      </div>
      {/* The box stays a textarea once it's over (read-only), so its size is the same as when it could be edited */}
      <textarea
        ref={box}
        rows={2}
        readOnly={over}
        className={`w-full resize-none overflow-hidden rounded-md border bg-background px-2 py-1.5 text-[13px] leading-relaxed outline-none focus:ring-1 focus:ring-brand ${over ? "text-muted-foreground" : ""} ${over && !sent ? "line-through" : ""}`}
        value={value}
        disabled={!!busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter sends, like the chat's own box with a modifier; a plain Enter is a new line
          if (!over && e.key === "Enter" && (e.metaKey || e.ctrlKey) && value.trim() && !busy) {
            e.preventDefault();
            void act("send");
          }
        }}
      />
      {over ? (
        // The buttons' row, at their height (py-1 and a border, as the buttons have): where it ended instead
        <div className="flex items-center gap-2 border border-transparent py-1 text-[12px] text-muted-foreground">
          <span className={sent ? "text-ok" : ""}>{st!.state === "missing" ? "找不到了" : sent ? `发给了 ${where}` : st!.state === "withdrawn" ? `过时了，没发：${st!.reason ?? ""}` : `没发给 ${where}`}</span>
          {st!.doneAt && <span className="ml-auto shrink-0">{new Date(st!.doneAt).toTimeString().slice(0, 5)}</span>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <button className="inline-flex items-center gap-1 rounded-md border border-transparent bg-brand px-2.5 py-1 font-medium text-background disabled:opacity-50" disabled={!!busy || !value.trim()} onClick={() => act("send")}>
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
      )}
    </div>
  );
}

registerCard("task-outgoing", TaskOutgoing);
