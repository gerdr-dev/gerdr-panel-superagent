import { AlertTriangle, ArrowUp, Ban, Bot, Inbox, Check, CheckCircle2, Circle, CircleDashed, CircleDot, CircleHelp, Copy, ExternalLink, Hand, KeyRound, Loader2, MessageSquare, Paperclip, Plus, Search, Send, Settings, Undo2, X } from "lucide-react";
import { EditableTitle } from "../components/EditableTitle";
import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet";
import { type Attachment } from "../components/Attachments";
import { TaskBox, TaskDialog, mentionsOf, uploading, type AgentInfo } from "../components/TaskBox";
import { askSecret, secretNames } from "../lib/bridge";
import { ChatDrawer, Menu, type ChatAction, type ChatItem } from "../components/ChatDrawer";
import { Trail } from "../components/Trail";
import { Linger } from "../lib/linger";
import { SettingsSheet, TABS, type SettingsTab } from "../components/SettingsSheet";
import { phoneMenu, usePhoneMenu } from "../lib/phoneMenu";
import { useSearchItems } from "../lib/search";
import { ago, day, findAsk, openAsks, since, type Ask, type Task, useTasks, waitedSince } from "../lib/tasks";
import { project, run } from "../lib/gerdr";
import { fileCardStates } from "../lib/cardstates";
import * as core from "@gerdr/core";
import { onShowSession } from "@gerdr/core";
import { isSubmitEnter } from "../lib/utils";
import { Md } from "../lib/markdown";
import { usePhone, useSwipePages } from "../lib/swipe";
import { convo, parseConvo } from "../lib/convo";
import { usePanelChange, useRefresh, useSessions } from "../lib/visible";
import { useLocation } from "react-router";
import { createPortal } from "react-dom";
import { usePortalContainer } from "../lib/portal";

// The task board: columns left to right (to do, running, to review, done), small cards, details in a side panel. A
// card's column is its task's status and only the user moves it: dragging it here, 移到… in its menu, or the buttons
// (派出去 / 通过 / 打回 / 放弃). Neither the worker nor its session's state moves it (DESIGN.md「状态只由用户改」, 2026-11-17:
// a /compact sent a card from 待验收 back to 进行中 and back). The session's state is only shown: the card's live line,
// and yellow (等你) when it waits on the user right now.

type Col = "todo" | "active" | "you" | "review" | "done";

