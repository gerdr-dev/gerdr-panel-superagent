// What the panel still shows of the old board (whose page, BoardPage, and conversation drawer, ChatDrawer, were
// deleted 2026-11-27): a task's detail for one not handed out yet (Drawer: what was asked and by whom, repository and
// agent, 备注, 回复对方, hand it out, give it up), an ask's own panel (AskDrawer: a secret, an expired link) and the
// new-task form, all opened from Code's list (CodeSection).
import { AlertTriangle, ArrowUp, Ban, Bot, Check, CheckCircle2, Circle, CircleDashed, CircleDot, CircleDotDashed, CircleHelp, Copy, ExternalLink, Hand, KeyRound, Loader2, MessageSquare, Send, Undo2, X } from "lucide-react";
import { EditableTitle } from "../components/EditableTitle";
import clsx from "clsx";
import { type KeyboardEvent as ReactKeyEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet";
import { type Attachment } from "../components/Attachments";
import { TaskBox, TaskDialog, mentionsOf, uploading, type AgentInfo } from "../components/TaskBox";
import { askSecret, secretNames } from "../lib/bridge";
import { Menu, type ChatAction } from "../components/Menu";
import { Trail } from "../components/Trail";
import { ago, day, findAsk, since, type Ask, type Task } from "../lib/tasks";
import { run } from "../lib/gerdr";
import * as core from "@gerdr/core";
import { isSubmitEnter } from "../lib/utils";
import { Md } from "../lib/markdown";
import { newCodeTab } from "../lib/view";

// A task's group is its status and only the user moves it (移到… in its menu, the buttons: 派出去 / 通过 / 打回 / 放弃).
// Neither the worker nor its session's state moves it (DESIGN.md「状态只由用户改」, 2026-11-17: a /compact sent a
// task from 待验收 back to 进行中 and back).

type Col = "todo" | "active" | "you" | "review" | "done";

// No 等你 column (2026-11-13, the user: "不需要 等你 和 进行中。否则就是会跳来跳去"): a task waiting on the user stays
// in 进行中, first and yellow, instead of jumping between two columns each time it asks and gets an answer
const COLS: { id: Col; title: string; icon: React.ReactNode }[] = [
  { id: "todo", title: "待办", icon: <Circle className="size-3.5 text-muted-foreground" /> },
  { id: "active", title: "进行中", icon: <CircleDashed className="size-3.5 text-brand" /> },
  { id: "review", title: "待验收", icon: <CircleDotDashed className="size-3.5 text-ok" /> },
  { id: "done", title: "已完成", icon: <CheckCircle2 className="size-3.5 text-ok" /> },
];

/** The status a column stands for (tasks.setStatus). */
const STATUS: Record<Col, string> = { todo: "todo", active: "running", you: "running", review: "review", done: "done" };

/** Moves a task where the user dropped it or picked in its menu; refused moves (back to 待办 once sent out) say why. */
const toastError = (core as unknown as { toast?: { error?: (m: string) => unknown } }).toast?.error;
const toastOk = (core as unknown as { toast?: (m: string) => unknown }).toast;
function moveTo(act: Act, id: string, c: Col) {
  return act("setStatus", { id, status: STATUS[c] }).catch((e: any) => toastError?.(String(e?.message ?? e)));
}

/** Where the user can move a task by hand: alone on the board (a requirement's members are in its card). */
const movable = (t: Task) => !t.in && t.status !== "dropped";

/** Whether task t can go to column c by hand: 待办 only before it was sent out, 待验收 only after. */
function canMove(t: Task, c: Col) {
  if (!movable(t) || c === boardCol(t)) return false;
  if (c === "todo") return !t.session;
  if (c === "review") return !!t.session;
  return true;
}

/** 移到… rows for a task's menu, each with its column's icon. 已完成 is accept (its summary, the worker let go). */
function moveActions(t: Task): ChatAction[] {
  return COLS.filter((c) => canMove(t, c.id)).map((c) =>
    c.id === "done" ? { id: "accept", label: `移到${c.title}`, icon: c.icon, confirm: "确定完成？" } : { id: `move:${c.id}`, label: `移到${c.title}`, icon: c.icon },
  );
}

/** 放弃 in a task's menu. */
const DROP: ChatAction = { id: "drop", label: "放弃", kind: "danger", confirm: "确定放弃？", icon: <Ban className="size-3.5" /> };
const COPY: ChatAction = { id: "copy", label: "复制 id", icon: <Copy className="size-3.5" /> };
const RESTORE: ChatAction = { id: "restore", label: "恢复这个任务", icon: <Undo2 className="size-3.5" /> };

/**
 * A task's ⋯ menu: the same rows on its card, its drawer and its worker's chat (2026-11-19: the card had none, and the
 * user wanted the card's to be the drawer's). runTaskAction does each row the same way everywhere.
 */
function taskMenu(t: Task): ChatAction[] {
  if (t.status === "dropped") return [COPY, RESTORE];
  return [COPY, ...moveActions(t), ...(t.status === "done" ? [] : [DROP])];
}

/**
 * Copies text. navigator.clipboard is missing where the page isn't a secure context (Gerdr over plain http on the LAN,
 * some frames): there a hidden textarea and execCommand("copy") still work, inside the click that asked for it.
 */
async function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(box);
  box.select();
  const ok = document.execCommand("copy");
  box.remove();
  if (!ok) throw new Error("copy refused");
}

/** Does a row of taskMenu (or the chat's 通过); true when it went through. */
function runTaskAction(act: Act, t: Task, id: string): Promise<boolean> {
  if (id === "copy")
    return copyText(t.id).then(
      () => (toastOk?.(`已复制 ${t.id}`), true),
      () => (toastError?.("复制失败"), false),
    );
  if (id.startsWith("move:")) return moveTo(act, t.id, id.slice(5) as Col).then(() => true);
  return act(id, { id: t.id }).then(
    () => true,
    (e: any) => (toastError?.(String(e?.message ?? e)), false),
  );
}

/** Rows after which an open drawer closes: the task is over, its summary isn't worth flipping to. */
const closes = (id: string) => id === "accept" || id === "drop";

/** taskMenu as a ⋯ button, with its own confirm step. onDone: after a row went through. */
function TaskMenu({ t, act, onDone }: { t: Task; act: Act; onDone?: (id: string) => void }) {
  const [armed, setArmed] = useState("");
  return (
    <Menu
      actions={taskMenu(t)}
      armed={armed}
      onPick={(a) => {
        if (a.confirm && armed !== a.id) return setArmed(a.id);
        setArmed("");
        void runTaskAction(act, t, a.id).then((ok) => ok && onDone?.(a.id));
      }}
      onClose={() => setArmed("")}
    />
  );
}

