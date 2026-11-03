import { AlertTriangle, Bot, Check, CheckCircle2, Circle, CircleDashed, CircleDot, CircleHelp, ListTodo, ExternalLink, GitPullRequest, Hand, KeyRound, Loader2, MessageSquare, Paperclip, Plus, Send, Settings, Undo2, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { AttachmentBar, useAttach, type Attachment } from "../components/Attachments";
import { askSecret, secretNames } from "../lib/bridge";
import { ChatDrawer, type ChatAction, type ChatItem } from "../components/ChatDrawer";
import { SettingsSheet, type SettingsTab } from "../components/SettingsSheet";
import { day, since, type Task, useTasks } from "../lib/tasks";
import { project, run } from "../lib/gerdr";
import { onShowSession } from "@gerdr/core";

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

/** The board's column: tasks.ts says you / review / active / done; "active" is split into not started yet and running. */
function colOf(t: Task): Col {
  if (t.column === "active" && (t.status === "todo" || (t.owner === "human" && !t.ready))) return "todo";
  return t.column;
}

export default function BoardPage() {
  const { tasks, error, act } = useTasks();
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [open, setOpen] = useState("");
  const [doneLimit, setDoneLimit] = useState(20);
  const byId = Object.fromEntries((tasks ?? []).map((t) => [t.id, t]));
  const list = (c: Col) => {
    const l = (tasks ?? []).filter((t) => colOf(t) === c);
    if (c === "done") return l.sort((a, b) => Number(a.status === "dropped") - Number(b.status === "dropped") || (b.doneAt ?? 0) - (a.doneAt ?? 0));
    if (c === "you") return l.sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || a.updatedAt - b.updatedAt);
    return l.sort((a, b) => b.updatedAt - a.updatedAt);
  };
  const sel = open ? byId[open] : undefined;
  // An agent task with a worker opens as its conversation (Gerdr's chat in our drawer): the whole chat to decide
  // from, and its input box for the answer. Everything else (to do, human tasks, finished ones) in our own panel.
  const inChat = !!sel && sel.owner === "agent" && !!sel.session && sel.status !== "done" && sel.status !== "dropped";
  const panel = sel && inChat ? chatPanel(sel, byId) : null;
  // A conversation opened from a panel ("回到 tN 的对话", a finished task's chat): the chat alone, over the panel
  const [peek, setPeek] = useState("");
  // Opening a conversation from a task's panel closes the panel: it sat on top and hid the chat (on a phone, all of it)
  openChat = (session: string) => {
    setOpen("");
    setPeek(session);
  };
  // A worker's conversation brought up from elsewhere in Gerdr (a notification, the inbox): it's this board's, so it
  // opens here, as its task's drawer (or just the chat when no task has it)
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  useEffect(
    () =>
      onShowSession(project, (session) => {
        const t = (tasksRef.current ?? []).find((x) => x.session === session || x.sessions?.includes(session));
        if (t && t.owner === "agent" && t.session === session && t.status !== "done" && t.status !== "dropped") {
          setPeek("");
          setOpen(t.id);
        } else setPeek(session);
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
    if (action === "deliver") void act("deliver", { id: t.id }).then(() => run("mrwatch.check", { id: t.id }).then(() => act("list", {})));
    // GitLab can refuse (a required pipeline still running): mrwatch writes why into the task, and the panel's line shows it
    const after = () => act("list", {});
    if (action === "merge") void run("mrwatch.mergeNow", { id: t.id }).then(after, after);
    if (action === "rebase") void run("mrwatch.rebase", { id: t.id, skipCI: true }).then(after, after);
    if (action === "check") void run("mrwatch.check", { id: t.id }).then(() => act("list", {}));
  };

  return (
    <div className="flex h-full min-h-0 flex-col [overflow-wrap:anywhere] max-md:h-auto md:relative">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h1 className="flex items-center gap-2 text-[14px] font-medium">
          <ListTodo className="size-4 text-muted-foreground" />
          任务
        </h1>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="看板设置" title="看板设置：流程、定时任务" onClick={() => setSettings("flow")}>
            <Settings className="size-4" />
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            新任务
          </Button>
        </div>
      </header>
      {error && <p role="alert" className="px-4 pt-3 text-[13px] text-bad">读取失败：{error}</p>}
      {!tasks && !error ? (
        <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 max-md:snap-x max-md:snap-mandatory">
          {COLS.map((c) => {
            const all = list(c.id);
            const shown = c.id === "done" ? all.slice(0, doneLimit) : all;
            const minutes = c.id === "you" ? all.filter((t) => t.owner === "human").reduce((n, t) => n + (t.minutes ?? 0), 0) : 0;
            return (
              <section key={c.id} className="flex min-w-60 flex-1 basis-0 flex-col rounded-xl bg-muted/50 max-md:w-[85vw] max-md:flex-none max-md:snap-start">
                <h2 className="flex items-center gap-2 px-3 pt-3 pb-2 text-[13px] font-medium">
                  {c.icon}
                  {c.title}
                  <span className="text-[12px] font-normal text-muted-foreground tabular-nums">{all.length}</span>
                  {minutes > 0 && <span className="text-[11px] font-normal text-muted-foreground">· 约 {minutes} 分钟</span>}
                  {c.id === "todo" && (
                    <button aria-label="新任务" className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setCreating(true)}>
                      <Plus className="size-3.5" />
                    </button>
                  )}
                </h2>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                  {shown.length ? shown.map((t) => <MiniCard key={t.id} t={t} byId={byId} active={t.id === open} onOpen={() => setOpen(t.id)} />) : <p className="py-6 text-center text-[12px] text-muted-foreground">无任务</p>}
                  {all.length > shown.length && (
                    <button className="w-full py-2 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setDoneLimit(doneLimit + 50)}>
                      再显示 {Math.min(50, all.length - shown.length)} 个
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {sel && !inChat && <Drawer t={sel} byId={byId} act={act} onClose={() => setOpen("")} onGo={setOpen} />}
      {panel && sel?.session && !peek && <ChatDrawer session={sel.session} {...panel} onAction={onAction} onClose={() => setOpen("")} />}
      {peek && <ChatDrawer session={peek} onClose={() => setPeek("")} />}
      {creating && <NewTask onClose={() => setCreating(false)} act={act} />}
      {settings && <SettingsSheet tab={settings} onTab={setSettings} onClose={() => setSettings(null)} />}
    </div>
  );
}

/** Opens a conversation in the drawer, from anywhere on the page (set by BoardPage). */
let openChat: (session: string) => void = () => {};

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
      label: `${t.id} 在等你处理 ${mine.length} 件`,
      actions: [drop, done],
      items: mine.map((h) => {
        const left = h.expiresAt ? (h.expiresAt > Date.now() ? `（还剩 ${Math.round((h.expiresAt - Date.now()) / 60000)} 分钟）` : "（已过期）") : "";
        return { text: `${h.id} ${h.handBack?.kind === "choice" ? "待决定" : "要你做"}：${h.title}${left}`, jump: h.id };
      }),
    };
  if (c === "review") {
    const mr = (t.links ?? []).find((l) => /\/-\/merge_requests\/\d+/.test(l.url));
    // A result with an MR isn't finished until it's merged: hand it to the watcher instead of accepting it
    if (mr)
      return {
        label: `${t.id} · 待验收：结果里有 ${mr.label}。没问题就交给定时任务盯着合并（review 意见、流水线会交给它处理）；要改直接在下面说`,
        actions: [drop, { id: "accept", label: "直接完成", confirm: "确定完成？" }, { id: "deliver", label: "等它合并", kind: "primary", confirm: "确定？会自动变基、合进去" }],
      };
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
            : t.question
              ? `它问你：${t.question}`
              : "它在等你，见最后一条回复"
      }`,
      actions: [drop, done],
    };
  if (t.status === "delivering" && t.delivery)
    return {
      label: `${t.id} · 等 MR !${t.delivery.iid} 合并：${t.delivery.detail ?? "还没查过"}${t.delivery.checked ? `（${since(t.delivery.checked)}前查的）` : ""}。review 意见和挂掉的流水线会自动交给它，能合就自动合`,
      actions: [
        drop,
        { ...done, label: "标为完成（不等合并）" },
        { id: "check", label: "立即检查" },
        ...(t.delivery.state === "need_rebase" ? [{ id: "rebase", label: "变基（跳过流水线）", confirm: "确定？不跑新流水线" }] : []),
        { id: "merge", label: "立即合并", kind: "primary" as const, confirm: "确定合进去？" },
      ],
    };
  return { label: `${t.id} · 进行中`, actions: [drop, done] };
}

/** A task as a small card in its column: what it is, where, and how it's doing. Click for everything else. */
function MiniCard({ t, byId, active, onOpen }: { t: Task; byId: Record<string, Task>; active: boolean; onOpen: () => void }) {
  const blockers = (t.blockedBy ?? []).filter((b) => byId[b] && byId[b].status !== "done" && byId[b].status !== "dropped");
  const live = t.owner === "agent" ? liveText(t) : "";
  return (
    <button onClick={onOpen} className={clsx("block w-full space-y-1.5 rounded-lg border bg-card p-3 text-left shadow-xs hover:border-ring/50", active && "border-ring")}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {t.owner === "human" ? t.handBack?.kind === "choice" ? <CircleHelp className="size-3" /> : <Hand className="size-3" /> : <Bot className="size-3" />}
        <span className="font-mono">{t.id}</span>
        {t.urgent && <AlertTriangle className="size-3 text-warn" />}
        {t.expiresAt && t.status !== "done" && t.status !== "dropped" ? (
          <Expiry at={t.expiresAt} className="ml-auto" />
        ) : t.minutes ? (
          <span className="ml-auto">约 {t.minutes} 分钟</span>
        ) : null}
      </div>
      <p className={clsx("line-clamp-2 text-[13px] font-medium", t.status === "dropped" && "text-muted-foreground line-through")}>{t.title}</p>
      {t.question && colOf(t) === "you" && <p className="line-clamp-2 text-[12px] text-warn">{t.question}</p>}
      {(t.repo || live || blockers.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          {t.repo && <span>{t.repo.split("/").pop()}</span>}
          {t.agent && <span>· {t.agent}</span>}
          {t.status === "delivering" && t.delivery ? (
            // A span, not <a>: the card is a <button> and can't hold a link
            <span
              role="link"
              onClick={(e) => {
                e.stopPropagation();
                window.open(t.delivery!.url, "_blank", "noreferrer");
              }}
              className="inline-flex items-center gap-1 rounded-sm bg-brand/10 px-1 text-brand hover:underline"
            >
              <GitPullRequest className="size-3" />!{t.delivery.iid} {t.delivery.detail ?? "等合并"}
            </span>
          ) : (
            live && t.status !== "done" && t.status !== "dropped" && <span className={clsx("inline-flex items-center gap-1", liveTone(t))}>· {live}</span>
          )}
          {blockers.map((b) => (
            <span key={b} className="rounded-sm bg-warn/10 px-1 text-warn">
              等 {b}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

/** Everything about one task and what you can do with it, in a panel on the right (full screen on a phone). */
function Drawer({ t, byId, act, onClose, onGo }: { t: Task; byId: Record<string, Task>; act: Act; onClose: () => void; onGo: (id: string) => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const done = t.status === "done" || t.status === "dropped";
  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <aside role="dialog" aria-label={t.title} className="absolute inset-y-0 right-0 flex w-[min(520px,100%)] flex-col border-l bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b px-4 py-2.5 text-[12px] text-muted-foreground">
          {t.owner === "human" ? <Hand className="size-3.5" /> : <Bot className="size-3.5" />}
          <span className="font-mono">{t.id}</span>
          <span>· {COLS.find((c) => c.id === colOf(t))?.title}</span>
          <Button variant="ghost" size="icon" aria-label="关闭" className="ml-auto" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{done ? <DoneDetail t={t} /> : t.owner === "human" ? <HumanCard key={t.id} t={t} byId={byId} act={act} onGo={onGo} /> : <AgentCard key={t.id} t={t} byId={byId} act={act} />}</div>
      </aside>
    </div>
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
      {t.agent && <span>· {t.agent}</span>}
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
  const l = t.live;
  const stale = l?.status === "running" && l.turnStartedAt && Date.now() - l.turnStartedAt > 40 * 60000;
  return l?.status === "waiting" || l?.status === "error" || stale ? "text-warn" : l?.status === "running" ? "text-ok" : "";
}

function liveText(t: Task) {
  const l = t.live;
  if (!l) return t.status === "todo" ? (t.routing ? "助手在挑仓库" : "还没派出去") : t.session ? "会话已关闭" : "";
  if (l.status === "running") return `在跑 · ${since(l.turnStartedAt)}`;
  if (l.status === "waiting") return `等审批 / 回答 · ${since(l.waitingSince)}`;
  if (l.status === "error") return `出错：${l.error ?? ""}`;
  return `停下 · ${since(l.updatedAt)}前`;
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
          <Button variant="ghost" className="text-[12px]" onClick={() => openChat(t.session!)}>
            <MessageSquare className="size-3.5" />
            对话
          </Button>
        )}
      </div>
      <Meta t={t} byId={byId} extra={liveText(t) ? <span className={clsx("inline-flex items-center gap-1", tone)}><CircleDot className="size-3" />{liveText(t)}{stale ? "（很久没结束）" : ""}</span> : undefined} />
      {l?.status === "waiting" && l.waiting && <p className="rounded-md bg-warn/10 px-3 py-2 text-[12px] text-warn">在等：{l.waiting}（去会话里处理）</p>}
      {t.summary && <p className="text-[13px] whitespace-pre-wrap">{t.summary}</p>}
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
            <button className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => openChat(t.session!)}>
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
        <button className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => openChat(t.session!)}>
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
      <div className="space-y-1.5">
        {(t.handBack?.options ?? []).map((o, i) => (
          <button key={i} disabled={!!busy} onClick={() => onPick(o)} className="flex w-full gap-2 rounded-lg border p-2.5 text-left text-[13px] hover:border-ring hover:bg-accent disabled:opacity-50">
            <span className="shrink-0 font-mono text-muted-foreground">{i + 1}</span>
            <span className="whitespace-pre-wrap">{o}</span>
          </button>
        ))}
        <div className="flex gap-2">
          <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="其他，自己写…" onKeyDown={(e) => e.key === "Enter" && own.trim() && onPick(own.trim())} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]" />
          <Button disabled={!own.trim() || !!busy} onClick={() => onPick(own.trim())}>
            {busy === "complete" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}就这样定
          </Button>
        </div>
      </div>
      {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
      <div className="flex justify-end">
        <DropButton busy={!!busy} onDrop={onDrop} />
      </div>
    </Card>
  );
}

/** Steps as written, with bare URLs made clickable. */
function Steps({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)）]+)/g);
  return (
    <p className="rounded-md bg-muted/60 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="text-brand hover:underline">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </p>
  );
}

function DoneDetail({ t }: { t: Task }) {
  return (
    <div className="space-y-3">
      <h3 className={clsx("text-[16px] font-medium", t.status === "dropped" && "text-muted-foreground line-through")}>{t.title}</h3>
      <div className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
        {t.repo && <span>{t.repo.split("/").pop()}</span>}
        {t.agent && <span>· {t.agent}</span>}
        <span>· {t.status === "dropped" ? "放弃于" : "完成于"} {day(t.doneAt ?? t.updatedAt)}</span>
      </div>
      {t.summary && <p className="text-[13px] whitespace-pre-wrap">{t.summary}</p>}
      {t.steps && <Steps text={t.steps} />}
      {t.handedBack && <p className="text-[12px] text-muted-foreground">交回：{t.handedBack}</p>}
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
      {t.session && (
        <Button variant="outline" className="text-[12px]" onClick={() => openChat(t.session!)}>
          <MessageSquare className="size-3.5" />
          打开对话
        </Button>
      )}
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
  const [f, setF] = useState({ title: "", prompt: "", repo: "", agent: "", worktree: false, steps: "", kind: "none" as "none" | "value" | "secret", label: "", name: "", minutes: "" });
  const [repos, setRepos] = useState<{ path: string; name: string }[]>([]);
  const [more, setMore] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const attach = useAttach(files, setFiles);
  const { busy, err, go } = useAction(act);
  useEffect(() => {
    run<{ path: string; name: string }[]>("tasks.repos").then(setRepos, () => {});
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });
  const submit = async (start: boolean) => {
    const body =
      owner === "agent"
        ? { owner, prompt: f.prompt, repo: f.repo, agent: f.agent || undefined, worktree: f.worktree, start, attachments: files.filter((a) => a.path).map((a) => ({ path: a.path, name: a.name, mime: a.mime })) }
        : { title: f.title, owner, steps: f.steps, minutes: Number(f.minutes) || undefined, handBack: { kind: f.kind, label: f.label || undefined, name: f.kind === "secret" ? f.name : undefined } };
    if (await go(start ? "start" : "add", "add", body)) onClose();
  };
  const ok = !attach.uploading && (owner === "human" ? f.title.trim() : f.prompt.trim() || files.length) && (f.kind !== "secret" || /^[\w.-]+$/.test(f.name));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 max-md:items-end max-md:p-0" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="新任务" className="flex max-h-[90dvh] w-full max-w-xl flex-col gap-3 overflow-y-auto rounded-xl border bg-background p-4 shadow-lg max-md:rounded-b-none" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
        <div className="flex items-center justify-between">
          <h2 className="font-medium">新任务</h2>
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
        {owner === "human" && <input autoFocus className={input} placeholder="标题" value={f.title} onChange={set("title")} />}
        {owner === "agent" ? (
          <>
            <div className="space-y-2" onDrop={attach.onDrop} onDragOver={attach.onDragOver}>
              <textarea autoFocus onPaste={attach.onPaste} className={clsx(input, "h-40 resize-y py-2 leading-relaxed")} placeholder="要它做什么：目标、范围、做完的标准（截图可以直接粘贴）" value={f.prompt} onChange={set("prompt")} />
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
                  <input className={input} placeholder="agent（不填 = 默认；claude / codex / 角色 id）" value={f.agent} onChange={set("agent")} />
                  <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                    <input type="checkbox" checked={f.worktree} onChange={set("worktree")} />
                    独立 worktree
                  </label>
                </div>
              </>
            ) : (
              <button className="self-start text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setMore(true)}>
                指定仓库 / agent（不填就由右边的助手来定）
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
                <option value="secret">一个密钥（存成 Work secret）</option>
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
      </div>
    </div>
  );
}