// No 等你 column (2026-11-13, the user: "不需要 等你 和 进行中。否则就是会跳来跳去"): a task waiting on the user stays
// in 进行中, first and yellow, instead of jumping between two columns each time it asks and gets an answer
const COLS: { id: Col; title: string; icon: React.ReactNode }[] = [
  { id: "todo", title: "待办", icon: <Circle className="size-3.5 text-muted-foreground" /> },
  { id: "active", title: "进行中", icon: <CircleDashed className="size-3.5 text-brand" /> },
  { id: "review", title: "待验收", icon: <CircleDot className="size-3.5 text-ok" /> },
  { id: "done", title: "已完成", icon: <CheckCircle2 className="size-3.5 text-muted-foreground" /> },
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

/** Most important first: what waits on the user, then results to judge, then what's going on. */
const PHONE_ORDER: Col[] = ["active", "review", "todo", "done"];

/**
 * The columns as tabs, on a phone only: colour and count on each, the ones with nothing in them dimmed. Sideways
 * scrolling between columns was awkward on a phone (the user, 2026-11-05); a swipe on the column turns to the next
 * tab, like Gerdr's own phone overview (lib/swipe.ts).
 */
function PhoneTabs({ cols, count, waitingCount, current, onPick }: { cols: typeof COLS; count: (c: Col) => number; waitingCount: (c: Col) => number; current: Col; onPick: (c: Col) => void }) {
  return (
    <div role="tablist" className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b bg-background px-2 py-1.5 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">
      {cols.map((c) => {
        const n = count(c.id);
        const on = c.id === current;
        const you = c.id === "active" ? waitingCount(c.id) : 0;
        const loud = (c.id === "active" && you > 0) || (c.id === "review" && n > 0);
        return (
          <button
            key={c.id}
            role="tab"
            aria-selected={on}
            onClick={() => onPick(c.id)}
            className={clsx(
              "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[13px]",
              on ? "bg-accent font-medium text-foreground" : n ? "text-foreground" : "text-muted-foreground/60",
              loud && !on && (c.id === "active" ? "bg-warn/10" : "bg-ok/10"),
            )}
          >
            {c.icon}
            {c.title}
            <span className="tabular-nums text-[11px] text-muted-foreground">{n}</span>
            {you > 0 && <span className="rounded-full bg-warn px-1.5 text-[11px] font-medium text-background tabular-nums">等你 {you}</span>}
          </button>
        );
      })}
    </div>
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


export default function BoardPage() {
  const { tasks, archived, error, act } = useTasks();
  const [archive, setArchive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  // On a phone Gerdr's ☰ drawer holds what the header has no room for: the settings sheet's pages, one row each
  usePhoneMenu(TABS.map((x) => ({ id: x.id, label: x.label, icon: <x.icon className="size-4" />, onSelect: () => setSettings(x.id) })))
  const [open, setOpen] = useState("");
  // The secretary's page links here with ?open=tN (a thing waiting on the user, a worker it quoted): open that task
  const { search } = useLocation();
  useEffect(() => {
    const id = new URLSearchParams(search).get("open");
    if (id) setOpen(id);
  }, [search]);
  const [doneLimit, setDoneLimit] = useState(20);
  const byId = Object.fromEntries((tasks ?? []).map((t) => [t.id, t]));
  // ⌘F (Ctrl+F off the mac) over the board: a box in the header that narrows every column to the cards matching it.
  // In a task's drawer ⌘F is the chat's own find (Gerdr's, it reaches the messages the virtual list hasn't drawn);
  // here, without our own, the browser's find came up, which can't see past the 20 finished cards shown.
  const [find, setFind] = useState<string | null>(null); // null: the box is closed
  const findBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const mac = /Mac/.test(navigator.platform);
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.code !== "KeyF" || e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey)) return;
      // The board hidden (another tab), or a drawer, the settings or a dialog over it: theirs (the chat's find), or the
      // browser's over what they show. Only dialogs on screen: another panel kept mounted out of sight with its drawer
      // open has one in the page too, and counting it left ⌘F to the browser here.
      // Gerdr hides the panels not shown with visibility (invisible), so being laid out isn't enough: checked as well.
      const seen = (el: Element | null | undefined) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible";
      if (!seen(pageRoot.current)) return;
      if ([...document.querySelectorAll("[role=dialog]")].some(seen)) return;
      e.preventDefault();
      setFind((f) => f ?? "");
      requestAnimationFrame(() => (findBox.current?.focus(), findBox.current?.select()));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const words = (find ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const textOf = (t: Task) => [t.id, t.title, t.repo, t.origin?.title, t.prompt, t.question, t.summary, t.said, ...(t.asks ?? []).map((a) => a.title)].filter(Boolean).join("\n").toLowerCase();
  // Every word somewhere in the card's task (what it asked the user too) or in a member inside its card
  const hit = (t: Task) => {
    if (!words.length) return true;
    const text = [t, ...(tasks ?? []).filter((x) => x.in === t.id)].map(textOf).join("\n");
    return words.every((w) => text.includes(w));
  };
  const list = (c: Col) => {
    // Members of a requirement are in its card, not cards of their own
    const l = (tasks ?? []).filter((t) => !t.in && boardCol(t) === c);
    if (c === "done") return l.sort((a, b) => Number(a.status === "dropped") - Number(b.status === "dropped") || (b.doneAt ?? 0) - (a.doneAt ?? 0));
    // What waits on the user first (newest first, by when it started waiting), then the rest, newest first
    return l.sort((a, b) => Number(waitsOnUser(b)) - Number(waitsOnUser(a)) || (waitsOnUser(a) ? waitedSince(b) - waitedSince(a) : b.updatedAt - a.updatedAt));
  };
  const waitingCount = (c: Col) => (c === "active" ? list(c).filter(waitsOnUser).length : 0);
  // On a phone: one column, by tabs in order of what matters most to the user. It opens on the first of them that has
  // anything in it (an empty 等你 is good news, not a page to land on), until they pick one themselves.
  const [phoneTab, setPhoneTab] = useState<Col | null>(null);
  const phoneCols = PHONE_ORDER.map((id) => COLS.find((c) => c.id === id)!);
  const phoneCol: Col = phoneTab ?? PHONE_ORDER.find((c) => list(c).length > 0) ?? "active";
  const phone = usePhone();
  const pagerView = useRef<HTMLDivElement>(null);
  const pagerTrack = useRef<HTMLDivElement>(null);
  const pageRoot = useRef<HTMLDivElement>(null);
  useSwipePages(pagerView, pagerTrack, PHONE_ORDER.indexOf(phoneCol), phone ? PHONE_ORDER.length : 0, (i) => setPhoneTab(PHONE_ORDER[i]), pageRoot);
  const sel = open ? byId[open] : undefined;
  // Something a worker asked of the user (an ask: a5), opened from its card's line or a link: its own small drawer
  const askSel = open && !sel ? findAsk(tasks ?? undefined, open) : undefined;
  // A task with a worker opens as its conversation (Gerdr's chat in our drawer): the whole chat to decide from, and its
  // input box for the answer. Everything else (to do, finished ones) in our own panel.
  // Still being handed out: it opens as the routing conversation, live, so the user sees how it's deciding and can
  // put it right
  const routingNow = !!sel && sel.status === "todo" && !!sel.routing && !!sel.router;
  // Every agent task with a worker opens as its conversation, finished ones too: that is where everything it said is
  // (2026-11-11: a feed of summaries next to it left the user going board → requirement → chat for the real answer)
  const inChat = !!sel && (!!sel.session || routingNow);
  // A session its worker handed work to is asking the user something: that's where the answer goes, so it opens
  // first (the 链路 above leads back to the worker)
  const asking = sel && going(sel) ? sel.helpers?.find((k) => k.status === "waiting" && k.left) : undefined;
  const primary = sel ? (routingNow ? sel.router : asking ? asking.id : sel.session) : undefined;
  // Another conversation of the same task picked in its 链路 (the router, an earlier worker, a helper): shown in the
  // same drawer; its buttons are the task's live conversation's only
  // A conversation key (lib/convo): a session, or one of its subagents
  const [shown, setShown] = useState("");
  useEffect(() => setShown(""), [open]);
  const viewing = shown || primary;
  const view = viewing ? parseConvo(viewing) : undefined;
  const panel =
    sel && inChat && viewing
      ? viewing !== primary
        ? view?.sub
          ? { label: `${sel.id} 的 worker 开的子 agent（只读）：它自己的活，做完会叫醒 worker`, actions: [] }
          : { label: viewing === sel.router ? `秘书派 ${sel.id} 时怎么判断的。以后都不想这样派，就改「设置」里的仓库、模型，或「流程」里的派活规则` : `${sel.id} 背后的另一个对话`, actions: [] }
        : routingNow
          ? { label: `Superagent 正在派 ${sel.id}：挑仓库、agent 和模型。看到不对直接在下面纠正`, actions: [{ id: "drop", label: "放弃", confirm: "确定放弃？" } as ChatAction] }
          : chatPanel(sel, byId)
      : null;
  // A conversation opened from a panel ("回到 tN 的对话", a finished task's chat): the chat alone, over the panel,
  // with its task's 链路 when it has one
  const [peek, setPeek] = useState<{ session: string; task?: string; sub?: string; from?: string } | null>(null);
  // ⌘K over the board finds any task on it (finished ones too, not only the 20 shown), and opens it like a click
  // In the board's order of what matters (等你, 进行中, 待验收, 待办, then 已完成 newest first), each column sorted as
  // on the board; tasks inside a requirement's card after them. Typing re-ranks by how well each row matches.
  const searchOrder = PHONE_ORDER.flatMap(list);
  const searchSeen = new Set(searchOrder.map((t) => t.id));
  useSearchItems(
    [...searchOrder, ...(tasks ?? []).filter((t) => !searchSeen.has(t.id)).sort((a, b) => b.updatedAt - a.updatedAt)].map((t) => ({
      id: t.id,
      label: t.title,
      // Only the status at the row's end: a repo path made every row's end land somewhere else
      detail: waitsOnUser(t) ? "等你" : COLS.find((c) => c.id === boardCol(t))?.title,
      // The board's colours for the same status: 等你 its amber badge, 进行中 / 待验收 their column icons' colours
      ...(waitsOnUser(t) ? { tone: "warn" as const, pill: true } : boardCol(t) === "active" ? { tone: "brand" as const } : boardCol(t) === "review" ? { tone: "ok" as const } : {}),
      keywords: [t.repo, t.origin?.title, t.prompt?.slice(0, 300)].filter(Boolean).join(" "),
      onSelect: () => (setPeek(null), setOpen(t.id)),
    })),
    { heading: "任务" },
  );
  // A conversation opened from a task's drawer (a member's avatar in a requirement) is a second layer over that drawer,
  // which stays open underneath: the user goes back and forth between the two often, and closing the chat (its way
  // back, Esc) just slides it off the drawer again instead of swapping one drawer for another
  // The secretary's open questions (MainButton reads them): listed over its chat when that is what the drawer shows
  const [sec, setSec] = useState<{ main?: string; open: SecAsk[] }>({ open: [] });
  const openRef = useRef(open);
  openRef.current = open;
  openChat = (session: string, task?: string) => setPeek({ session, task, from: openRef.current || undefined });
  openAsk = setOpen;
  // A worker's conversation brought up from elsewhere in Gerdr (a notification, the inbox): it's this board's, so it
  // opens here, as its task's drawer (or just the chat when no task has it)
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  useEffect(
    () =>
      onShowSession(project, (session) => {
        // The Superagent's main session dispatched every task: it's a task's only while that task is being dispatched
        const t = (tasksRef.current ?? []).find((x) => x.session === session || x.sessions?.includes(session) || (x.router === session && x.status === "todo" && !!x.routing));
        const live = t && t.status !== "done" && t.status !== "dropped";
        if (live && (t.session === session || (t.router === session && t.status === "todo" && t.routing))) {
          setPeek(null);
          setOpen(t.id);
        } else setPeek({ session, task: t?.id });
      }),
    [],
  );
  const onAction = (action: string) => {
    const t = sel;
    if (!t) return;
    // Done with it either way: close the chat rather than flip to the finished task's summary
    void runTaskAction(act, t, action).then((ok) => ok && closes(action) && setOpen(""));
  };

  // Dragging a card to another column: the user moving it (moveTo), the only way besides its menu and buttons.
  // Pointer events and our own floating copy, not HTML5 drag and drop: the browser's drag image is see-through by a
  // fixed amount (the board showed through it, text over text) and can't be styled. The copy has an opaque card under
  // dimmed contents; the card left behind fades.
  const [drag, setDrag] = useState<{ t: Task; x: number; y: number; dx: number; dy: number; w: number } | null>(null);
  const [dropOn, setDropOn] = useState<Col | null>(null);
  const dragging = drag?.t ?? null;
  const portal = usePortalContainer();
  const beginDrag = (t: Task, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    let on = false;
    let to: Col | null = null;
    const move = (ev: PointerEvent) => {
      // A click stays a click: it becomes a drag only once the pointer has moved a few pixels
      if (!on && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!on) {
        // No text selected along the way, and the hand closed while it holds the card
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      on = true;
      ev.preventDefault();
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-col]");
      const c = (el?.dataset.col as Col | undefined) ?? null;
      to = c && canMove(t, c) ? c : null;
      setDropOn(to);
      setDrag({ t, x: ev.clientX, y: ev.clientY, dx: x0 - r.left, dy: y0 - r.top, w: r.width });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!on) return;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      // The click that follows the release would open the card: swallowed, if it comes right away
      const eat = (ev: MouseEvent) => (ev.stopPropagation(), ev.preventDefault());
      window.addEventListener("click", eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
      setDrag(null);
      setDropOn(null);
      if (to) void moveTo(act, t.id, to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const column = (c: (typeof COLS)[number]) => {
    const all = list(c.id).filter(hit);
    const takes = !!dragging && canMove(dragging, c.id);
    // Searching: every finished one that matches, not the first 20
    const shown = c.id === "done" && !words.length ? all.slice(0, doneLimit) : all;
    const you = all.filter(waitsOnUser);
    const minutes = you.flatMap(openAsks).reduce((n, a) => n + (a.minutes ?? 0), 0);
    return (
      <section
        key={c.id}
        data-col={c.id}
        className={clsx(
          "flex min-w-60 flex-1 basis-0 flex-col rounded-xl max-md:min-w-0",
          // Every column alike: tinted columns (等你 yellow, 待验收 green) made the board loud (2026-11-19, the user:
          // 颜色克制一点). What needs the user shows on its cards and in the header's 等你 count instead
          "bg-muted/50",
          // While a card is dragged: where it can go is outlined, the one under it filled
          takes && (dropOn === c.id ? "bg-brand/10 ring-2 ring-brand/60" : "ring-1 ring-brand/30"),
        )}
      >
        <h2 className="flex items-center gap-2 px-3 pt-3 pb-2 text-[13px] font-medium">
          {c.icon}
          {c.title}
          <span className="text-[12px] font-normal tabular-nums text-muted-foreground">{all.length}</span>
          {you.length > 0 && <span className="rounded-full bg-warn px-1.5 text-[12px] font-medium text-background tabular-nums">等你 {you.length}</span>}
          {minutes > 0 && <span className="text-[11px] font-normal text-muted-foreground">· 约 {minutes} 分钟</span>}
          {c.id === "todo" && (
            <button aria-label="新任务" className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
            </button>
          )}
        </h2>
        {/* Scrolls on its own only on a wide screen: on a phone the page scrolls, and a scroller here (overflow-y makes it
            one sideways too) made every touch on the column look like one on something that scrolls sideways, so the
            swipe between columns left it alone (lib/swipe.ts skip) */}
        <div className="min-h-0 flex-1 space-y-2 px-2 pb-2 md:overflow-y-auto">
          {shown.length ? shown.map((t) => (
            <MiniCard
              key={t.id}
              t={t}
              byId={byId}
              active={t.id === open}
              onOpen={() => (setPeek(null), setOpen(t.id))}
              ghost={dragging?.id === t.id}
              onGrab={!phone && movable(t) ? (e) => beginDrag(t, e) : undefined}
              act={act}
              onActed={(id) => closes(id) && t.id === open && setOpen("")}
            />
          )) : <p className="py-6 text-center text-[12px] text-muted-foreground">{words.length ? "没有匹配的" : "无任务"}</p>}
          {all.length > shown.length && (
            <button className="w-full py-2 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setDoneLimit(doneLimit + 50)}>
              再显示 {Math.min(50, all.length - shown.length)} 个
            </button>
          )}
          {c.id === "done" && archived > 0 && all.length <= shown.length && (
            <button className="w-full py-2 text-[12px] text-muted-foreground hover:text-foreground" title="完成很久的任务移出了任务面板的数据，打开一个就放回来" onClick={() => setArchive(true)}>
              已归档 {archived} 个
            </button>
          )}
        </div>
      </section>
    );
  };

  return (
    // clip, not hidden: nothing may widen the page sideways on a phone, and hidden would break the sticky tabs
    // While a card is dragged the cards under it take no pointer: no hover outline on them as it passes (the column's
    // own outline says where it lands; elementFromPoint then finds the column through them)
    <div
      ref={pageRoot}
      className={clsx(
        "flex h-full min-h-0 flex-col [overflow-wrap:anywhere] max-md:h-auto max-md:min-h-full max-md:overflow-x-clip md:relative",
        drag && "[&_[data-task-card]]:pointer-events-none",
      )}
    >
      {/* On a phone the buttons are icons only (their words would push the header wider than the screen and squeeze
          the title into a column of letters); the counts stay */}
      {/* As tall as Gerdr's own tab bar over a Code pane (h-10, ui/src/components/TabBar.tsx), so switching between
          the two doesn't make the top edge jump; hence the small buttons */}
      <header className="flex h-10 min-w-0 shrink-0 items-center justify-between gap-3 border-b px-2 max-md:gap-1">
        {/* Left: the secretary's conversation (a drawer) and where outside messages went; right: settings, a new task.
            Until 2026-11-16 a 秘书 / 任务面板 switch sat here too, a second way into the same conversation */}
        <div className="flex shrink-0 items-center gap-1 max-md:gap-0">
          <MainButton onOpen={(id) => (setOpen(""), setPeek({ session: id }))} onAsks={setSec} />
          <Button variant="ghost" size="sm" className={clsx(phoneMenu && "max-md:hidden")} title="外面来的每条消息去了哪：交给了哪个任务、为什么没接" onClick={() => setSettings("log")}>
            <Inbox className="size-4" />
            <span className="max-md:hidden">去向</span>
          </Button>
        </div>
        <div className="flex min-w-0 items-center gap-1 max-md:gap-0">
          {find !== null ? (
            <label className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 text-[13px] focus-within:border-ring">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={findBox}
                autoFocus
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="找任务：标题、编号、仓库、内容"
                className="w-56 min-w-0 bg-transparent outline-none placeholder:text-muted-foreground max-md:w-32"
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setFind(null);
                  } else if (e.key === "Enter") {
                    // The first match in the board's order of what matters
                    const t = PHONE_ORDER.flatMap(list).find(hit);
                    if (t) (setPeek(null), setOpen(t.id));
                  }
                }}
              />
              <button aria-label="关闭搜索" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setFind(null)}>
                <X className="size-3.5" />
              </button>
            </label>
          ) : (
            <Button variant="ghost" size="icon" className="size-8" aria-label="搜索任务" title={`搜索任务（${/Mac/.test(navigator.platform) ? "⌘F" : "Ctrl+F"}）`} onClick={() => setFind("")}>
              <Search className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className={clsx("size-8", phoneMenu && "max-md:hidden")} aria-label="设置" title="设置、流程、触发器、定时任务" onClick={() => setSettings("settings")}>
            <Settings className="size-4" />
          </Button>
          <Button size="sm" onClick={() => setCreating(true)} aria-label="新任务">
            <Plus className="size-3.5" />
            <span className="max-md:hidden">新任务</span>
          </Button>
        </div>
      </header>
      {error && <p role="alert" className="px-4 pt-3 text-[13px] text-bad">读取失败：{error}</p>}
      {!tasks && !error ? (
        <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>
      ) : (
        <>
        <Alerts onLog={() => setSettings("log")} />
        <PhoneTabs cols={phoneCols} count={(c) => list(c).filter(hit).length} waitingCount={waitingCount} current={phoneCol} onPick={setPhoneTab} />
        {phone ? (
          // A phone: one column at a time, the tabs above or a swipe to the next (lib/swipe.ts)
          <div ref={pagerView} className="overflow-hidden">
            <div ref={pagerTrack} className="flex items-start">
              {phoneCols.map((c) => (
                <div key={c.id} className="w-full shrink-0 p-3">
                  {column(c)}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">{COLS.map(column)}</div>
        )}
        </>
      )}
      <Linger>{sel && !inChat && <Drawer t={sel} byId={byId} act={act} onClose={() => setOpen("")} onGo={setOpen} />}</Linger>
      <Linger>{askSel && <AskDrawer a={askSel.a} by={askSel.t} act={act} onClose={() => setOpen("")} onGo={setOpen} />}</Linger>
      <Linger>{panel && sel && viewing && view && (
        <ChatDrawer
          session={view.session}
          sub={view.sub}
          onSub={(tc) => setShown(convo(view.session, tc))}
          {...panel}
          trail={{ task: sel.id, version: sel.updatedAt, current: viewing, router: sel.router, onSession: setShown, onTask: setOpen, onRules: () => setSettings("settings") }}
          task={sel.id}
          title={sel.title}
          onRename={(title) => renameTask(act, sel, title)}
          onAction={onAction}
          onClose={() => setOpen("")}
          extra={sel.assigned && sel.assigned.state !== "ask" ? <div className="shrink-0 border-b px-3 py-2"><ReplyBox t={sel} act={act} /></div> : undefined}
        />
      )}</Linger>
      <Linger>{peek && (
        <ChatDrawer
          session={peek.session}
          sub={peek.sub}
          onSub={(tc) => setPeek({ ...peek, sub: tc ?? undefined })}
          trail={
            peek.task && byId[peek.task]
              ? {
                  task: peek.task,
                  version: byId[peek.task].updatedAt,
                  current: convo(peek.session, peek.sub),
                  router: byId[peek.task].router,
                  onSession: (id) => setPeek({ ...peek, ...parseConvo(id), sub: parseConvo(id).sub }),
                  onTask: (id) => (setPeek(null), setOpen(id)),
                  onRules: () => setSettings("settings"),
                }
              : undefined
          }
          items={sec.main && peek.session === sec.main && !peek.sub ? secItems(sec.open) : undefined}
          back={peek.from && byId[peek.from] ? { label: `回到 ${peek.from} ${byId[peek.from].title}`, onBack: () => (setPeek(null), setOpen(peek.from!)) } : undefined}
          onClose={() => setPeek(null)}
        />
      )}</Linger>
      {drag &&
        // The card being dragged, under the pointer: an opaque card with its contents dimmed, tilted a little. On
        // the panel's own portal area (as its dialogs): a transformed ancestor would shift a fixed box inside it
        createPortal(
          <div className="pointer-events-none fixed z-50" style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w }}>
            <div className="rotate-[1.5deg] rounded-lg bg-card shadow-2xl ring-1 ring-brand/50">
              <div className="opacity-60">
                <MiniCard t={drag.t} byId={byId} active={false} onOpen={() => {}} />
              </div>
            </div>
          </div>,
          portal ?? document.body,
        )}
      <Linger>{creating && <NewTask onClose={() => setCreating(false)} act={act} />}</Linger>
      {archive && <ArchiveDialog onClose={() => setArchive(false)} onOpen={(id) => void act("unarchive", { id }).then(() => (setArchive(false), setOpen(id)))} />}
      <Linger>{settings && <SettingsSheet tab={settings} onTab={setSettings} onClose={() => setSettings(null)} onTask={(id) => (setSettings(null), setOpen(id))} />}</Linger>
    </div>
  );
}

/** An agent task nobody is dispatching: the Superagent gave up on it, or it was added without starting. */
function notDispatched(t: Task) {
  return t.status === "todo" && !t.routing && !t.session;
}

type LogSummary = {
  main: { id: string; status: string; waiting?: string } | null;
  items: { id: string; at: number; state: string; rule?: string; event: { source: string; kind: string; title?: string; text?: string } }[];
};

/**
 * What the Superagent itself needs from the user, above the board: its main session asking something or failed,
 * messages it gave no decision on, what proactive work recorded today as "would have taken". Each with where to go.
 * Nothing at all while it's healthy (dsh: a healthy state takes no space). The tasks that need the user stand out
 * in the board itself (the 等你 column, cards not dispatched).
 */
function Alerts({ onLog }: { onLog: () => void }) {
  const [log, setLog] = useState<LogSummary | null>(null);
  // Reloaded when the log changes (it's written by functions: pushed), the main session's state followed live
  useRefresh(() => run<LogSummary>("superagent.log", { limit: 300 }).then(setLog, () => {}), [usePanelChange("user/data")], { poll: 10_000 });
  const m = useLiveMain(log?.main ?? null);
  const day = Date.now() - 24 * 3600_000;
  const items = log?.items ?? [];
  const unavailable = items.filter((x) => x.state === "unavailable").length;
  const observed = items.filter((x) => x.state === "observed" && x.at > day).length;
  const problems: { text: string; label: string; go: () => void }[] = [];
  if (m?.status === "waiting") problems.push({ text: `Superagent 在问你：${m.waiting ?? "去它的对话里看看"}`, label: "去回答", go: () => openChat(m.id) });
  if (m?.status === "error") problems.push({ text: "秘书的会话出错了：下一件事来时会换一个新的", label: "看看", go: () => openChat(m.id) });
  if (unavailable) problems.push({ text: `${unavailable} 条消息 Superagent 没给决定`, label: "去向", go: onLog });
  if (observed) problems.push({ text: `主动工作今天记了 ${observed} 条「本来会接」：看对不对，对的点照做`, label: "去向", go: onLog });
  if (!problems.length) return null;
  return (
    <div className="space-y-1.5 px-3 pt-3">
      {problems.map((p) => (
        <div key={p.text} className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-1.5 text-[13px]">
          <AlertTriangle className="size-3.5 shrink-0 text-warn" />
          <span className="min-w-0 flex-1">{p.text}</span>
          <Button variant="outline" onClick={p.go}>
            {p.label}
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * The Superagent's main session (local/_main.ts): the one conversation every task and outside message goes through
 * to be judged and dispatched. A button, not a column: a healthy state takes no space; it shows what it's doing
 * (deciding, asking the user) and opens its chat, to see how it decided or to tell it something.
 */
function MainButton({ onOpen, onAsks }: { onOpen: (id: string) => void; onAsks: (a: { main?: string; open: SecAsk[] }) => void }) {
  const [main, setMain] = useState<{ id: string; status: string; waiting?: string } | null>(null);
  const [asks, setAsks] = useState<SecAsk[]>([]);
  // Which session is the main one only changes with the log (pushed); its state is followed live. Its own questions
  // (local/_secask.ts) come with it: counted here, listed over its chat, their cards' states filed for cards.tsx
  useRefresh(
    () =>
      run<{ main: { id: string; status: string; waiting?: string } | null; asks?: { project: string; open: SecAsk[]; cards: Record<string, unknown> } }>("superagent.log", { limit: 1 }).then((r) => {
        setMain(r.main);
        setAsks(r.asks?.open ?? []);
        onAsks({ main: r.main?.id, open: r.asks?.open ?? [] });
        if (r.asks) fileCardStates(r.asks.project, [{ cards: r.asks.cards }]);
      }, () => {}),
    [usePanelChange("user/data")],
    { poll: 10_000 },
  );
  const m = useLiveMain(main);
  const status = m && m.status !== "gone" ? m.status : "";
  // Its questions first: a session waiting (approval) or failed is rarer, and the count says how many things wait
  const label = asks.length ? `${asks.length} 个问题` : status === "running" ? "在判断" : status === "waiting" ? "等你回答" : status === "error" ? "出错了" : "";
  // Always there: the board is the only page now, so this is the way to the secretary. None yet (or it was let go):
  // opening it starts one (secretary.open), as the 秘书 page used to on load
  const open = () => (m && status ? onOpen(m.id) : run<{ main: string }>("secretary.open", {}).then((r) => onOpen(r.main), () => {}));
  return (
    <Button variant="ghost" size="sm" title={`和秘书说话${label ? `（${label}）` : ""}：交给它的事、它怎么判断外面来的消息、派给了谁，都在这段对话里`} onClick={open}>
      <MessageSquare className="size-4" />
      <span className="max-md:hidden">秘书</span>
      {asks.length > 0 ? (
        // A count in the board's 等你 amber, shown on phones too: the questions are what the user mustn't miss
        <span className="rounded-full bg-warn px-1.5 text-[11px] leading-4 font-medium text-background tabular-nums">{asks.length}</span>
      ) : (
        <>
          {label && <span className={clsx("size-1.5 rounded-full", status === "running" ? "bg-ok" : "bg-warn")} />}
          {label && <span className="text-[11px] text-muted-foreground max-md:hidden">{label}</span>}
        </>
      )}
    </Button>
  );
}

/** One of the secretary's own open questions (local/_secask.ts). */
type SecAsk = { id: string; title: string; kind: string; at: number };

/** The secretary's open questions as rows over its chat: each jumps to its card, ✕ ignores it (as the card's ✕). */
function secItems(open: SecAsk[]): ChatItem[] {
  return open.map((a) => ({
    text: `${a.kind === "none" ? "要你做" : "待你答"}：${a.title}`,
    jump: a.id,
    onDismiss: () => run("tasks.ignore", { id: a.id }),
    dismissTitle: "忽略：不答了（多半已经过时），秘书下一轮开头会知道",
  }));
}

/** The main session as superagent.log last said, with its status / waiting as Gerdr pushes them now. */
function useLiveMain<T extends { id: string; status: string; waiting?: string }>(main: T | null): T | null {
  const live = useSessions((s) => s.id === main?.id)[0];
  return main && live ? { ...main, status: live.status, waiting: live.waiting } : main;
}

/** Opens a conversation in the drawer, from anywhere on the page (set by BoardPage). */
let openChat: (session: string, task?: string) => void = () => {};

/**
 * What its worker asked of the user and is still waiting for, one line each ("待你答：…"; no ids: the user found "t124"
 * on a question of t123 one more thing to decode, 2026-11-16): under the drawer's title and on the card, so the board
 * says what it waits for without opening it. Each jumps to its card in the chat.
 */
function userSteps(t: Task): ChatItem[] {
  return openAsks(t).flatMap((h) => {
    // Several questions in one ask: a row each (each has its card in the chat), still one thing on the board
    if (h.questions) return unanswered(h).map((q) => ({ text: `待你答：${q.title}`, jump: `${h.id}#${q.id}` }));
    const left = h.expiresAt ? (h.expiresAt > Date.now() ? `（还剩 ${Math.round((h.expiresAt - Date.now()) / 60000)} 分钟）` : "（已过期）") : "";
    // A secret is stored and an expired link redone on the board, not in the chat's card: those open the ask itself
    const board = h.handBack.kind === "secret" || (!!h.expiresAt && h.expiresAt < Date.now());
    return [{ text: `${h.handBack.kind === "choice" ? "待决定" : "要你做"}：${h.title}${left}`, jump: h.id, ...(board ? { onClick: () => openAsk(h.id) } : {}) }];
  });
}

/** Opens an ask's own drawer, from anywhere on the page (set by BoardPage). */
let openAsk: (id: string) => void = () => {};

/**
 * What its worker wrote to a chat, waiting for the user to send or not (local/outbox.ts): a row each, jumping to the
 * card in the chat. Nothing waits on them, so they don't make the task yellow; they're only listed.
 */
function outgoing(t: Task): ChatItem[] {
  if (t.status === "done" || t.status === "dropped") return [];
  return (t.outbox ?? []).filter((o) => o.state === "pending").map((o) => ({ text: `待发送 · 回给 ${o.where}：${firstLine(o.text)}`, jump: `${t.id}~${o.id}` }));
}

/** The line and buttons on a worker's conversation, with the messages it holds for the user listed under it. */
function chatPanel(t: Task, byId: Record<string, Task>): { label: string; actions: ChatAction[]; items?: ChatItem[] } {
  const p = chatPanelFor(t, byId);
  const outs = outgoing(t);
  return outs.length ? { ...p, items: [...(p.items ?? []), ...outs] } : p;
}

/** The line and buttons on a worker's conversation, by where its task stands. */
function chatPanelFor(t: Task, byId: Record<string, Task>): { label: string; actions: ChatAction[]; items?: ChatItem[] } {
  // Over: what it came to, above the conversation it came out of
  if (t.status === "done") return { label: `${t.id} · ${day(t.doneAt ?? t.updatedAt)} 完成${t.summary ? `：${t.summary}` : ""}`, actions: taskMenu(t) };
  if (t.status === "dropped") return { label: `${t.id} · 已放弃${t.summary ? `：${t.summary}` : ""}`, actions: [COPY, { ...RESTORE, kind: "primary" }] };
  const c = colOf(t);
  // Steps only the user can do that hold this task up: shown here, where they are, with a way to go and do them
  const steps = userSteps(t);
  if (steps.length)
    return {
      // A short line, then one row per thing (Gerdr draws them with a yellow edge and a jump icon): the run-on text and
      // a row of buttons left nothing readable on a phone. Each row jumps to its card in this chat.
      label: `在等你处理 ${steps.length} 件`,
      actions: taskMenu(t),
      items: steps,
    };
  if (c === "review") {
    return { label: `${t.id} · 待验收：没问题就通过；要改直接在下面说，它会接着改`, actions: [...taskMenu(t), { id: "accept", label: "通过", kind: "primary" }] };
  }
  if (c === "you")
    return {
      // Say what it is, in full: "see the last reply" made the user dig through a long answer for the question
      label: `${t.id} · 等你：${
        t.live?.status === "waiting"
          ? `它在下面等你${t.live.waiting ? `：${t.live.waiting}` : "审批或回答"}`
          : t.live?.status === "error"
            ? `出错了：${t.live.error ?? "看看最后的报错"}`
            : t.helpers?.some((k) => k.left)
              ? `它派出去的「${t.helpers.find((k) => k.left)!.title}」${t.helpers.find((k) => k.left)!.waitingKind === "ask" ? "在问，worker 没接" : "要你批准"}：${t.helpers.find((k) => k.left)!.waiting ?? "批准或回答"}。下面就是它的对话，直接在这里处理；处理完它接着跑，${t.id} 等它回报`
            : t.question
              ? `它问你：${t.question}`
              : t.stopped
                ? `${t.stopWhy ?? "停下了"}${t.said ? `。它最后说：「${t.said}」` : ""}`
                : "它在等你，见最后一条回复"
      }`,
      actions: taskMenu(t),
    };
  // In progress: what it waits on, if anything, and what will wake it — the same words as the 在等 list
  const w = (t.waits ?? []).find((x) => !x.user);
  // Stopped with nothing going on: said here, but it stays in 进行中 until the user moves it
  const halt = t.stopped ? ` · ${t.stopWhy ?? "停下了"}` : "";
  return { label: `${t.id} · 进行中${w ? ` · 在等：${w.what}（${w.wake ?? ""}）` : halt}`, actions: taskMenu(t) };
}

/** A task as a small card in its column: what it is, where, and how it's doing. Click for everything else. */
function MiniCard({
  t,
  byId,
  active,
  onOpen,
  onGrab,
  ghost,
  act,
  onActed,
}: {
  t: Task;
  byId: Record<string, Task>;
  active: boolean;
  onOpen: () => void;
  onGrab?: (e: React.PointerEvent<HTMLElement>) => void;
  ghost?: boolean;
  /** Draws the task's ⋯ menu in the top-right corner (not on the dragged copy); onActed after a row went through. */
  act?: Act;
  onActed?: (id: string) => void;
}) {
  const open = t.status !== "done" && t.status !== "dropped";
  const steps = open ? userSteps(t) : [];
  const asks = open ? openAsks(t) : [];
  // Another task it waits for (what it asks the user is spelled out above: steps)
  const blockers = (t.blockedBy ?? []).filter((b) => byId[b] && byId[b].status !== "done" && byId[b].status !== "dropped");
  const live = liveText(t);
  // Its turn over and already read (opened here or in Code): no green dot, as Code's tabs do
  const unread = useUnread(t.session);
  // What it asked that runs out soonest (a sign-in link), and roughly how long its steps take the user
  const expires = Math.min(...asks.map((a) => a.expiresAt ?? Infinity));
  const minutes = asks.reduce((n, a) => n + (a.minutes ?? 0), 0);
  return (
    // The ⋯ menu sits beside the card's button, not in it (a button can't hold one); data-task-card on the wrapper
    // too, so using the menu while a drawer is open doesn't count as a click on the board that closes it
    <div data-task-card="" className="group relative">
    <button
      data-task-card=""
      onClick={onOpen}
      onPointerDown={onGrab}
      className={clsx(
        // Its place while it's dragged: faded, the floating copy is the card
        ghost && "opacity-30",
        "block w-full space-y-1.5 rounded-lg border bg-card p-3 text-left shadow-xs transition-[border-color,box-shadow,transform] duration-150 hover:shadow-sm active:scale-[0.99]",
        // A card waiting on the user has a yellow edge (no fill: kept quiet), only brighter when hovered or open, never blue.
        // Open, the border stays as it is under the pointer: a hover: class beside it won over it (2026-11-19)
        waitsOnUser(t) ? (active ? "border-warn/80" : "border-warn/25 hover:border-warn/55") : active ? "border-ring" : "hover:border-ring/50",
      )}>
      <div className={clsx("flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground", act && "pr-6")}>
        <Bot className="size-3 shrink-0" />
        {/* Never squeezed: the live line beside it truncates instead of wrapping the id onto two lines */}
        <span className="shrink-0 font-mono whitespace-nowrap">{t.id}</span>
        {/* Its worker's state in the id line, with the dot Code mode's tabs use, so a glance down a column reads it.
            The dot says the state (在跑 / 停下 / 等你…), so only the time follows it; the words stay in the tooltip */}
        {/* Whatever column it's in: a done task's worker can still be talked to, and its dot should say so */}
        {live && (
          <span title={live} className={clsx("inline-flex min-w-0 items-center gap-1", liveTone(t) !== "text-ok" && liveTone(t))}>
            {liveDot(t, unread) && <span className={clsx("inline-block size-1.5 shrink-0 rounded-full", liveDot(t, unread))} />}
            <span className="truncate">{live.includes(" · ") ? live.slice(live.lastIndexOf(" · ") + 3) : live}</span>
          </span>
        )}
        {asks.some((a) => a.urgent) && <AlertTriangle className="size-3 shrink-0 text-warn" />}
        {expires < Infinity ? <Expiry at={expires} className="ml-auto shrink-0" /> : minutes ? <span className="ml-auto shrink-0">约 {minutes} 分钟</span> : null}
      </div>
      <p className={clsx("line-clamp-2 text-[13px] font-medium", t.status === "dropped" && "text-muted-foreground line-through")}>{t.title}</p>
      {t.question && waitsOnUser(t) && <p className="line-clamp-2 text-[12px] text-warn">{t.question}</p>}
      {steps.map((x) => (
        <p key={x.jump} className="line-clamp-2 border-l-2 border-warn pl-2 text-[12px] text-warn">
          {x.text}
        </p>
      ))}
      {outgoing(t).map((x) => (
        <p key={x.jump} className="line-clamp-2 border-l-2 border-warn/50 pl-2 text-[12px] text-muted-foreground">
          {x.text}
        </p>
      ))}
      {/* What it waits on outside, drawn like 待你答 above in the chat's wait colour (brand, cards.tsx TaskWait): grouped
          with the action bars above the worker's latest line so both structured blockers stay together (2026-11-20) */}
      {!t.question && going(t) && outside(t)[0] && <p className="line-clamp-2 border-l-2 border-brand pl-2 text-[12px] text-brand">等：{outside(t)[0].what}</p>}
      {/* Where it stands in its worker's words (the first paragraph of its last reply): the one line a card has for it.
          A worker that stopped with nothing going on is no alarm (only the user moves the card): its live line says
          停下; an unusual stop (the user's, an error, a turn cut short) is said here, quietly */}
      {!t.question && t.stopped && t.stopWhy && t.stopWhy !== "停下了" && t.stopWhy !== "回了你的话，等你接着说" && (
        <p className="line-clamp-1 text-[12px] text-muted-foreground">{t.stopWhy}</p>
      )}
      {/* Its worker's newest paragraph, live (falls back to the old summary): shimmers like 思考中 while it runs */}
      {!t.question && (t.latest || t.summary || (t.stopped && t.said)) && (
        <p className={clsx("line-clamp-2 text-[12px]", t.live?.status === "running" ? "shimmer shimmer-light text-foreground/85" : "text-muted-foreground")}>{t.latest || t.summary || t.said}</p>
      )}
      {!t.question &&
        t.helpers
          ?.filter((k) => k.status === "waiting")
          .map((k) =>
            k.left ? (
              <p key={k.id} className="line-clamp-3 text-[12px] text-warn">
                「{k.title || k.id}」{k.waitingKind === "ask" ? "在问（worker 没接）" : "要你批准"}：{k.waiting ?? "批准或回答"}
              </p>
            ) : (
              <p key={k.id} className="line-clamp-2 text-[12px] text-muted-foreground">
                「{k.title || k.id}」在问 worker，它来判断
              </p>
            ),
          )}
      {(t.repo || t.agent || t.model || t.from || t.origin || blockers.length > 0 || !!t.helpers?.length) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          {t.repo && <span>{t.repo.split("/").pop()}</span>}
          {(t.agent || t.model) && <span>· {[t.agent, t.model].filter(Boolean).join(" / ")}</span>}
        {t.from && <span>· 拆自 {t.from}</span>}
          {/* An outside message it came from (a chat, an MR): which, so a card waiting under 待办 to be looked at says so */}
          {t.origin && <span className="text-brand">· 来自 {t.origin.source}</span>}
          {outside(t)
            .filter((w) => w.url)
            .map((w) => (
              // What it waits on, when that has a page (an MR): a span, not <a> — the card is a <button>
              <span
                key={w.id}
                role="link"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(w.url, "_blank", "noreferrer");
                }}
                className="inline-flex items-center gap-1 rounded-sm bg-brand/10 px-1 text-brand hover:underline"
              >
                <ExternalLink className="size-3" />
                {w.where ?? "打开"}
              </span>
            ))}
          {blockers.map((b) => (
            <span key={b} className="rounded-sm bg-warn/10 px-1 text-warn">
              等 {b}
            </span>
          ))}
          {t.helpers?.map((k) => (
            // A session its worker handed work to and waits on: a click opens it (a span: the card is a <button>)
            <span
              key={k.id}
              role="link"
              title={k.status === "waiting" ? `在等你：${k.waiting ?? "批准或回答"}` : "它派出去的会话，还在跑"}
              onClick={(e) => {
                e.stopPropagation();
                openChat(k.id, t.id);
              }}
              className={clsx("max-w-full truncate rounded-sm px-1 hover:underline", k.status === "waiting" ? "bg-warn/10 text-warn" : "bg-brand/10 text-brand")}
            >
              等 {k.title || k.id}
            </span>
          ))}
        </div>
      )}
    </button>
    {act && (
      // Shown on hover / when open with a mouse; always on a touch screen (no hover there)
      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100">
        <TaskMenu t={t} act={act} onDone={onActed} />
      </div>
    )}
    </div>
  );
}

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

function liveTone(t: Task) {
  if (notDispatched(t)) return "text-warn";
  const l = t.live;
  const stale = l?.status === "running" && l.turnStartedAt && Date.now() - l.turnStartedAt > 40 * 60000;
  return l?.status === "waiting" || l?.status === "error" || stale ? "text-warn" : l?.status === "running" ? "text-ok" : "";
}

/** The dot beside its live text, coloured as Code mode's session dots (AgentIcon StatusDot): running yellow, waiting
 *  on the user / errored red, still busy in the background grey, its turn over green while unread — none once read. */
function liveDot(t: Task, unread: boolean) {
  const l = t.live;
  if (!l) return notDispatched(t) ? "bg-warn" : "bg-muted-foreground/40";
  if (l.status === "running") return "bg-warn animate-pulse";
  if (l.status === "waiting") return "bg-bad animate-pulse";
  if (l.status === "error") return "bg-bad";
  if (t.helpers?.length || (t.waits ?? []).some((w) => w.kind === "agent") || (going(t) && outside(t).length)) return "bg-muted-foreground";
  return unread ? "bg-ok" : "";
}

/** Gerdr's unread mark of a conversation (core useUnread); an older Gerdr has none: always unread, the dot as before. */
const useUnread = ((core as any).useUnread ?? ((_: string | undefined) => true)) as (id: string | undefined) => boolean;

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
  const [text, setText] = useState("");
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
  const quote = useRef<HTMLParagraphElement>(null);
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
            <p ref={quote} className={clsx(txt, "leading-relaxed whitespace-pre-wrap text-muted-foreground", !open && "line-clamp-[8]")}>
              {t.prompt ?? t.title}
            </p>
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
      {t.question && (
        <div className="space-y-2 rounded-md border border-warn/40 bg-warn/5 p-3">
          <p className="text-[13px] whitespace-pre-wrap">{t.question}</p>
          <div className="flex gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="你的决定 / 回复" className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]" />
            <Button disabled={!text.trim() || !!busy} onClick={async () => (await go("answer", "answer", { id: t.id, answer: text })) && setText("")}>
              {busy === "answer" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}回复
            </Button>
          </div>
          {t.session && (
            <button className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => openChat(t.session!, t.id)}>
              <Paperclip className="size-3" />
              要发图片、文件或者多说几句：在对话里回复
            </button>
          )}
        </div>
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
            <Button className="h-9 shrink-0" disabled={stepBusy || (!quoted && !draft.trim())} onClick={async () => (await save()) && go("start", "start", { id: t.id, ...(t.canReply ? { reply } : {}) })}>
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
            <Button className="h-9" disabled={stepBusy} onClick={async () => (await save()) && go("start", "start", { id: t.id, ...(t.canReply ? { reply } : {}) })}>
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

/** An ask's questions still waiting for an answer. */
function unanswered(a: Ask) {
  return (a.questions ?? []).filter((q) => !q.dropped && !q.answer);
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

function DoneDetail({ t, act }: { t: Task; act?: Act }) {
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
        <div className="flex justify-end gap-2">
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

type Archived = { root: string; doneAt: number; tasks: { id: string; title: string; status: string; doneAt?: number; summary?: string }[] };

/**
 * Requirements finished long ago (local/_archive.ts, 设置 → 归档): searchable; opening one puts it back under 已完成
 * (it's archived again an hour or so later if nothing happens to it).
 */
function ArchiveDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [r, setR] = useState<{ groups: Archived[]; total: number } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const t = setTimeout(() => void run<{ groups: Archived[]; total: number }>("tasks.archived", { q }).then(setR, (e) => setErr(String(e?.message ?? e))), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} className="flex max-h-[80dvh] w-full flex-col gap-3 p-4 sm:max-w-xl">
        <div className="flex items-center justify-between">
          <DialogTitle className="text-[15px] font-medium">已归档{r ? ` · ${r.total}` : ""}</DialogTitle>
          <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <input className="h-8 rounded-md border bg-background px-2.5 text-[13px] outline-none focus:ring-1 focus:ring-ring" placeholder="搜编号、标题、结果、仓库" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {err && <p className="py-4 text-center text-[12px] text-bad">{err}</p>}
          {r && !r.groups.length && <p className="py-6 text-center text-[12px] text-muted-foreground">没有</p>}
          {r?.groups.map((g) => {
            const root = g.tasks.find((t) => t.id === g.root) ?? g.tasks[0];
            const more = g.tasks.length - 1;
            return (
              <button key={g.root} className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-accent" onClick={() => onOpen(g.root)}>
                <div className="flex items-baseline gap-2 text-[13px]">
                  <span className="shrink-0 tabular-nums text-muted-foreground">{root.id}</span>
                  <span className={clsx("min-w-0 flex-1 truncate", root.status === "dropped" && "text-muted-foreground line-through")}>{root.title}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{day(g.doneAt)}</span>
                </div>
                {(root.summary || more > 0) && (
                  <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">
                    {more > 0 ? `${more + 1} 个成员 · ` : ""}
                    {root.summary}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
