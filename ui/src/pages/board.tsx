import { AlertTriangle, ArrowRight, Bot, Users, Inbox, Check, CheckCircle2, Circle, CircleDashed, CircleDot, CircleHelp, ListTodo, ExternalLink, Hand, KeyRound, Loader2, MessageSquare, Paperclip, Plus, Send, Settings, Undo2, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet";
import { AttachmentBar, useAttach, type Attachment } from "../components/Attachments";
import { askSecret, secretNames } from "../lib/bridge";
import { ChatDrawer, type ChatAction, type ChatItem } from "../components/ChatDrawer";
import { Trail } from "../components/Trail";
import { Linger } from "../lib/linger";
import { SettingsSheet, TABS, type SettingsTab } from "../components/SettingsSheet";
import { phoneMenu, usePhoneMenu } from "../lib/phoneMenu";
import { ago, day, since, type Task, useTasks, waitedSince } from "../lib/tasks";
import { project, run } from "../lib/gerdr";
import { onShowSession } from "@gerdr/core";
import { isSubmitEnter } from "../lib/utils";
import { Md } from "../lib/markdown";
import { usePhone, useSwipePages } from "../lib/swipe";
import { convo, parseConvo } from "../lib/convo";
import { usePanelChange, useRefresh, useSessions } from "../lib/visible";

// The task board: columns left to right (to do, running, needs you, to review, done), small cards, details in a side
// panel. Columns are worked out from facts (task status, the worker session's state, blockers), never dragged: a
// dragged card would disagree with what the worker is actually doing.

type Col = "todo" | "active" | "you" | "review" | "done";

const COLS: { id: Col; title: string; icon: React.ReactNode }[] = [
  { id: "todo", title: "待办", icon: <Circle className="size-3.5 text-muted-foreground" /> },
  { id: "active", title: "进行中", icon: <CircleDashed className="size-3.5 text-brand" /> },
  { id: "you", title: "等你", icon: <AlertTriangle className="size-3.5 text-warn" /> },
  { id: "review", title: "待验收", icon: <CircleDot className="size-3.5 text-ok" /> },
  { id: "done", title: "已完成", icon: <CheckCircle2 className="size-3.5 text-muted-foreground" /> },
];

/** Most important first: what waits on the user, then results to judge, then what's going on. */
const PHONE_ORDER: Col[] = ["you", "review", "active", "todo", "done"];

/**
 * The columns as tabs, on a phone only: colour and count on each, the ones with nothing in them dimmed. Sideways
 * scrolling between columns was awkward on a phone (the user, 2026-11-05); a swipe on the column turns to the next
 * tab, like Gerdr's own phone overview (lib/swipe.ts).
 */
function PhoneTabs({ cols, count, current, onPick }: { cols: typeof COLS; count: (c: Col) => number; current: Col; onPick: (c: Col) => void }) {
  return (
    <div role="tablist" className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b bg-background px-2 py-1.5 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">
      {cols.map((c) => {
        const n = count(c.id);
        const on = c.id === current;
        const loud = n > 0 && (c.id === "you" || c.id === "review");
        return (
          <button
            key={c.id}
            role="tab"
            aria-selected={on}
            onClick={() => onPick(c.id)}
            className={clsx(
              "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[13px]",
              on ? "bg-accent font-medium text-foreground" : n ? "text-foreground" : "text-muted-foreground/60",
              loud && !on && (c.id === "you" ? "bg-warn/10" : "bg-ok/10"),
            )}
          >
            {c.icon}
            {c.title}
            <span className={clsx("tabular-nums text-[11px]", n && c.id === "you" ? "rounded-full bg-warn px-1.5 font-medium text-background" : "text-muted-foreground")}>{n}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The board's column: tasks.ts says you / review / active / done; "active" is split into not started yet and running. */
function colOf(t: Task): Col {
  // A requirement with members: where the most pressing of them is (any waiting on the user → 等你)
  const c = t.teamColumn ?? t.column;
  if (c === "active" && (t.status === "todo" || (t.owner === "human" && !t.ready))) return "todo";
  return c;
}

/** A requirement worked on by several members: one card, its feed in a drawer of its own (TeamDrawer). */
function isTeam(t?: Task) {
  return !!t && (t.members?.length ?? 0) > 1;
}

export default function BoardPage() {
  const { tasks, error, act } = useTasks();
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  // On a phone Gerdr's ☰ drawer holds what the header has no room for: the settings sheet's pages, one row each
  usePhoneMenu(TABS.map((x) => ({ id: x.id, label: x.label, icon: <x.icon className="size-4" />, onSelect: () => setSettings(x.id) })))
  const [open, setOpen] = useState("");
  const [doneLimit, setDoneLimit] = useState(20);
  const byId = Object.fromEntries((tasks ?? []).map((t) => [t.id, t]));
  const list = (c: Col) => {
    // Members of a requirement and the steps they asked for are in its card, not cards of their own
    const l = (tasks ?? []).filter((t) => !t.in && colOf(t) === c);
    if (c === "done") return l.sort((a, b) => Number(a.status === "dropped") - Number(b.status === "dropped") || (b.doneAt ?? 0) - (a.doneAt ?? 0));
    // Newest first, like the other columns, by the time each card shows
    if (c === "you") return l.sort((a, b) => waitedSince(b) - waitedSince(a));
    return l.sort((a, b) => b.updatedAt - a.updatedAt);
  };
  // On a phone: one column, by tabs in order of what matters most to the user. It opens on the first of them that has
  // anything in it (an empty 等你 is good news, not a page to land on), until they pick one themselves.
  const [phoneTab, setPhoneTab] = useState<Col | null>(null);
  const phoneCols = PHONE_ORDER.map((id) => COLS.find((c) => c.id === id)!);
  const phoneCol: Col = phoneTab ?? PHONE_ORDER.find((c) => list(c).length > 0) ?? "you";
  const phone = usePhone();
  const pagerView = useRef<HTMLDivElement>(null);
  const pagerTrack = useRef<HTMLDivElement>(null);
  const pageRoot = useRef<HTMLDivElement>(null);
  useSwipePages(pagerView, pagerTrack, PHONE_ORDER.indexOf(phoneCol), phone ? PHONE_ORDER.length : 0, (i) => setPhoneTab(PHONE_ORDER[i]), pageRoot);
  const sel = open ? byId[open] : undefined;
  // An agent task with a worker opens as its conversation (Gerdr's chat in our drawer): the whole chat to decide
  // from, and its input box for the answer. Everything else (to do, human tasks, finished ones) in our own panel.
  // Still being handed out: it opens as the routing conversation, live, so the user sees how it's deciding and can
  // put it right
  const routingNow = !!sel && sel.owner === "agent" && sel.status === "todo" && !!sel.routing && !!sel.router;
  // A requirement with members opens as its activity feed; each member's chat is one click from there
  const inChat = !!sel && !isTeam(sel) && sel.owner === "agent" && ((!!sel.session && sel.status !== "done" && sel.status !== "dropped") || routingNow);
  // A session its worker handed work to is asking the user something: that's where the answer goes, so it opens
  // first (the 链路 above leads back to the worker)
  const asking = sel?.status === "running" ? sel.helpers?.find((k) => k.status === "waiting" && k.left) : undefined;
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
          : { label: viewing === sel.router ? `Superagent 的调度会话：它派 ${sel.id} 时怎么判断的。以后都不想这样派，就改「设置」里的仓库、模型，或「流程」里的派活规则` : `${sel.id} 背后的另一个对话`, actions: [] }
        : routingNow
          ? { label: `Superagent 正在派 ${sel.id}：挑仓库、agent 和模型。看到不对直接在下面纠正`, actions: [{ id: "drop", label: "放弃", confirm: "确定放弃？" } as ChatAction] }
          : chatPanel(sel, byId)
      : null;
  // A conversation opened from a panel ("回到 tN 的对话", a finished task's chat): the chat alone, over the panel,
  // with its task's 链路 when it has one
  const [peek, setPeek] = useState<{ session: string; task?: string; sub?: string } | null>(null);
  // Opening a conversation from a task's panel closes the panel: it sat on top and hid the chat (on a phone, all of it)
  openChat = (session: string, task?: string) => {
    setOpen("");
    setPeek({ session, task });
  };
  // A worker's conversation brought up from elsewhere in Gerdr (a notification, the inbox): it's this board's, so it
  // opens here, as its task's drawer (or just the chat when no task has it)
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  useEffect(
    () =>
      onShowSession(project, (session) => {
        // The Superagent's main session dispatched every task: it's a task's only while that task is being dispatched
        const t = (tasksRef.current ?? []).find((x) => x.session === session || x.sessions?.includes(session) || (x.router === session && x.status === "todo" && !!x.routing));
        const live = t && t.owner === "agent" && t.status !== "done" && t.status !== "dropped";
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
    if (action === "accept" || action === "drop") void act(action, { id: t.id }).then(() => setOpen(""));
    // A human step it's waiting for: leave the chat for that task's own panel (its steps, what to hand back)
    if (action.startsWith("human:")) return setOpen(action.slice(6));
  };

  const column = (c: (typeof COLS)[number]) => {
    const all = list(c.id);
    const shown = c.id === "done" ? all.slice(0, doneLimit) : all;
    const minutes = c.id === "you" ? all.filter((t) => t.owner === "human").reduce((n, t) => n + (t.minutes ?? 0), 0) : 0;
    return (
      <section
        key={c.id}
        className={clsx(
          "flex min-w-60 flex-1 basis-0 flex-col rounded-xl max-md:min-w-0",
          // What needs the user stands out in the board itself: 等你 with anything in it, 待验收 a little
          c.id === "you" && all.length ? "bg-warn/10 ring-1 ring-warn/40" : c.id === "review" && all.length ? "bg-ok/5 ring-1 ring-ok/30" : "bg-muted/50",
        )}
      >
        <h2 className="flex items-center gap-2 px-3 pt-3 pb-2 text-[13px] font-medium">
          {c.icon}
          {c.title}
          <span className={clsx("text-[12px] tabular-nums", c.id === "you" && all.length ? "rounded-full bg-warn px-1.5 font-medium text-background" : "font-normal text-muted-foreground")}>{all.length}</span>
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
          {shown.length ? shown.map((t) => isTeam(t) ? <TeamCard key={t.id} t={t} tasks={tasks ?? []} active={t.id === open} onOpen={() => (setPeek(null), setOpen(t.id))} /> : <MiniCard key={t.id} t={t} byId={byId} active={t.id === open} onOpen={() => (setPeek(null), setOpen(t.id))} />) : <p className="py-6 text-center text-[12px] text-muted-foreground">无任务</p>}
          {all.length > shown.length && (
            <button className="w-full py-2 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setDoneLimit(doneLimit + 50)}>
              再显示 {Math.min(50, all.length - shown.length)} 个
            </button>
          )}
        </div>
      </section>
    );
  };

  return (
    // clip, not hidden: nothing may widen the page sideways on a phone, and hidden would break the sticky tabs
    <div ref={pageRoot} className="flex h-full min-h-0 flex-col [overflow-wrap:anywhere] max-md:h-auto max-md:min-h-full max-md:overflow-x-clip md:relative">
      {/* On a phone the buttons are icons only (their words would push the header wider than the screen and squeeze
          the title into a column of letters); the counts stay */}
      <header className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-2.5 max-md:gap-1 max-md:px-3">
        <div className="flex shrink-0 items-center gap-3">
          <h1 className="flex items-center gap-2 text-[14px] font-medium whitespace-nowrap">
            <ListTodo className="size-4 text-muted-foreground" />
            Superagent
          </h1>
        </div>
        <div className="flex min-w-0 items-center gap-1 max-md:gap-0">
          <MainButton onOpen={(id) => (setOpen(""), setPeek({ session: id }))} />
          <Button variant="ghost" size="sm" className={clsx(phoneMenu && "max-md:hidden")} title="外面来的每条消息去了哪：交给了哪个任务、为什么没接" onClick={() => setSettings("log")}>
            <Inbox className="size-4" />
            <span className="max-md:hidden">去向</span>
          </Button>
          <Button variant="ghost" size="icon" className={clsx(phoneMenu && "max-md:hidden")} aria-label="设置" title="设置、流程、触发器、定时任务" onClick={() => setSettings("settings")}>
            <Settings className="size-4" />
          </Button>
          <Button onClick={() => setCreating(true)} aria-label="新任务">
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
        <PhoneTabs cols={phoneCols} count={(c) => list(c).length} current={phoneCol} onPick={setPhoneTab} />
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
      <Linger>{sel && isTeam(sel) && <TeamDrawer t={sel} tasks={tasks ?? []} byId={byId} act={act} onClose={() => setOpen("")} onGo={setOpen} />}</Linger>
      <Linger>{sel && !inChat && !isTeam(sel) && <Drawer t={sel} byId={byId} act={act} onClose={() => setOpen("")} onGo={setOpen} />}</Linger>
      <Linger>{panel && sel && viewing && view && !peek && (
        <ChatDrawer
          session={view.session}
          sub={view.sub}
          onSub={(tc) => setShown(convo(view.session, tc))}
          {...panel}
          trail={{ task: sel.id, version: sel.updatedAt, current: viewing, router: sel.router, onSession: setShown, onTask: setOpen, onRules: () => setSettings("settings") }}
          onAction={onAction}
          onClose={() => setOpen("")}
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
          onClose={() => setPeek(null)}
        />
      )}</Linger>
      <Linger>{creating && <NewTask onClose={() => setCreating(false)} act={act} />}</Linger>
      <Linger>{settings && <SettingsSheet tab={settings} onTab={setSettings} onClose={() => setSettings(null)} onTask={(id) => (setSettings(null), setOpen(id))} />}</Linger>
    </div>
  );
}

/** An agent task nobody is dispatching: the Superagent gave up on it, or it was added without starting. */
function notDispatched(t: Task) {
  return t.owner === "agent" && t.status === "todo" && !t.routing && !t.session;
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
  if (m?.status === "error") problems.push({ text: "Superagent 的调度会话出错了：下一件事来时会换一个新的", label: "看看", go: () => openChat(m.id) });
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
function MainButton({ onOpen }: { onOpen: (id: string) => void }) {
  const [main, setMain] = useState<{ id: string; status: string; waiting?: string } | null>(null);
  // Which session is the main one only changes with the log (pushed); its state is followed live
  useRefresh(
    () => run<{ main: { id: string; status: string; waiting?: string } | null }>("superagent.log", { limit: 1 }).then((r) => setMain(r.main), () => {}),
    [usePanelChange("user/data")],
    { poll: 10_000 },
  );
  const m = useLiveMain(main);
  if (!m || m.status === "gone") return null;
  const label = m.status === "running" ? "在判断" : m.status === "waiting" ? "等你回答" : m.status === "error" ? "出错了" : "空闲";
  return (
    <Button variant="ghost" size="sm" title={`Superagent 的调度会话（${label}）：它怎么判断、派给谁，都在这里`} onClick={() => onOpen(m.id)}>
      <span className={clsx("size-1.5 rounded-full", m.status === "running" ? "bg-ok" : m.status === "waiting" || m.status === "error" ? "bg-warn" : "bg-muted-foreground/40")} />
      <span className="max-md:hidden">调度</span>
      {m.status !== "idle" && <span className="text-[11px] text-muted-foreground max-md:hidden">{label}</span>}
    </Button>
  );
}

/** The main session as superagent.log last said, with its status / waiting as Gerdr pushes them now. */
function useLiveMain<T extends { id: string; status: string; waiting?: string }>(main: T | null): T | null {
  const live = useSessions((s) => s.id === main?.id)[0];
  return main && live ? { ...main, status: live.status, waiting: live.waiting } : main;
}

/** Opens a conversation in the drawer, from anywhere on the page (set by BoardPage). */
let openChat: (session: string, task?: string) => void = () => {};

/** The line and buttons on a worker's conversation, by where its task stands. */
function chatPanel(t: Task, byId: Record<string, Task>): { label: string; actions: ChatAction[]; items?: ChatItem[] } {
  const drop: ChatAction = { id: "drop", label: "放弃", confirm: "确定放弃？" };
  // The user finished it themselves, or it's good enough as it is: done, whatever the worker last reported
  const done: ChatAction = { id: "accept", label: "标为完成", confirm: "确定完成？" };
  const c = colOf(t);
  // Steps only the user can do that hold this task up: shown here, where they are, with a way to go and do them
  const mine = (t.blockedBy ?? []).map((id) => byId[id]).filter((h) => h && h.owner === "human" && h.status !== "done" && h.status !== "dropped");
  if (mine.length)
    return {
      // A short line, then one row per thing (Gerdr draws them with a yellow edge and a jump icon): the run-on text and
      // a row of buttons left nothing readable on a phone. Each row jumps to its card in this chat.
      label: `${t.id} 在等你处理 ${mine.reduce((n, h) => n + (h.questions ? unanswered(h).length : 1), 0)} 件`,
      actions: [drop, done],
      items: mine.flatMap((h) => {
        // Several questions in one item: a row each (each has its card in the chat), still one thing on the board
        if (h.questions) return unanswered(h).map((q) => ({ text: `${h.id} 待你答：${q.title}`, jump: `${h.id}#${q.id}` }));
        const left = h.expiresAt ? (h.expiresAt > Date.now() ? `（还剩 ${Math.round((h.expiresAt - Date.now()) / 60000)} 分钟）` : "（已过期）") : "";
        return [{ text: `${h.id} ${h.handBack?.kind === "choice" ? "待决定" : "要你做"}：${h.title}${left}`, jump: h.id }];
      }),
    };
  if (c === "review") {
    return { label: `${t.id} · 待验收：没问题就通过；要改直接在下面说，它会接着改`, actions: [drop, { id: "accept", label: "通过", kind: "primary" }] };
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
                ? `停下了，没在看板上说接下来要什么${(t.nudges ?? 0) > 0 ? "（已提醒它补上）" : ""}${t.said ? `。它最后说：「${t.said}」` : ""}`
                : "它在等你，见最后一条回复"
      }`,
      actions: [drop, done],
    };
  // In progress: what it waits on, if anything, and what will wake it — the same words as the 在等 list
  const w = (t.waits ?? []).find((x) => !x.user);
  return { label: `${t.id} · 进行中${w ? ` · 在等：${w.what}（${w.wake ?? ""}）` : ""}`, actions: [drop, done] };
}

/** A task as a small card in its column: what it is, where, and how it's doing. Click for everything else. */
function MiniCard({ t, byId, active, onOpen }: { t: Task; byId: Record<string, Task>; active: boolean; onOpen: () => void }) {
  const blockers = (t.blockedBy ?? []).filter((b) => byId[b] && byId[b].status !== "done" && byId[b].status !== "dropped");
  const live = t.owner === "agent" ? liveText(t) : "";
  // A human step / question: the agent task that asked for it, when its conversation can be opened
  const by = t.owner === "human" ? (t.askedBy && byId[t.askedBy]) || Object.values(byId).find((x) => x.owner === "agent" && x.blockedBy?.includes(t.id)) : undefined;
  const asker = by?.session ? by : undefined;
  // When a human item came in, so every card under 等你 carries a time (an agent card has it in its live text)
  const open = t.status !== "done" && t.status !== "dropped";
  const asked = t.owner === "human" && open ? `${ago(t.createdAt)}${t.handBack?.kind === "choice" || t.questions ? "问的" : "交给你"}` : "";
  return (
    <button data-task-card="" onClick={onOpen} className={clsx("block w-full space-y-1.5 rounded-lg border bg-card p-3 text-left shadow-xs transition-[border-color,box-shadow,transform] duration-150 hover:border-ring/50 hover:shadow-sm active:scale-[0.99]", active ? "border-ring" : notDispatched(t) && "border-warn/60")}>
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground">
        {t.owner === "human" ? t.handBack?.kind === "choice" ? <CircleHelp className="size-3 shrink-0" /> : <Hand className="size-3 shrink-0" /> : <Bot className="size-3 shrink-0" />}
        {/* Never squeezed: a long "asked by" beside it truncates instead of wrapping the id onto two lines */}
        <span className="shrink-0 font-mono whitespace-nowrap">{t.id}</span>
        {t.urgent && <AlertTriangle className="size-3 shrink-0 text-warn" />}
        {asker && (
          // Where it came from, in the card's own line: the task whose worker asked it, a click opening that
          // conversation (the context for answering). A span, not a button: the card is a <button> already.
          <span
            role="link"
            title={`${asker.id} ${asker.title}：打开它的对话`}
            onClick={(e) => {
              e.stopPropagation();
              openChat(asker.session!, asker.id);
            }}
            className="inline-flex min-w-0 items-center gap-1 rounded-sm px-1 hover:bg-accent hover:text-foreground"
          >
            <MessageSquare className="size-3 shrink-0" />
            <span className="shrink-0 font-mono">{asker.id}</span>
            <span className="min-w-0 truncate">{asker.title}</span>
          </span>
        )}
        {t.expiresAt && t.status !== "done" && t.status !== "dropped" ? (
          <Expiry at={t.expiresAt} className="ml-auto shrink-0" />
        ) : t.minutes ? (
          <span className="ml-auto shrink-0">约 {t.minutes} 分钟</span>
        ) : null}
      </div>
      <p className={clsx("line-clamp-2 text-[13px] font-medium", t.status === "dropped" && "text-muted-foreground line-through")}>{t.title}</p>
      {t.question && colOf(t) === "you" && <p className="line-clamp-2 text-[12px] text-warn">{t.question}</p>}
      {!t.question && t.stopped && <p className="line-clamp-2 text-[12px] text-warn">停下了{t.said ? `：${t.said}` : "，没说接下来要什么"}</p>}
      {!t.question && t.status === "running" && outside(t)[0] && <p className="line-clamp-2 text-[12px] text-muted-foreground">等：{outside(t)[0].what}</p>}
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
      {t.questions && t.status === "todo" && (
        <p className="text-[12px] text-warn">
          {unanswered(t).length ? `${unanswered(t).length} 个问题要你答` : "都答了"}
          {(t.questions ?? []).filter((q) => !q.dropped).length > 1 && ` · 共 ${(t.questions ?? []).filter((q) => !q.dropped).length} 个`}
        </p>
      )}
      {(t.repo || live || asked || blockers.length > 0 || !!t.helpers?.length) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          {t.repo && <span>{t.repo.split("/").pop()}</span>}
          {asked && <span>{asked}</span>}
          {(t.agent || t.model) && <span>· {[t.agent, t.model].filter(Boolean).join(" / ")}</span>}
        {t.from && <span>· 拆自 {t.from}</span>}
          {live && t.status !== "done" && t.status !== "dropped" && <span className={clsx("inline-flex items-center gap-1", liveTone(t))}>· {live}</span>}
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
              {t.owner === "human" ? <Hand className="size-3.5" /> : <Bot className="size-3.5" />}
              <span className="font-mono">{t.id}</span>
              <span>· {COLS.find((c) => c.id === colOf(t))?.title}</span>
              <span className="ml-auto" />
              {toggle}
              <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}>
                <X className="size-4" />
              </Button>
            </div>
          );
          return t.owner === "agent" ? <Trail header={header} task={t.id} version={t.updatedAt} onSession={(id) => openChat(id, t.id)} onTask={onGo} /> : header(null);
        })()}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{done && !(t.questions && t.status === "done") ? <DoneDetail t={t} act={act} /> : t.owner === "human" ? <HumanCard key={t.id} t={t} byId={byId} act={act} onGo={onGo} /> : <AgentCard key={t.id} t={t} byId={byId} act={act} />}</div>
      </SheetContent>
    </Sheet>
  );
}

type Act = (fn: string, input: unknown) => Promise<unknown>;

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

function Card({ children }: { t: Task; icon: React.ReactNode; children: React.ReactNode }) {
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
            <a href={l.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:underline">
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
  const out = t.status === "running" ? outside(t) : [];
  if (out.length) {
    const at = out.find((w) => w.kind === "time")?.at;
    return at && at > Date.now() && !out.some((w) => w.kind === "reply") ? `等外面 · ${Math.max(1, Math.round((at - Date.now()) / 60000))} 分钟后回来看` : `等回复 · ${ago(out[0].since)}`;
  }
  return `停下 · ${ago(l.updatedAt)}`;
}

function AgentCard({ t, byId, act }: { t: Task; byId: Record<string, Task>; act: Act }) {
  const { busy, err, go } = useAction(act);
  const [text, setText] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const l = t.live;
  const stale = l?.status === "running" && l.turnStartedAt && Date.now() - l.turnStartedAt > 40 * 60000;
  const tone = l?.status === "waiting" || l?.status === "error" || stale ? "text-warn" : l?.status === "running" ? "text-ok" : "text-muted-foreground";
  return (
    <Card t={t} icon={<Bot className="size-4" />}>
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
      {t.prompt && (
        <details className="text-[12px] text-muted-foreground" open={!t.summary}>
          <summary className="cursor-pointer">派活时的说明</summary>
          <p className="mt-1 whitespace-pre-wrap">{t.prompt}</p>
        </details>
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
      {rejecting && (
        <div className="flex gap-2">
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="哪里不对，要怎么改" className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]" />
          <Button disabled={!text.trim() || !!busy} onClick={async () => (await go("reject", "reject", { id: t.id, feedback: text })) && (setText(""), setRejecting(false))}>
            {busy === "reject" ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}打回
          </Button>
          <Button variant="ghost" size="icon" aria-label="取消" onClick={() => setRejecting(false)}>
            <X className="size-4" />
          </Button>
        </div>
      )}
      {rejecting && t.session && (
        <button className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => openChat(t.session!, t.id)}>
          <Paperclip className="size-3" />
          要附截图：在对话里说哪里不对
        </button>
      )}
      {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {t.status === "todo" && !t.routing && (
          <Button disabled={!!busy} onClick={() => go("start", "start", { id: t.id })}>
            {busy === "start" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}派出去
          </Button>
        )}
        {t.status === "review" && !rejecting && (
          <>
            <Button variant="outline" disabled={!!busy} onClick={() => setRejecting(true)}>
              <Undo2 className="size-3.5" />
              打回
            </Button>
            <Button disabled={!!busy} onClick={() => go("accept", "accept", { id: t.id })}>
              {busy === "accept" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}通过
            </Button>
          </>
        )}
        {t.status !== "review" && (
          <>
            <DropButton busy={!!busy} onDrop={() => go("drop", "drop", { id: t.id })} />
            <Button variant="outline" disabled={!!busy} onClick={() => go("accept", "accept", { id: t.id })}>
              <Check className="size-3.5" />
              标为完成
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

function HumanCard({ t, byId, act, onGo }: { t: Task; byId: Record<string, Task>; act: Act; onGo: (id: string) => void }) {
  const { busy, err, go } = useAction(act);
  const [value, setValue] = useState("");
  const [secretAsked, setSecretAsked] = useState(false);
  const [saved, setSaved] = useState(false);
  const kind = t.handBack?.kind ?? "none";
  // A secret task can only be completed once the secret exists (or, on an old Gerdr, once the user says they ran the command)
  useEffect(() => {
    if (kind === "secret" && t.handBack?.name) secretNames().then((n) => setSaved(n.includes(t.handBack!.name!)), () => {});
  }, [kind, t.handBack?.name, secretAsked]);
  const blocks = Object.values(byId).filter((x) => x.blockedBy?.includes(t.id) && x.status !== "done" && x.status !== "dropped");
  const complete = (v?: string) => go("complete", "complete", { id: t.id, value: v ?? (kind === "value" || kind === "choice" ? value : undefined) });
  if (kind === "questions") return <Questions t={t} byId={byId} act={act} onGo={onGo} />;
  if (kind === "choice") return <Decision t={t} byId={byId} busy={busy} err={err} onPick={complete} onDrop={() => go("drop", "drop", { id: t.id })} onGo={onGo} />;
  return (
    <Card t={t} icon={<Hand className="size-4" />}>
      <BackToChat t={t} byId={byId} onGo={onGo} />
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[14px] font-medium">
          {t.urgent && <AlertTriangle className="mr-1 inline size-3.5 text-warn" />}
          {t.title}
        </h3>
        {t.expiresAt ? <Expiry at={t.expiresAt} className="shrink-0 text-[12px]" /> : t.minutes ? <span className="shrink-0 text-[12px] text-muted-foreground">约 {t.minutes} 分钟</span> : null}
      </div>
      <Meta t={t} byId={byId} extra={blocks.length ? <span>· 挡着 {blocks.map((b) => `${b.id} ${b.title}`).join("、")}</span> : undefined} />
      {t.steps && <Steps text={t.steps} />}
      {t.verify && <p className="text-[12px] text-muted-foreground">做完后 agent 会核验：{t.verify}</p>}
      {t.ready ? (
        <div className="space-y-2">
          {kind === "value" && (
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={`交回：${t.handBack?.label || "一个值"}（不要填密码）`} className="h-8 w-full rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]" />
          )}
          {kind === "secret" && (
            <div className="space-y-1 rounded-md bg-muted px-3 py-2 text-[12px] text-muted-foreground">
              <p>
                要交回的是密钥「{t.handBack?.label || t.handBack?.name}」，存成 <span className="font-mono">{t.handBack?.name}</span>，页面和 agent 都看不到值。
              </p>
              {secretAsked && (
                <p>
                  没弹出输入框（Gerdr 还是旧版）的话，在终端运行 <span className="font-mono">gerdr work secret set {t.handBack?.name}</span> 再点「完成」。
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
            <DropButton busy={!!busy} onDrop={() => go("drop", "drop", { id: t.id })} />
            {kind === "secret" && (
              <Button
                variant="outline"
                disabled={!!busy || !t.handBack?.name}
                onClick={async () => {
                  setSecretAsked(true);
                  if (await askSecret(t.handBack!.name!, { label: t.handBack?.label || t.title, note: t.steps })) await complete();
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
      ) : (
        <p className="text-[12px] text-muted-foreground">前置任务还没完成，先不用动。</p>
      )}
    </Card>
  );
}

/** A task's questions still waiting for an answer. */
function unanswered(t: Task) {
  return (t.questions ?? []).filter((q) => !q.dropped && !q.answer);
}

/**
 * Several things one worker needs decided or given, as one item: it can't go on until all are answered, so they're
 * answered here together; each answer is kept as it's given, and the worker hears them all once the last is in. An
 * answer can be changed (before the last one nobody has acted on it; after, the worker is told what changed).
 */
function Questions({ t, byId, act, onGo }: { t: Task; byId: Record<string, Task>; act: Act; onGo: (id: string) => void }) {
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
    <Card t={t} icon={<CircleHelp className="size-4" />}>
      <BackToChat t={t} byId={byId} onGo={onGo} />
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
      <div className="flex justify-end">
        <DropButton busy={!!busy} onDrop={() => go("drop", "drop", { id: t.id })} />
      </div>
    </Card>
  );
}

/** The agent task that asked for this human step / decision: a way back to its conversation, for the context. */
function BackToChat({ t, byId, onGo }: { t: Task; byId: Record<string, Task>; onGo: (id: string) => void }) {
  const asker = (t.askedBy && byId[t.askedBy]) || Object.values(byId).find((x) => x.owner === "agent" && x.blockedBy?.includes(t.id));
  if (!asker?.session) return null;
  return (
    <button onClick={() => onGo(asker.id)} className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground">
      <MessageSquare className="size-3.5 shrink-0" />
      <span className="truncate">回到 {asker.id} 的对话：{asker.title}</span>
    </button>
  );
}

/**
 * A decision a worker left on the board (ask_human with options): no hurry, no chat waiting on it. Picking an option,
 * or writing one's own, sends it to the worker, which carries on.
 */
function Decision({ t, byId, busy, err, onPick, onDrop, onGo }: { t: Task; byId: Record<string, Task>; busy: string; err: string; onPick: (v: string) => void; onDrop: () => void; onGo: (id: string) => void }) {
  const [own, setOwn] = useState("");
  const asker = (t.askedBy && byId[t.askedBy]) || Object.values(byId).find((x) => x.blockedBy?.includes(t.id));
  return (
    <Card t={t} icon={<CircleHelp className="size-4" />}>
      <BackToChat t={t} byId={byId} onGo={onGo} />
      <h3 className="text-[16px] font-medium">{t.title}</h3>
      <Meta t={t} byId={byId} extra={asker ? <span>· {asker.id} {asker.title} 在等这个决定</span> : undefined} />
      {t.steps && <Steps text={t.steps} />}
      {t.handBack?.multi ? (
        <MultiPick options={t.handBack.options ?? []} busy={busy === "complete"} disabled={!!busy} onSubmit={onPick} />
      ) : (
        <div className="space-y-1.5">
          {(t.handBack?.options ?? []).map((o, i) => (
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

/** Steps as written, with bare URLs made clickable. */
/** What a human step / question says, in the chat's Markdown (links, local videos and images shown, code). */
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
      {t.steps && <Steps text={t.steps} />}
      {t.handedBack && <p className="text-[12px] whitespace-pre-wrap text-muted-foreground">交回：{t.handedBack}</p>}
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

/** How long what a human step asks for still works (a sign-in link): re-drawn every 30 s; past it, "已过期". */
function Expiry({ at, className }: { at: number; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const left = Math.round((at - Date.now()) / 60_000);
  return <span className={clsx(left <= 0 ? "text-bad" : left <= 5 ? "text-warn" : "text-muted-foreground", className)}>{left <= 0 ? "已过期" : `还剩 ${left} 分钟`}</span>;
}

/** Two clicks instead of window.confirm (the browser's own box, unthemed and in English); arms for 3 seconds. */
function DropButton({ busy, onDrop }: { busy: boolean; onDrop: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <Button variant="ghost" className={clsx("text-[12px]", armed ? "text-bad" : "text-muted-foreground")} disabled={busy} onClick={() => (armed ? onDrop() : setArmed(true))}>
      {armed ? "确定放弃？" : "放弃"}
    </Button>
  );
}

const input = "h-9 w-full rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]";

function NewTask({ onClose, act }: { onClose: () => void; act: Act }) {
  const [owner, setOwner] = useState<"agent" | "human">("agent");
  const [f, setF] = useState({ title: "", prompt: "", repo: "", agent: "", model: "", worktree: false, steps: "", kind: "none" as "none" | "value" | "secret", label: "", name: "", minutes: "" });
  const [repos, setRepos] = useState<{ path: string; name: string }[]>([]);
  const [more, setMore] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const attach = useAttach(files, setFiles);
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
    const body =
      owner === "agent"
        ? { owner, prompt: f.prompt, repo: f.repo, agent: f.agent || undefined, model: f.model.trim() || undefined, mentions: mentions.length ? mentions.map((a) => a.id) : undefined, worktree: f.worktree, start, attachments: files.filter((a) => a.path).map((a) => ({ path: a.path, name: a.name, mime: a.mime })) }
        : { title: f.title, owner, steps: f.steps, minutes: Number(f.minutes) || undefined, handBack: { kind: f.kind, label: f.label || undefined, name: f.kind === "secret" ? f.name : undefined } };
    if (await go(start ? "start" : "add", "add", body)) onClose();
  };
  const ok = !attach.uploading && (owner === "human" ? f.title.trim() : f.prompt.trim() || files.length) && (f.kind !== "secret" || /^[\w.-]+$/.test(f.name));
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // Esc with the @ list open closes the list (MentionArea), not the dialog
        onEscapeKeyDown={(e) => document.querySelector("[data-mention-list]") && e.preventDefault()}
        className="flex max-h-[90dvh] w-full flex-col gap-3 overflow-y-auto p-4 sm:max-w-xl"
      >
        <div className="flex items-center justify-between">
          <DialogTitle className="text-[15px] font-medium">新任务</DialogTitle>
          <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-[13px]">
          {(["agent", "human"] as const).map((o) => (
            <button key={o} className={clsx("flex items-center justify-center gap-1.5 rounded-md py-1.5", owner === o ? "bg-background font-medium shadow-sm" : "text-muted-foreground")} onClick={() => setOwner(o)}>
              {o === "agent" ? <Bot className="size-3.5" /> : <Hand className="size-3.5" />}
              {o === "agent" ? "交给 agent" : "我自己做"}
            </button>
          ))}
        </div>
        {owner === "human" && <input autoFocus className={input} placeholder="标题" value={f.title} onChange={set("title")} onKeyDown={(e) => isSubmitEnter(e) && ok && !busy && void submit(false)} />}
        {owner === "agent" ? (
          <>
            <div className="space-y-2" onDrop={attach.onDrop} onDragOver={attach.onDragOver}>
              <MentionArea
                agents={agents}
                value={f.prompt}
                onChange={(prompt) => setF({ ...f, prompt })}
                onPaste={attach.onPaste}
                onSubmit={() => ok && !busy && void submit(true)}
                className={clsx(input, "h-40 resize-y py-2 leading-relaxed")}
                placeholder="要它做什么：目标、范围、做完的标准（截图可以直接粘贴；输入 @ 点名 agent；回车派出，Shift+回车换行）"
              />
              {mentions.length > 0 && (
                <p className="text-[12px] text-muted-foreground">
                  交给 {mentions.map((a) => a.name).join("、")}
                  {mentions.length > 1 ? "：由派活的对话安排怎么分、谁用什么模型" : ""}
                </p>
              )}
              <AttachmentBar items={files} onChange={setFiles} onPick={attach.add} />
            </div>
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
        ) : (
          <>
            <textarea className={clsx(input, "h-32 resize-y py-2 leading-relaxed")} placeholder="步骤（可以贴链接）" value={f.steps} onChange={set("steps")} />
            <div className="grid grid-cols-[auto_1fr] items-center gap-2 text-[13px]">
              <span className="text-muted-foreground">交回</span>
              <select className={input} value={f.kind} onChange={set("kind")}>
                <option value="none">不用交回，点完成就行</option>
                <option value="value">一个值（账号名、id…）</option>
                <option value="secret">一个密钥（存成面板密钥）</option>
              </select>
              {f.kind !== "none" && (
                <>
                  <span className="text-muted-foreground">说明</span>
                  <input className={input} placeholder="交回的是什么" value={f.label} onChange={set("label")} />
                </>
              )}
              {f.kind === "secret" && (
                <>
                  <span className="text-muted-foreground">名字</span>
                  <input className={clsx(input, "font-mono")} placeholder="LB_TEST_PASSWORD" value={f.name} onChange={set("name")} />
                </>
              )}
              <span className="text-muted-foreground">分钟</span>
              <input className={input} inputMode="numeric" placeholder="大概要几分钟" value={f.minutes} onChange={set("minutes")} />
            </div>
          </>
        )}
        {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          {owner === "agent" && (
            <Button variant="outline" disabled={!ok || !!busy} onClick={() => submit(false)}>
              只记下
            </Button>
          )}
          <Button disabled={!ok || !!busy} onClick={() => submit(owner === "agent")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : owner === "agent" ? <Send className="size-3.5" /> : <Plus className="size-3.5" />}
            {owner === "agent" ? "创建并派出" : "创建"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type AgentInfo = { id: string; name: string; base?: string; prompt?: string };

/** The agents @-mentioned in the text (by id or name), each once. Same reading as local/_agents.ts. */
function mentionsOf(text: string, agents: AgentInfo[]): AgentInfo[] {
  const out: AgentInfo[] = [];
  for (const m of text.matchAll(/@([^\s@，。,.;；:：!?！？)）]+)/g)) {
    const w = m[1].toLowerCase();
    const a = agents.find((x) => x.id.toLowerCase() === w || x.name.toLowerCase() === w);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/** A textarea where typing @ offers the agents: ↑ ↓ to move, Enter / Tab to pick, Esc to dismiss. */
function MentionArea({
  agents,
  value,
  onChange,
  onPaste,
  onSubmit,
  className,
  placeholder,
}: {
  agents: AgentInfo[];
  value: string;
  onChange: (v: string) => void;
  /** Enter (not Shift+Enter, not an input method's): send. With the @ list open, Enter picks from it instead. */
  onSubmit?: () => void;
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>;
  className?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [q, setQ] = useState<{ word: string; at: number } | null>(null);
  const [hi, setHi] = useState(0);
  const found = q ? agents.filter((a) => (a.id + " " + a.name).toLowerCase().includes(q.word.toLowerCase())).slice(0, 6) : [];
  const look = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    setQ(m ? { word: m[2], at: before.length - m[2].length - 1 } : null);
    setHi(0);
  };
  const pick = (a: AgentInfo) => {
    if (!q) return;
    const end = q.at + 1 + q.word.length;
    onChange(value.slice(0, q.at) + "@" + a.id + " " + value.slice(end));
    setQ(null);
    const caret = q.at + a.id.length + 2;
    requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret));
  };
  return (
    <div className="relative">
      <textarea
        ref={ref}
        autoFocus
        className={className}
        placeholder={placeholder}
        value={value}
        onPaste={onPaste}
        onChange={(e) => {
          onChange(e.target.value);
          look(e.target);
        }}
        onClick={(e) => look(e.currentTarget)}
        onBlur={() => setTimeout(() => setQ(null), 150)}
        onKeyDown={(e) => {
          if (!found.length) {
            if (onSubmit && isSubmitEnter(e)) {
              e.preventDefault();
              onSubmit();
            }
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => (h + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length);
          } else if ((e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) || e.key === "Tab") {
            e.preventDefault();
            pick(found[hi]);
          } else if (e.key === "Escape") {
            // only the list closes, not the dialog
            e.stopPropagation();
            setQ(null);
          }
        }}
      />
      {found.length > 0 && (
        <div data-mention-list className="absolute inset-x-2 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover text-[13px] text-popover-foreground shadow-md">
          {found.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className={clsx("flex w-full items-baseline gap-2 px-3 py-1.5 text-left", i === hi && "bg-accent")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(a);
              }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="shrink-0 font-medium">{a.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">@{a.id}</span>
              {a.prompt && <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{a.prompt}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- a requirement with members (DESIGN.md「需求和队友」) ----

/** A member as people call it: its repository's folder. */
function memberLabel(m?: Task) {
  return m ? m.repo?.split("/").pop() || m.id : "";
}

/** Who and what in a requirement waits on the user: the steps / decisions its members asked, members stuck on them. */
function teamNeeds(t: Task, tasks: Task[]) {
  const mine = tasks.filter((x) => x.id === t.id || x.in === t.id);
  const steps = mine.filter((x) => x.owner === "human" && x.status !== "done" && x.status !== "dropped" && x.ready);
  const stuck = mine.filter((x) => x.owner === "agent" && x.column === "you" && x.status !== "done" && x.status !== "dropped");
  return { steps, stuck };
}

/** What a member stuck on the user needs, in a line. */
function stuckText(x: Task) {
  const k = x.helpers?.find((h) => h.left);
  if (x.live?.status === "waiting") return `等你批准 / 回答${x.live.waiting ? `：${x.live.waiting}` : ""}`;
  if (x.live?.status === "error") return `出错了：${x.live.error ?? ""}`;
  if (k) return `它派出的「${k.title}」${k.waitingKind === "ask" ? "在问" : "要你批准"}：${k.waiting ?? ""}`;
  if (x.question) return `问你：${x.question}`;
  if (x.stopped) return `停下了${x.said ? `：${x.said}` : "，没说接下来要什么"}`;
  return "在等你";
}

function memberDot(x: Task) {
  if (x.status === "done") return "bg-ok";
  if (x.status === "dropped") return "bg-muted-foreground/30";
  if (x.column === "you") return "bg-warn";
  if (x.live?.status === "running") return "bg-ok animate-pulse";
  return "bg-muted-foreground/40";
}

/** The card: what the user scans — the latest activity, who's on it, and what waits on them. */
function TeamCard({ t, tasks, active, onOpen }: { t: Task; tasks: Task[]; active: boolean; onOpen: () => void }) {
  const byId = Object.fromEntries(tasks.map((x) => [x.id, x]));
  const ms = (t.members ?? []).map((id) => byId[id]).filter(Boolean);
  const last = t.activity?.[t.activity.length - 1];
  const { steps, stuck } = teamNeeds(t, tasks);
  const first = steps[0] ? `${steps[0].handBack?.kind === "choice" || steps[0].questions ? "待你决定" : "要你做"}：${steps[0].title}` : stuck[0] ? `${memberLabel(stuck[0])} ${stuckText(stuck[0])}` : "";
  const n = steps.length + stuck.length;
  return (
    <button data-task-card="" onClick={onOpen} className={clsx("block w-full space-y-1.5 rounded-lg border bg-card p-3 text-left shadow-xs transition-[border-color,box-shadow,transform] duration-150 hover:border-ring/50 hover:shadow-sm active:scale-[0.99]", active && "border-ring")}>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <Users className="size-3 shrink-0" />
        <span className="shrink-0 font-mono">{t.id}</span>
        <span>· 需求 · {ms.length} 个成员</span>
      </div>
      <p className={clsx("line-clamp-2 text-[13px] font-medium", t.status === "dropped" && "text-muted-foreground line-through")}>{t.title}</p>
      {n > 0 && t.status !== "done" && t.status !== "dropped" && (
        <p className="line-clamp-2 text-[12px] text-warn">
          {n > 1 && <span className="font-medium">{n} 件等你 · </span>}
          {first}
        </p>
      )}
      {last && (
        <p className="line-clamp-2 text-[12px] text-muted-foreground">
          {last.by && byId[last.by] && <span className="text-foreground/80">{memberLabel(byId[last.by])}</span>}
          {last.to && byId[last.to] && <span> → {memberLabel(byId[last.to])}</span>}
          {last.by && byId[last.by] ? "：" : ""}
          {last.text}
          <span className="text-muted-foreground/70"> · {ago(last.at)}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {ms.map((m) => (
          <span key={m.id} title={`${m.id} ${m.title}`} className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            <span className={clsx("size-1.5 rounded-full", memberDot(m))} />
            {memberLabel(m)}
            {m.id === t.id && <span className="text-[10px]">（负责）</span>}
          </span>
        ))}
      </div>
    </button>
  );
}

const KIND: Record<string, string> = { progress: "进展", tell: "通知", join: "加入", done: "完成", review: "待你看", user: "你", stuck: "卡住" };

/**
 * Opening a requirement: what waits on the user first (answered right here), then its members (a click opens one's
 * chat — the only place chats are), then the activity feed, newest first. The user follows this, not the chats.
 */
function TeamDrawer({ t, tasks, byId, act, onClose, onGo }: { t: Task; tasks: Task[]; byId: Record<string, Task>; act: Act; onClose: () => void; onGo: (id: string) => void }) {
  const { busy, err, go } = useAction(act);
  const ms = (t.members ?? []).map((id) => byId[id]).filter(Boolean);
  const { steps, stuck } = teamNeeds(t, tasks);
  const over = t.status === "done" || t.status === "dropped";
  const feed = [...(t.activity ?? [])].reverse();
  const when = (ms: number) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <Sheet open modal={false} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-full gap-0 sm:max-w-[560px]"
        onInteractOutside={(e) => {
          const el = e.target as Element | null;
          if (!el?.closest?.("[data-gerdr-mount]") || el.closest("[data-task-card]")) e.preventDefault();
        }}
      >
        <SheetTitle className="sr-only">{t.title}</SheetTitle>
        <div className="flex items-center gap-2 border-b px-4 py-2.5 text-[12px] text-muted-foreground">
          <Users className="size-3.5" />
          <span className="font-mono">{t.id}</span>
          <span>· 需求 · {COLS.find((c) => c.id === colOf(t))?.title}</span>
          <span className="ml-auto" />
          <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <h3 className="text-[16px] font-medium">{t.title}</h3>
          {!over && (steps.length > 0 || stuck.length > 0) && (
            <section className="space-y-2">
              <h4 className="text-[12px] font-medium text-warn">等你 · {steps.length + stuck.length}</h4>
              {stuck.map((x) => (
                <div key={x.id} className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{memberLabel(x)}</span> {stuckText(x)}
                  </span>
                  {x.session && (
                    <Button variant="outline" onClick={() => openChat(x.session!, x.id)}>
                      <MessageSquare className="size-3.5" />
                      去对话
                    </Button>
                  )}
                </div>
              ))}
              {steps.map((h) => (
                <div key={h.id} className="rounded-md border border-warn/40 p-3">
                  <HumanCard t={h} byId={byId} act={act} onGo={onGo} />
                </div>
              ))}
            </section>
          )}
          <section className="space-y-1.5">
            <h4 className="text-[12px] font-medium text-muted-foreground">成员 · 点开看它的对话</h4>
            {ms.map((m) => (
              <button
                key={m.id}
                disabled={!m.session}
                onClick={() => m.session && openChat(m.session, m.id)}
                className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] hover:bg-accent disabled:opacity-60"
              >
                <span className={clsx("size-2 shrink-0 rounded-full", memberDot(m))} />
                <span className="shrink-0 font-medium">{memberLabel(m)}</span>
                {m.id === t.id && <span className="shrink-0 rounded-sm bg-brand/10 px-1 text-[11px] text-brand">负责人</span>}
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{m.status === "done" ? "做完了" : m.status === "dropped" ? "放弃了" : liveText(m)}</span>
              </button>
            ))}
          </section>
          <section className="space-y-1.5">
            <h4 className="text-[12px] font-medium text-muted-foreground">活动</h4>
            {feed.length ? (
              <ol className="space-y-2 border-l pl-3">
                {feed.map((a, i) => (
                  <li key={`${a.at}-${i}`} className="relative text-[13px]">
                    <span className={clsx("absolute top-1.5 -left-[16.5px] size-2 rounded-full border-2 border-background", a.kind === "done" ? "bg-ok" : a.kind === "stuck" || a.kind === "review" ? "bg-warn" : a.kind === "user" ? "bg-brand" : "bg-muted-foreground/50")} />
                    <div className="flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
                      <span>{KIND[a.kind] ?? a.kind}</span>
                      {a.by && byId[a.by] && a.kind !== "user" && <span className="text-foreground/80">{memberLabel(byId[a.by])}</span>}
                      {a.to && byId[a.to] && (
                        <>
                          <ArrowRight className="size-3 self-center" />
                          <span className="text-foreground/80">{memberLabel(byId[a.to])}</span>
                        </>
                      )}
                      <span className="ml-auto tabular-nums">{when(a.at)}</span>
                    </div>
                    <p className="whitespace-pre-wrap">{a.text}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12px] text-muted-foreground">还没有活动</p>
            )}
          </section>
          {ms.some((m) => m.links?.length) && ms.map((m) => <Links key={m.id} t={m} />)}
          {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
          {!over && (
            <div className="flex flex-wrap justify-end gap-2">
              <DropButton busy={!!busy} onDrop={() => go("drop", "drop", { id: t.id })} />
              <Button variant="outline" disabled={!!busy} onClick={() => go("accept", "accept", { id: t.id })}>
                <Check className="size-3.5" />
                整个需求标为完成
              </Button>
            </div>
          )}
          {t.status === "dropped" && (
            <div className="flex justify-end">
              <Button variant="outline" disabled={!!busy} onClick={() => go("restore", "restore", { id: t.id })}>
                <Undo2 className="size-3.5" />
                恢复
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