/** Whether it waits on the user (tasks.ts's column "you"): first in 进行中, and yellow. */
const waitsOnUser = (t: Task) => colOf(t) === "you";

/** The column a card is in on the board: waiting on the user is still 进行中. */
const boardCol = (t: Task): Col => (colOf(t) === "you" ? "active" : colOf(t));

/** The board's column: tasks.ts says you / review / active / done; "active" is split into not started yet and running. */
function colOf(t: Task): Col {
  // A requirement with members: where the most pressing of them is (any waiting on the user → 等你)
  const c = t.teamColumn ?? t.column;
  if (c === "active" && t.status === "todo") return "todo";
  return c;
}


/** Opens a conversation in the drawer, from anywhere on the page (set by BoardPage). */
let openChat: (session: string, task?: string) => void = () => {};

/** Everything about one task and what you can do with it, in a panel on the right (full screen on a phone). */
function Drawer({ t, byId, act, onClose, onGo }: { t: Task; byId: Record<string, Task>; act: Act; onClose: () => void; onGo: (id: string) => void }) {
  const done = t.status === "done" || t.status === "dropped";
  return (
    // Not modal, like the chat drawer: another task's card stays clickable and switches the drawer to it; a click on
    // the board elsewhere closes it
    <Sheet open modal={false} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-full gap-0 sm:max-w-[520px]"
        onInteractOutside={(e) => {
          const el = e.target as Element | null;
          // Over Code (this panel: TaskDetail below) a click anywhere outside closes it, but not one on another 待办 row
          // (CodeSection's TaskRow, data-task-card): that switches it to the row's task, where closing first left it
          // shut (2026-11-25). Its own menus and dialogs, opened over it, aren't outside either
          if (closeOutside) return void (el?.closest?.("[data-radix-popper-content-wrapper],[role=menu],[role=listbox],[role=dialog],[data-task-card]") && e.preventDefault());
          if (!el?.closest?.("[data-gerdr-mount]") || el.closest("[data-task-card]")) e.preventDefault();
        }}
      >
        <SheetTitle className="sr-only">{t.title}</SheetTitle>
        {(() => {
          const header = (toggle: React.ReactNode) => (
            <div className="flex items-center gap-2 border-b px-4 py-2.5 text-[12px] text-muted-foreground">
              <Bot className="size-3.5" />
              <span className="font-mono">{t.id}</span>
              <span className="shrink-0">· {(waitsOnUser(t) ? "等你" : COLS.find((c) => c.id === boardCol(t))?.title)}</span>
              <EditableTitle value={t.title} onSave={(title) => renameTask(act, t, title)} className="text-[13px] font-medium text-foreground" />
              {toggle}
              <TaskMenu t={t} act={act} onDone={(id) => closes(id) && onClose()} />
              <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}>
                <X className="size-4" />
              </Button>
            </div>
          );
          return <Trail header={header} task={t.id} version={t.updatedAt} onSession={(id) => openChat(id, t.id)} onTask={onGo} />;
        })()}
        {done ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4"><DoneDetail t={t} act={act} /></div>
        ) : (
          // Scrolls itself, its steps pinned below
          <div className="flex min-h-0 flex-1 flex-col"><AgentCard key={t.id} t={t} byId={byId} act={act} /></div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Something a worker asked of the user, in a panel of its own (AskCard): the task it is for in the title row. */
function AskDrawer({ a, by, act, onClose, onGo }: { a: Ask; by: Task; act: Act; onClose: () => void; onGo: (id: string) => void }) {
  return (
    <Sheet open modal={false} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-full gap-0 sm:max-w-[520px]"
        onInteractOutside={(e) => {
          const el = e.target as Element | null;
          // Over Code (this panel: TaskDetail below) a click anywhere outside closes it: there is no board under it
          // whose other cards should stay clickable with it open. Its own menus and dialogs, opened over it, aren't outside
          if (closeOutside) return void (el?.closest?.("[data-radix-popper-content-wrapper],[role=menu],[role=listbox],[role=dialog]") && e.preventDefault());
          if (!el?.closest?.("[data-gerdr-mount]") || el.closest("[data-task-card]")) e.preventDefault();
        }}
      >
        <SheetTitle className="sr-only">{a.title}</SheetTitle>
        <div className="flex items-center gap-2 border-b px-4 py-2.5 text-[12px] text-muted-foreground">
          {a.handBack.kind === "choice" || a.handBack.kind === "questions" ? <CircleHelp className="size-3.5" /> : <Hand className="size-3.5" />}
          <span className="shrink-0">{a.status === "open" ? "等你" : a.status === "done" ? "已处理" : "已撤回"}</span>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-mono">{by.id}</span> {by.title}
          </span>
          <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <AskCard key={a.id} a={a} by={by} act={act} onGo={onGo} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

type Act = (fn: string, input: unknown) => Promise<unknown>;

/**
 * Renames a task (tasks.edit: its folder follows) and the conversations working on it, so the chat's title, the
 * card and the folder say the same.
 */
async function renameTask(act: Act, t: Task, title: string) {
  await act("edit", { id: t.id, title });
  for (const id of new Set([t.session, ...(t.sessions ?? [])].filter(Boolean) as string[]))
    await fetch(`/api/sessions/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-Gerdr": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ Title: title }),
    }).catch(() => {});
}

/** A button that runs an action, shows it running and its error. */
function useAction(act: Act) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const go = async (key: string, fn: string, input: unknown) => {
    setBusy(key);
    setErr("");
    try {
      await act(fn, input);
      return true;
    } catch (e: any) {
      setErr(String(e.message || e));
      return false;
    } finally {
      setBusy("");
    }
  };
  return { busy, err, go };
}

function Card({ children }: { children: React.ReactNode }) {
  return <article className="space-y-3">{children}</article>;
}

function Meta({ t, byId, extra }: { t: Task; byId: Record<string, Task>; extra?: React.ReactNode }) {
  const blockers = (t.blockedBy ?? []).map((b) => byId[b]).filter((b) => b && b.status !== "done" && b.status !== "dropped");
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <span className="font-mono">{t.id}</span>
      {t.repo && <span>· {t.repo.split("/").pop()}</span>}
      {(t.agent || t.model) && <span>· {[t.agent, t.model].filter(Boolean).join(" / ")}</span>}
        {t.from && <span>· 拆自 {t.from}</span>}
      {extra}
      {blockers.map((b) => (
        <span key={b.id} className="rounded-sm bg-warn/10 px-1.5 py-0.5 text-warn">
          等 {b.id} {b.title}
        </span>
      ))}
    </div>
  );
}

// Gerdr's file viewer for local paths (newer Gerdr only)
const openPath = (core as unknown as { openPath?: (path: string) => Promise<void> }).openPath;

/** The path a link to a file on this computer names (file:// or a bare absolute / ~ path), else null. */
function localPath(url: string) {
  if (url.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(url).pathname);
    } catch {
      return null;
    }
  }
  return url.startsWith("/") || url.startsWith("~/") ? url : null;
}

/** 产物: what the task's steps produced, oldest first, all kept so the way it went can be followed back. */
function Links({ t }: { t: Task }) {
  if (!t.links?.length) return null;
  const when = (ms: number) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <section className="space-y-1.5">
      <h4 className="text-[11px] font-medium text-muted-foreground">产物 · {t.links.length}</h4>
      <ol className="space-y-1 border-l pl-3">
        {t.links.map((l, i) => (
          <li key={l.url} className="relative flex items-baseline gap-2 text-[12px]">
            <span className={clsx("absolute top-1.5 -left-[16.5px] size-2 rounded-full border-2 border-background", i === t.links!.length - 1 ? "bg-brand" : "bg-muted-foreground/50")} />
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                // A file on this computer (a rendered video): a file:// link opens nothing from Gerdr's page, and nothing
                // at all on a phone, so open it in Gerdr's viewer. A Gerdr without openPath keeps the plain link.
                const path = localPath(l.url);
                if (path && openPath) {
                  e.preventDefault();
                  void openPath(path);
                }
              }}
              className="inline-flex min-w-0 items-center gap-1 hover:underline"
            >
              <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{l.label}</span>
            </a>
            {l.at && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">{when(l.at)}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Sent out and not finished (进行中 or 待验收): its waits count in either, as in local/_store.ts going. */
const going = (t: Task) => t.status === "running" || t.status === "review";

/** What its worker waits on outside (wait_for): a reply, a time to look again. */
function outside(t: Task) {
  return (t.waits ?? []).filter((w) => w.kind === "reply" || w.kind === "check" || w.kind === "time");
}

function liveText(t: Task) {
  const l = t.live;
  if (!l) return t.status === "todo" ? (t.routing ? "Superagent 在派" : "还没派出去") : t.session ? `会话已关闭 · ${ago(t.updatedAt)}` : "";
  if (l.status === "running") return `在跑 · ${since(l.turnStartedAt)}`;
  if (l.status === "waiting") return `等审批 / 回答 · ${since(l.waitingSince)}`;
  if (l.status === "error") return `出错：${l.error ?? ""}`;
  // Its turn is over but a session it handed work to is still going: waiting on that, not stopped
  if (t.helpers?.length) return `等它派出的会话 · ${ago(l.updatedAt)}`;
  // Its turn is over but subagents / background commands it started still run: its own work going on
  const bg = (t.waits ?? []).filter((w) => w.kind === "agent").length;
  if (bg) return `${bg} 个后台任务在跑 · ${ago(l.updatedAt)}`;
  // It said what it waits on outside (wait_for): a reply in a conversation it follows, and / or a time to look again
  const out = going(t) ? outside(t) : [];
  if (out.length) {
    const at = out.find((w) => w.kind === "time")?.at;
    return at && at > Date.now() && !out.some((w) => w.kind === "reply") ? `等外面 · ${Math.max(1, Math.round((at - Date.now()) / 60000))} 分钟后回来看` : `等回复 · ${ago(out[0].since)}`;
  }
  return `停下 · ${ago(l.updatedAt)}`;
}

/** A title as a new task gets one from what to do (local/tasks.ts firstLine): its first line, cut short. */
function firstLine(text: string) {
  const line = text.trim().split("\n")[0].trim();
  return [...line].length > 40 ? [...line].slice(0, 40).join("") + "…" : line;
}

function AgentCard({ t, byId, act }: { t: Task; byId: Record<string, Task>; act: Act }) {
  const { busy, err, go } = useAction(act);
  // A task not sent out yet is still the user's words: its text is an input box right away (no 编辑 to press), the way
  // it was written (新任务 asks only what to do; the title is its first line, here too). Saved when the box is left,
  // and before 派出去
  const editable = t.status === "todo" && !t.routing && !t.session && !t.reroute;
  const [draft, setDraft] = useState(t.prompt ?? t.title);
  // What its message's sender hears when it's sent out (设置 → 回复对方: 派出去时): the 回复对方 words, to change or empty
  const [reply, setReply] = useState(t.replyDraft ?? "");
  // A card from outside (a message someone sent): its text is their words, kept as they came; the user's own go in
  // 我的备注 (remark), sent to the worker after them (2026-11-16, the user: "这不是我写的，这是作为来源方")
  const quoted = !!t.origin && !t.assigned;
  const [remark, setRemark] = useState(t.remark ?? "");
  const [open, setOpen] = useState(false);
  // Whether the quote is cut: measured, not guessed from its lines (a phone wraps 6 lines into 12, and 展开全部 never
  // showed, user report 2026-11-16)
  const quote = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = quote.current;
    if (!el) return;
    const check = () => setCut(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [t.prompt, open]);
  const dirty = editable && !quoted && draft.trim() !== (t.prompt ?? t.title).trim();
  const remarkDirty = editable && quoted && remark.trim() !== (t.remark ?? "").trim();
  // Pressing 派出去 while typing in a box blurs it, and the blur saves: one save in flight, shared, so the button's
  // own save() waits for it instead of saving twice. The button must not go disabled for that save (busy "edit"):
  // disabled between mousedown and mouseup swallows the click, and 派出去 took two presses (user report, 2026-11-23).
  const saving = useRef<Promise<boolean> | null>(null);
  const save = () => {
    if (saving.current) return saving.current;
    const run = async () => {
      if (remarkDirty) return !!(await go("edit", "edit", { id: t.id, remark: remark.trim() }));
      const prompt = draft.trim();
      if (!dirty || !prompt) return true;
      return !!(await go("edit", "edit", { id: t.id, title: firstLine(prompt) || t.title, prompt }));
    };
    const p = run().finally(() => {
      saving.current = null;
    });
    saving.current = p;
    return p;
  };
  const stepBusy = busy !== "" && busy !== "edit";
  const l = t.live;
  const stale = l?.status === "running" && l.turnStartedAt && Date.now() - l.turnStartedAt > 40 * 60000;
  const tone = l?.status === "waiting" || l?.status === "error" || stale ? "text-warn" : l?.status === "running" ? "text-ok" : "text-muted-foreground";
  // The steps (派出去 / 让秘书重排 / 通过 / 打回) pinned under the scrolling card, like a chat's composer; 放弃 and 标为完成
  // are in the title row's ⋯ (Drawer)
  const foot = (t.status === "todo" && !t.routing && t.assigned?.state !== "ask") || t.status === "review";
  // 派出去, from the button or from Ctrl/⌘+Enter in the drawer's boxes (the note, the prompt, the reply): plain Enter
  // stays a new line there, as they're notes you write several lines in
  const canStart = foot && t.status === "todo" && !t.reroute && !stepBusy && (!editable || !!t.assigned || quoted || !!draft.trim());
  const start = async () => (await save()) && go("start", "start", { id: t.id, ...(t.canReply ? { reply } : {}) });
  const startKey = (e: ReactKeyEvent) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (canStart) void start();
  };
  return (
    <>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
    <Card>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[16px] font-medium">{t.title}</h3>
        {t.session && (
          <Button variant="ghost" className="text-[12px]" onClick={() => openChat(t.session!, t.id)}>
            <MessageSquare className="size-3.5" />
            对话
          </Button>
        )}
      </div>
      <Meta t={t} byId={byId} extra={liveText(t) ? <span className={clsx("inline-flex items-center gap-1", tone)}><CircleDot className="size-3" />{liveText(t)}{stale ? "（很久没结束）" : ""}</span> : undefined} />
      {l?.status === "waiting" && l.waiting && <p className="rounded-md bg-warn/10 px-3 py-2 text-[12px] text-warn">在等：{l.waiting}（去会话里处理）</p>}
      {t.summary && <Md>{t.summary}</Md>}
      <Links t={t} />
      {editable && quoted ? (
        <>
          <div className="rounded-md border-l-2 border-muted-foreground/30 bg-muted/40 px-3 py-2">
            {/* Markdown, as the sender wrote it (Meegle / Slack text has **bold** and - lists). Cut by height, not
                line-clamp: line-clamp only cuts one block of text, and Markdown is several (paragraphs, lists) */}
            <div ref={quote} className={clsx("text-muted-foreground", !open && "max-h-48 overflow-hidden")}>
              <Md className={txt}>{t.prompt ?? t.title}</Md>
            </div>
            {(cut || open) && (
              <button className="mt-1 text-[12px] text-brand hover:underline" onClick={() => setOpen(!open)}>
                {open ? "收起" : "展开全部"}
              </button>
            )}
          </div>
          <label className="block space-y-1.5">
            <span className="block text-[12px] text-muted-foreground">
              我的备注<span className="opacity-70"> · 派出去时附在上面这段后面交给 worker</span>
            </span>
            <textarea
              rows={3}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              onBlur={() => void save()}
              onKeyDown={startKey}
              placeholder="你的判断、重点、约束（比如：先只出方案，别改代码）"
              className={box}
            />
          </label>
        </>
      ) : editable ? (
        <textarea
          rows={10}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={startKey}
          placeholder="要 agent 做什么"
          className={box}
        />
      ) : (
        t.prompt && (
          <details className="text-[12px] text-muted-foreground" open={!t.summary}>
            <summary className="cursor-pointer">派活时的说明</summary>
            <p className="mt-1 whitespace-pre-wrap">{t.prompt}</p>
            {t.remark && <p className="mt-2 whitespace-pre-wrap">我的备注：{t.remark}</p>}
          </details>
        )
      )}
      {t.assigned?.state === "ask" && <AssignBox t={t} act={act} save={save} />}
      {t.assigned && t.assigned.state !== "ask" && !t.session && <ReplyBox t={t} act={act} />}
      {t.canReply && !t.routing && (
        <label className="block space-y-1.5 pt-1">
          <span className="block text-[12px] text-muted-foreground">
            派出去时回复{t.origin?.title ? <span title={t.origin.title}> {t.origin.title.split(/[:：]/)[0].slice(0, 40)} </span> : "对方"}<span className="opacity-70"> · 留空就不回</span>
          </span>
          <textarea
            rows={2}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={startKey}
            placeholder="派出去时发给发消息的人"
            className={box}
          />
        </label>
      )}
      {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
    </Card>
    </div>
    {foot && (
      <div className="shrink-0 space-y-2 border-t bg-muted/30 px-4 py-3">
        {t.reroute && t.status === "todo" ? (
          <p className="flex items-center gap-1.5 text-[12px] text-brand">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 truncate" title={t.reroute.feedback}>秘书在按你的意见重排：{t.reroute.feedback}</span>
            {t.reroute.router && (
              <button className="shrink-0 hover:underline" onClick={() => openChat(t.reroute!.router!)}>
                看它的对话
              </button>
            )}
          </p>
        ) : editable && !t.assigned ? (
          // 让秘书重排 is the drawer's composer: where you'd talk to the worker once it's out, you talk to the
          // secretary about the card before it is (2026-11-16: a button opening a box mid-drawer felt odd)
          <div className="flex items-end gap-2">
            <Composer busy={busy === "reroute"} placeholder="哪里不对？跟秘书说，它来重排" onSend={(feedback) => go("reroute", "reroute", { id: t.id, feedback })} before={save} />
            <Button className="h-9 shrink-0" disabled={stepBusy || (!quoted && !draft.trim())} title="Ctrl/⌘+Enter" onClick={() => void start()}>
              {busy === "start" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}派出去
            </Button>
          </div>
        ) : t.status === "review" ? (
          <div className="flex items-end gap-2">
            <Composer busy={busy === "reject"} placeholder="哪里不对？写了打回给它改" onSend={(feedback) => go("reject", "reject", { id: t.id, feedback })} />
            <Button className="h-9 shrink-0" disabled={!!busy} onClick={() => go("accept", "accept", { id: t.id })}>
              {busy === "accept" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}通过
            </Button>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button className="h-9" disabled={stepBusy} title="Ctrl/⌘+Enter" onClick={() => void start()}>
              {busy === "start" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}派出去
            </Button>
          </div>
        )}
      </div>
    )}
    </>
  );
}

// One size for what's read and typed in the drawer (the quote, the boxes, the composer), as Gerdr's own composer: 13px,
// 15px on a phone, 16px on an iPhone only (below 16 WebKit zooms into a focused box). A flat 16px on every phone next
// to 13px text read as mismatched (user report, 2026-11-16).
const txt = "text-[13px] max-md:text-[15px] max-md:supports-[-webkit-touch-callout:none]:text-[16px]";
const box = `w-full resize-y rounded-md border bg-background px-3 py-2 ${txt} leading-relaxed outline-none focus:ring-2 focus:ring-ring`;

/**
 * A one-line box that grows as you write, with its send button inside (the chat's composer, small): Enter sends,
 * Shift+Enter a new line. Cleared once sent.
 */
function Composer({ placeholder, busy, onSend, before }: { placeholder: string; busy: boolean; onSend: (text: string) => Promise<boolean>; before?: () => Promise<boolean> }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight leaves out the border (box-sizing: border-box): without it the box is 2px short and shows a scrollbar
    el.style.height = "auto";
    const full = el.scrollHeight + el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(full, 160)}px`;
    el.style.overflowY = full > 160 ? "auto" : "hidden";
  }, [text]);
  const send = async () => {
    const v = text.trim();
    if (!v || busy) return;
    if (before && !(await before())) return;
    if (await onSend(v)) setText("");
  };
  return (
    <div className="relative min-w-0 flex-1">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (!isSubmitEnter(e)) return;
          e.preventDefault();
          void send();
        }}
        placeholder={placeholder}
        className={`block max-h-40 min-h-9 w-full resize-none rounded-md border bg-background py-2 pr-10 pl-3 ${txt} leading-5 outline-none focus:ring-2 focus:ring-ring`}
      />
      <button
        aria-label="发出"
        disabled={!text.trim() || busy}
        onClick={() => void send()}
        className="absolute right-1.5 bottom-1.5 flex size-6 items-center justify-center rounded-md bg-foreground text-background transition-opacity disabled:opacity-25"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
      </button>
    </div>
  );
}

/**
 * Work someone asked of the user, not agreed yet (local/assign.ts): an agent does it (sent out at once, with the
 * agent and repository it suggested, else the secretary picks), they arrange it themselves, or they say no.
 */
function AssignBox({ t, act, save }: { t: Task; act: Act; save: () => Promise<boolean> }) {
  const { busy, err, go } = useAction(act);
  const [no, setNo] = useState(false);
  const [why, setWhy] = useState("");
  return (
    <div className="space-y-2 rounded-md border border-warn/40 bg-warn/5 p-3">
      <p className="text-[13px]">
        {t.assigned?.by ?? "有人"} 请你做这件事{t.origin?.url ? <a className="ml-1 text-brand hover:underline" href={t.origin.url} target="_blank" rel="noreferrer">原文</a> : null}。同意之前什么都不会跑；上面的说明可以先改。
      </p>
      {no ? (
        <div className="flex gap-2">
          <input autoFocus value={why} onChange={(e) => setWhy(e.target.value)} placeholder="为什么不做（会告诉对方）" className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]" />
          <Button disabled={!why.trim() || !!busy} onClick={() => go("decline", "decline", { id: t.id, reason: why })}>
            {busy === "decline" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}拒绝
          </Button>
          <Button variant="ghost" size="icon" aria-label="取消" onClick={() => setNo(false)}>
            <X className="size-4" />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={!!busy} onClick={() => setNo(true)}>
            拒绝
          </Button>
          <Button variant="outline" disabled={!!busy} title="变成你自己的任务：你来安排，可以再拆成几个交给 agent" onClick={async () => (await save()) && go("self", "agree", { id: t.id, how: "self" })}>
            {busy === "self" ? <Loader2 className="size-3.5 animate-spin" /> : <Hand className="size-3.5" />}同意，我自己安排
          </Button>
          <Button disabled={!!busy} title={t.repo ? `交给 agent，在 ${t.repo.split("/").pop()} 里做` : "交给 agent；仓库由秘书挑"} onClick={async () => (await save()) && go("agent", "agree", { id: t.id, how: "agent" })}>
            {busy === "agent" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}同意，交给 agent 做
          </Button>
        </div>
      )}
      {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
    </div>
  );
}

/**
 * Answering whoever asked for this task (local/assign.ts replyOrigin): 回复 says something, 回复并交付 hands it over
 * for them to accept — only a person delivers, after looking at the work themselves.
 */
function ReplyBox({ t, act }: { t: Task; act: Act }) {
  const { busy, err, go } = useAction(act);
  const draft = t.assigned?.draft ?? "";
  const [text, setText] = useState(draft);
  // The worker's delivery note (reply_requester) fills an empty box, also when it comes while the card is open
  useEffect(() => {
    if (draft) setText((x) => x.trim() ? x : draft);
  }, [draft]);
  const delivered = t.assigned?.state === "delivered" || t.assigned?.state === "done";
  const send = async (deliver: boolean) => (await go(deliver ? "deliver" : "say", "replyOrigin", { id: t.id, text, deliver })) && setText("");
  return (
    <div className="space-y-1.5">
      <p className="text-[12px] text-muted-foreground">
        {delivered
          ? `已交付给 ${t.assigned?.by ?? "发起人"}，等对方验收；还可以接着回复`
          : draft && text === draft
            ? `agent 写好了交付说明，交付时一起发给 ${t.assigned?.by ?? "发起人"}（可以先改）`
            : `回复 ${t.assigned?.by ?? "发起人"}；看过 worker 的结果、觉得完成了，点「标为已交付」（不用写字）`}
      </p>
      <textarea
        rows={draft && text === draft ? 6 : 2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`写给 ${t.assigned?.by ?? "发起人"} 的话`}
        className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]"
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={!text.trim() || !!busy} onClick={() => send(false)}>
          {busy === "say" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}回复
        </Button>
        {!delivered && (
          <Button disabled={!!busy} title="完成了：交给发起人验收。框里有字就一起发过去" onClick={() => send(true)}>
            {busy === "deliver" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {text.trim() ? "回复并交付" : "标为已交付"}
          </Button>
        )}
      </div>
      {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
    </div>
  );
}

/**
 * Something a worker asked of the user (an ask), in its own drawer: a step to do (with what to hand back: a value, a
 * secret through Gerdr's password box), a decision, several questions. Opened from the task's 等你 line when the chat's
 * card can't do it (a secret, an expired link to redo), or by a link (?open=a5). Answered or taken back: its record.
 */
function AskCard({ a: t, by, act, onGo }: { a: Ask; by: Task; act: Act; onGo: (id: string) => void }) {
  const { busy, err, go } = useAction(act);
  const [value, setValue] = useState("");
  const [secretAsked, setSecretAsked] = useState(false);
  const [saved, setSaved] = useState(false);
  const kind = t.handBack.kind;
  // A secret can only be handed back once it exists (or, on an old Gerdr, once the user says they ran the command)
  useEffect(() => {
    if (kind === "secret" && t.handBack.name) secretNames().then((n) => setSaved(n.includes(t.handBack.name!)), () => {});
  }, [kind, t.handBack.name, secretAsked]);
  const complete = (v?: string) => go("complete", "complete", { id: t.id, value: v ?? (kind === "value" || kind === "choice" ? value : undefined) });
  if (kind === "questions") return <Questions a={t} by={by} act={act} onGo={onGo} />;
  if (t.status !== "open")
    return (
      <Card>
        <BackToChat by={by} onGo={onGo} />
        <h3 className="text-[14px] font-medium">{t.title}</h3>
        {t.steps && <Steps text={t.steps} />}
        <p className="text-[12px] whitespace-pre-wrap text-muted-foreground">
          {t.status === "done" ? (kind === "secret" ? "已存好密钥" : t.handedBack ? `已处理：${t.handedBack}` : "已处理") : `已撤回${t.dropReason ? `：${t.dropReason}` : ""}`}
        </p>
      </Card>
    );
  if (kind === "choice") return <Decision a={t} by={by} busy={busy} err={err} onPick={complete} onDrop={() => go("drop", "dropAsk", { id: t.id })} onGo={onGo} />;
  return (
    <Card>
      <BackToChat by={by} onGo={onGo} />
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[14px] font-medium">
          {t.urgent && <AlertTriangle className="mr-1 inline size-3.5 text-warn" />}
          {t.title}
        </h3>
        {t.expiresAt ? <Expiry at={t.expiresAt} className="shrink-0 text-[12px]" /> : t.minutes ? <span className="shrink-0 text-[12px] text-muted-foreground">约 {t.minutes} 分钟</span> : null}
      </div>
      <p className="text-[11px] text-muted-foreground">{by.id} {by.title} 在等这一步</p>
      {t.steps && <Steps text={t.steps} />}
      {t.verify && <p className="text-[12px] text-muted-foreground">做完后 agent 会核验：{t.verify}</p>}
      <div className="space-y-2">
        {kind === "value" && (
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={`交回：${t.handBack.label || "一个值"}（不要填密码）`} className="h-8 w-full rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]" />
        )}
        {kind === "secret" && (
          <div className="space-y-1 rounded-md bg-muted px-3 py-2 text-[12px] text-muted-foreground">
            <p>
              要交回的是密钥「{t.handBack.label || t.handBack.name}」，存成 <span className="font-mono">{t.handBack.name}</span>，页面和 agent 都看不到值。
            </p>
            {secretAsked && (
              <p>
                没弹出输入框（Gerdr 还是旧版）的话，在终端运行 <span className="font-mono">gerdr work secret set {t.handBack.name}</span> 再点「完成」。
              </p>
            )}
          </div>
        )}
        {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
        {t.expiresAt && t.expiresAt < Date.now() && (
          <div className="flex items-center justify-between gap-2 rounded-md bg-warn/10 px-3 py-2 text-[12px] text-warn">
            <span>链接 / 验证码已经过期了。</span>
            <Button variant="outline" disabled={!!busy} onClick={() => go("redo", "redo", { id: t.id })}>
              {busy === "redo" ? <Loader2 className="size-3.5 animate-spin" /> : null}让它重新生成
            </Button>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <DropButton busy={!!busy} onDrop={() => go("drop", "dropAsk", { id: t.id })} />
          {kind === "secret" && (
            <Button
              variant="outline"
              disabled={!!busy || !t.handBack.name}
              onClick={async () => {
                setSecretAsked(true);
                if (await askSecret(t.handBack.name!, { label: t.handBack.label || t.title, note: t.steps })) await complete();
              }}
            >
              <KeyRound className="size-3.5" />
              输入密钥
            </Button>
          )}
          {(kind !== "secret" || saved || secretAsked) && (
            <Button disabled={!!busy || (kind === "value" && !value.trim())} onClick={() => complete()}>
              {busy === "complete" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {kind === "secret" && !saved ? "已存好，完成" : "完成"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Several things one worker needs decided or given, as one item: it can't go on until all are answered, so they're
 * answered here together; each answer is kept as it's given, and the worker hears them all once the last is in. An
 * answer can be changed (before the last one nobody has acted on it; after, the worker is told what changed).
 */
function Questions({ a: t, by, act, onGo }: { a: Ask; by: Task; act: Act; onGo: (id: string) => void }) {
  const { busy, err, go } = useAction(act);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const qs = (t.questions ?? []).filter((q) => !q.dropped);
  const left = qs.filter((q) => !q.answer).length;
  const answer = async (q: { id: string }, v: string) => {
    if (await go(`q${q.id}`, "answerQuestion", { id: t.id, q: q.id, value: v })) {
      setDraft((d) => ({ ...d, [q.id]: "" }));
      setEditing((e) => ({ ...e, [q.id]: false }));
    }
  };
  return (
    <Card>
      <BackToChat by={by} onGo={onGo} />
      <h3 className="text-[14px] font-medium">{t.title}</h3>
      <p className="text-[12px] text-muted-foreground">{left ? `还有 ${left} 个要你答；都答完 worker 一次收到全部答案` : "都答了"}</p>
      <ol className="space-y-3">
        {qs.map((q, i) => {
          const open = !q.answer || editing[q.id];
          return (
            <li key={q.id} className={clsx("space-y-2 rounded-lg border p-3", !q.answer && "border-warn/50")}>
              <p className="text-[13px] font-medium">
                {i + 1}. {q.title}
              </p>
              {q.steps && <Steps text={q.steps} />}
              {!open ? (
                <div className="flex items-center gap-2 text-[12px]">
                  <Check className="size-3.5 shrink-0 text-ok" />
                  <span className="min-w-0 flex-1 whitespace-pre-wrap">{q.answer}</span>
                  <button className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setEditing((e) => ({ ...e, [q.id]: true }))}>
                    改答案
                  </button>
                </div>
              ) : q.kind === "choice" && q.multi ? (
                <MultiPick options={q.options ?? []} answer={q.answer} busy={busy === `q${q.id}`} disabled={!!busy} onSubmit={(v) => answer(q, v)}>
                  {q.answer && (
                    <Button variant="ghost" onClick={() => setEditing((e) => ({ ...e, [q.id]: false }))}>
                      不改
                    </Button>
                  )}
                </MultiPick>
              ) : (
                <div className="space-y-1.5">
                  {q.kind === "choice" &&
                    (q.options ?? []).map((o) => (
                      <button
                        key={o}
                        disabled={!!busy}
                        className={clsx("block w-full rounded-md border px-3 py-2 text-left text-[13px] hover:bg-accent", q.answer === o && "border-ok")}
                        onClick={() => answer(q, o)}
                      >
                        {o}
                      </button>
                    ))}
                  <div className="flex gap-2">
                    {/* A textarea: an answer can be a few sentences. Enter sends, Shift+Enter is a new line, an input
                        method's Enter (picking a word) sends nothing */}
                    <textarea
                      rows={1}
                      value={draft[q.id] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [q.id]: e.target.value }))}
                      placeholder={q.kind === "choice" ? "其他，自己写…（Shift+Enter 换行）" : `交回：${q.label || "一个值"}（不要填密码）`}
                      className="field-sizing-content max-h-40 min-h-8 min-w-0 flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]"
                      onKeyDown={(e) => {
                        if (!isSubmitEnter(e)) return;
                        e.preventDefault();
                        if (draft[q.id]?.trim()) answer(q, draft[q.id]);
                      }}
                    />
                    <Button disabled={!!busy || !draft[q.id]?.trim()} onClick={() => answer(q, draft[q.id])}>
                      {busy === `q${q.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      {q.answer ? "改成这个" : "答"}
                    </Button>
                    {q.answer && (
                      <Button variant="ghost" onClick={() => setEditing((e) => ({ ...e, [q.id]: false }))}>
                        不改
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
      {t.status === "open" && (
        <div className="flex justify-end">
          <DropButton busy={!!busy} onDrop={() => go("drop", "dropAsk", { id: t.id })} />
        </div>
      )}
    </Card>
  );
}

/** The task whose worker asked this: a way back to its conversation, for the context. */
function BackToChat({ by, onGo }: { by: Task; onGo: (id: string) => void }) {
  if (!by.session) return null;
  return (
    <button onClick={() => onGo(by.id)} className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground">
      <MessageSquare className="size-3.5 shrink-0" />
      <span className="truncate">回到 {by.id} 的对话：{by.title}</span>
    </button>
  );
}

/**
 * A decision a worker left on the board (ask_human with options): no hurry, no chat waiting on it. Picking an option,
 * or writing one's own, sends it to the worker, which carries on.
 */
function Decision({ a: t, by, busy, err, onPick, onDrop, onGo }: { a: Ask; by: Task; busy: string; err: string; onPick: (v: string) => void; onDrop: () => void; onGo: (id: string) => void }) {
  const [own, setOwn] = useState("");
  return (
    <Card>
      <BackToChat by={by} onGo={onGo} />
      <h3 className="text-[16px] font-medium">{t.title}</h3>
      <p className="text-[11px] text-muted-foreground">{by.id} {by.title} 在等这个决定</p>
      {t.steps && <Steps text={t.steps} />}
      {t.handBack.multi ? (
        <MultiPick options={t.handBack.options ?? []} busy={busy === "complete"} disabled={!!busy} onSubmit={onPick} />
      ) : (
        <div className="space-y-1.5">
          {(t.handBack.options ?? []).map((o, i) => (
            <button key={i} disabled={!!busy} onClick={() => onPick(o)} className="flex w-full gap-2 rounded-lg border p-2.5 text-left text-[13px] hover:border-ring hover:bg-accent disabled:opacity-50">
              <span className="shrink-0 font-mono text-muted-foreground">{i + 1}</span>
              <span className="whitespace-pre-wrap">{o}</span>
            </button>
          ))}
          <div className="flex gap-2">
            <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="其他，自己写…" onKeyDown={(e) => isSubmitEnter(e) && own.trim() && onPick(own.trim())} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]" />
            <Button disabled={!own.trim() || !!busy} onClick={() => onPick(own.trim())}>
              {busy === "complete" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}就这样定
            </Button>
          </div>
        </div>
      )}
      {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
      <div className="flex justify-end">
        <DropButton busy={!!busy} onDrop={onDrop} />
      </div>
    </Card>
  );
}

/**
 * A decision where several options may be picked (ask_human multi): a click ticks, the button sends the ticked ones
 * (in the options' order) and anything written, one per line — the same shape the chat card sends. A click that
 * answered at once is what made the user lose a multiple choice to its first pick (t32, 2026-11-05).
 */
function MultiPick({ options, answer, busy, disabled, onSubmit, children }: { options: string[]; answer?: string; busy: boolean; disabled: boolean; onSubmit: (v: string) => void; children?: React.ReactNode }) {
  const was = answer ? answer.split("\n") : [];
  const [on, setOn] = useState(() => options.filter((o) => was.includes(o)));
  const [own, setOwn] = useState(() => was.filter((x) => !options.includes(x)).join("；"));
  const picked = [...options.filter((o) => on.includes(o)), ...(own.trim() ? [own.trim()] : [])];
  const submit = () => picked.length && onSubmit(picked.join("\n"));
  return (
    <div className="space-y-1.5">
      {options.map((o, i) => {
        const ticked = on.includes(o);
        return (
          <button
            key={i}
            disabled={disabled}
            aria-pressed={ticked}
            onClick={() => setOn((x) => (ticked ? x.filter((y) => y !== o) : [...x, o]))}
            className={clsx("flex w-full gap-2 rounded-lg border p-2.5 text-left text-[13px] hover:border-ring hover:bg-accent disabled:opacity-50", ticked && "border-ok bg-ok/10")}
          >
            <span className={clsx("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border", ticked && "border-ok bg-ok text-background")}>{ticked && <Check className="size-3" />}</span>
            <span className="whitespace-pre-wrap">{o}</span>
          </button>
        );
      })}
      <div className="flex gap-2">
        <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="其他，自己写…（可以和上面的一起交）" onKeyDown={(e) => isSubmitEnter(e) && submit()} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]" />
        <Button disabled={!picked.length || disabled} onClick={submit}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          {picked.length ? `交这 ${picked.length} 项` : "先勾选"}
        </Button>
        {children}
      </div>
    </div>
  );
}

/** What an ask / question says, in the chat's Markdown (links, local videos and images shown, code). */
function Steps({ text }: { text: string }) {
  return <Md className="rounded-md bg-muted/60 px-3 py-2">{text}</Md>;
}

function DoneDetail({ t: card, act }: { t: Task; act?: Act }) {
  // The board's copy of a finished task is slim (local/tasks.ts slim: no notes, the brief cut): the whole task when opened
  const [full, setFull] = useState<Task | null>(null);
  useEffect(() => {
    let on = true;
    run<Task>("tasks.get", { id: card.id }).then(
      (x) => on && setFull(x),
      () => {},
    );
    return () => {
      on = false;
    };
  }, [card.id, card.updatedAt]);
  const t = full?.id === card.id ? { ...card, notes: full.notes, prompt: full.prompt } : card;
  return (
    <div className="space-y-3">
      <h3 className={clsx("text-[16px] font-medium", t.status === "dropped" && "text-muted-foreground line-through")}>{t.title}</h3>
      <div className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
        {t.repo && <span>{t.repo.split("/").pop()}</span>}
        {(t.agent || t.model) && <span>· {[t.agent, t.model].filter(Boolean).join(" / ")}</span>}
        {t.from && <span>· 拆自 {t.from}</span>}
        <span>· {t.status === "dropped" ? "放弃于" : "完成于"} {day(t.doneAt ?? t.updatedAt)}</span>
      </div>
      {t.summary && <Md>{t.summary}</Md>}
      <Links t={t} />
      {t.notes?.map((n) => (
        <p key={n.at} className="text-[12px] whitespace-pre-wrap text-muted-foreground">
          {n.text}
        </p>
      ))}
      {t.prompt && (
        <details className="text-[12px] text-muted-foreground">
          <summary className="cursor-pointer">派活时的说明</summary>
          <p className="mt-1 whitespace-pre-wrap">{t.prompt}</p>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        {t.session && (
          <Button variant="outline" className="text-[12px]" onClick={() => openChat(t.session!, t.id)}>
            <MessageSquare className="size-3.5" />
            打开对话
          </Button>
        )}
        {t.status === "dropped" && act && (
          <Button variant="outline" className="text-[12px]" title="撤销放弃：回到放弃前的样子" onClick={() => void act("restore", { id: t.id })}>
            <Undo2 className="size-3.5" />
            恢复这个任务
          </Button>
        )}
      </div>
    </div>
  );
}

/** How long what an ask needs still works (a sign-in link): re-drawn every 30 s; past it, "已过期". */
function Expiry({ at, className }: { at: number; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const left = Math.round((at - Date.now()) / 60_000);
  return <span className={clsx(left <= 0 ? "text-bad" : left <= 5 ? "text-warn" : "text-muted-foreground", className)}>{left <= 0 ? "已过期" : `还剩 ${left} 分钟`}</span>;
}

/**
 * 不用了 on an ask: the worker is told it isn't needed (tasks.dropAsk). Two clicks instead of window.confirm (the
 * browser's own box, unthemed and in English); arms for 3 seconds.
 */
function DropButton({ busy, onDrop }: { busy: boolean; onDrop: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <Button variant="ghost" className={clsx("text-[12px]", armed ? "text-bad" : "text-muted-foreground")} title="不用做了：告诉它换个做法" disabled={busy} onClick={() => (armed ? onDrop() : setArmed(true))}>
      {armed ? "确定不用了？" : "不用了"}
    </Button>
  );
}

const input = "h-9 w-full rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]";

function NewTask({ onClose, act }: { onClose: () => void; act: Act }) {
  const [f, setF] = useState({ prompt: "", repo: "", agent: "", model: "", worktree: false });
  const [repos, setRepos] = useState<{ path: string; name: string }[]>([]);
  const [more, setMore] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const { busy, err, go } = useAction(act);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  useEffect(() => {
    run<{ path: string; name: string }[]>("tasks.repos").then(setRepos, () => {});
    run<AgentInfo[]>("tasks.agents").then(setAgents, () => {});
  }, []);
  const mentions = mentionsOf(f.prompt, agents);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });
  const submit = async (start: boolean) => {
    // Every task is for an agent; 只记下 keeps it in 待办 (the user's own to-do too) until they send it out
    const body = { prompt: f.prompt, repo: f.repo, agent: f.agent || undefined, model: f.model.trim() || undefined, mentions: mentions.length ? mentions.map((a) => a.id) : undefined, worktree: f.worktree, start, attachments: files.filter((a) => a.path).map((a) => ({ path: a.path, name: a.name, mime: a.mime })) };
    if (await go(start ? "start" : "add", "add", body)) onClose();
  };
  const ok = !uploading(files) && (f.prompt.trim() || files.length);
  return (
    <TaskDialog title="新任务" onClose={onClose} busy={!!busy} err={err}>
        <>
            <TaskBox
              agents={agents}
              value={f.prompt}
              onChange={(prompt) => setF({ ...f, prompt })}
              files={files}
              onFiles={setFiles}
              onSubmit={() => ok && !busy && void submit(true)}
              className={clsx(input, "h-40 resize-y py-2 leading-relaxed")}
              placeholder="要它做什么：目标、范围、做完的标准（截图可以直接粘贴；输入 @ 点名 agent；回车派出，Shift+回车换行）"
              below={
                mentions.length > 0 && (
                  <p className="text-[12px] text-muted-foreground">
                    交给 {mentions.map((a) => a.name).join("、")}
                    {mentions.length > 1 ? "：由派活的对话安排怎么分、谁用什么模型" : ""}
                  </p>
                )
              }
            />
            {more ? (
              <>
                <input className={input} list="board-repos" placeholder="仓库目录" value={f.repo} onChange={set("repo")} />
                <datalist id="board-repos">
                  {repos.map((r) => (
                    <option key={r.path} value={r.path}>
                      {r.name}
                    </option>
                  ))}
                </datalist>
                <div className="flex items-center gap-3">
                  <input className={input} placeholder="agent（不填 = 设置里定的；claude / codex / 角色 id）" value={f.agent} onChange={set("agent")} />
                  <input className={input} placeholder="模型（不填 = 设置里定的）" value={f.model} onChange={set("model")} />
                  <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                    <input type="checkbox" checked={f.worktree} onChange={set("worktree")} />
                    独立 worktree
                  </label>
                </div>
              </>
            ) : (
              <button className="self-start text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setMore(true)}>
                指定仓库 / agent / 模型（不填就照「设置」里的，仓库由 Superagent 来定）
              </button>
            )}
          </>
        <div className="flex items-center justify-end gap-2">
          {/* The way past the secretary, for someone who came here wanting to talk to a worker themselves */}
          <button
            className="mr-auto text-[12px] text-muted-foreground hover:text-foreground"
            title="不写任务，自己开一个对话：选目录和 agent，直接跟它说"
            onClick={() => (onClose(), newCodeTab())}
          >
            自己开对话 ⌘T
          </button>
          <Button variant="outline" disabled={!ok || !!busy} title="放进待办，先不派出去" onClick={() => submit(false)}>
            只记下
          </Button>
          <Button disabled={!ok || !!busy} onClick={() => submit(true)}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            创建并派出
          </Button>
        </div>
    </TaskDialog>
  );
}


/** The task drawer closes on a click outside it (set by TaskDetail: the drawer is over Code, not over the board). */
let closeOutside = false;

/** A task's detail, as the board's card opened: for a task with no conversation yet (待办). `onSession`: a conversation it links to was picked. */
export function TaskDetail({ t, byId, act, onClose, onGo, onSession }: { t: Task; byId: Record<string, Task>; act: Act; onClose: () => void; onGo: (id: string) => void; onSession: (session: string) => void }) {
  openChat = (session) => onSession(session);
  closeOutside = true;
  return <Drawer t={t} byId={byId} act={act} onClose={onClose} onGo={onGo} />;
}

/**
 * An ask's own panel (AskDrawer), over Code: for what the chat's card can't take, a secret to store through Gerdr's
 * password box or an expired link to redo. The board opened it from the task's 等你 line; with the board gone the
 * pane's 等你 opens it (CodeSection), or a secret had nowhere to be handed back (2026-11-25). `onGo`: a task or an
 * ask it links to was picked.
 */
export function AskDialog({ id, tasks, act, onClose, onGo }: { id: string; tasks: Task[]; act: Act; onClose: () => void; onGo: (id: string) => void }) {
  closeOutside = true;
  const f = findAsk(tasks, id);
  return f ? <AskDrawer a={f.a} by={f.t} act={act} onClose={onClose} onGo={onGo} /> : null;
}

/** The new-task form (what to do, repository, agent, attachments; kept in 待办 or handed out at once). */
export function NewTaskDialog({ act, onClose }: { act: Act; onClose: () => void }) {
  return <NewTask act={act} onClose={onClose} />;
}
