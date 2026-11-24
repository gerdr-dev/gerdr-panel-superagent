import * as core from "@gerdr/core";
import clsx from "clsx";
import { Ban, Check, ChevronRight, Eye, MessageSquare, Play, Plus, Settings, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { run } from "../lib/gerdr";
import { openAsks, type Task, useTasks } from "../lib/tasks";
import { CodeRow, type CodeRowInfo, newCodeTab, openSettings, showInCode, useCodeRowDrop, useCodeRowMenu, useCodeRows, useCodeSession } from "../lib/view";
import { usePanelChange, useRefresh, useSessions } from "../lib/visible";

// Code's whole list, drawn by this panel (lib/view.ts, layout.tsx; core CodeView list="replace"): not Code's
// workspaces but where each piece of work stands. The secretary first; then 等你, 进行中, 待验收, 待办 — the tasks the
// secretary handed out and the person's own conversations in the same groups (2026-11-24, the person: the groups on
// the left are the board's statuses, not workspaces) — and 其他 for panes that aren't conversations (a terminal, a
// file, a browser page). A row whose conversation has a pane is Code's own row (core CodeRow).
//
// A task's group is its status, which only the person changes (DESIGN.md). Their own conversations have none: one is
// 进行中 while its tab is open and 等你 while its agent waits on them (an approval, an error); closing it ends it.

const toast = (core as unknown as { toast?: { error?: (m: string) => unknown } }).toast;

/** A folded group of rows, open or not, per device. */
function useFold(name: string, init = false): [boolean, () => void] {
  const key = `gerdr-panel-fusion.open.${name}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? init : v === "1";
    } catch {
      return init;
    }
  });
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem(key, v ? "0" : "1");
      } catch {}
      return !v;
    });
  return [open, toggle];
}

function FoldTitle({ open, onClick, children }: { open: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="flex h-7 w-full items-center gap-1 rounded-md pr-1 pl-1.5 text-[11px] font-medium text-muted-foreground select-none hover:bg-accent/60 hover:text-foreground"
      onClick={onClick}
    >
      <ChevronRight className={clsx("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      {children}
    </button>
  );
}
const base = (p?: string) => (p ?? "").replace(/\/+$/, "").split("/").pop() ?? "";

type Main = { id: string; status: string; waiting?: string } | null;
type Sess = { id: string; status: string; tags?: Record<string, string> };
type Status = "todo" | "running" | "review" | "done";
const LABEL: Record<Status, string> = { todo: "待办", running: "进行中", review: "待验收", done: "已完成" };
const ICON: Record<"running" | "review" | "done", React.ReactNode> = { running: <Undo2 />, review: <Eye />, done: <Check /> };
/** A task row of ours being dragged (rows that are Code's own are dragged by Code: useCodeRowDrop). */
const TASK_MIME = "text/x-gerdr-task";

export function CodeSection() {
  const { tasks, act } = useTasks();
  const cur = useCodeSession();
  const rows = useCodeRows();
  const [main, setMain] = useState<Main>(null);
  const [asks, setAsks] = useState(0);
  // Which session is the secretary only changes with the log (pushed); its status is followed live below
  useRefresh(
    () =>
      run<{ main: Main; asks?: { open: unknown[] } }>("superagent.log", { limit: 1 }).then(
        (r) => (setMain(r.main), setAsks(r.asks?.open?.length ?? 0)),
        () => {},
      ),
    [usePanelChange("user/data")],
    { poll: 10_000 },
  );
  // The conversations in Code's panes, and the secretary: what each is doing now
  const open = new Set(rows.map((r) => r.session).filter(Boolean) as string[]);
  const openKey = [...open].sort().join(",");
  const live = useSessions((s) => open.has(s.id) || s.id === main?.id) as Sess[];
  const byId = useMemo(() => Object.fromEntries(live.map((s) => [s.id, s])), [live, openKey]);
  const status = main && main.status !== "gone" ? (byId[main.id]?.status ?? main.status) : "";
  const openMain = () =>
    main && status
      ? showInCode(main.id)
      : run<{ main: string }>("secretary.open", {}).then(
          (r) => showInCode(r.main),
          (e) => toast?.error?.(String(e?.message ?? e)),
        );

  // Where the person's own conversations stand (local/own.ts); a move shows at once, the file follows
  const [standing, setStanding] = useState<Record<string, "review" | "done">>({});
  useRefresh(() => run<{ standing: Record<string, "review" | "done"> }>("own.get").then((r) => setStanding(r.standing), () => {}), [usePanelChange("user/data")], { poll: 30_000 });
  const moveOwn = (session: string, to: Status) => {
    if (to === "todo") return void toast?.error?.("已经开着的对话回不到待办");
    setStanding((cur) => {
      const next = { ...cur };
      if (to === "running") delete next[session];
      else next[session] = to;
      return next;
    });
    run<{ standing: Record<string, "review" | "done"> }>("own.set", { session, status: to }).then(
      (r) => setStanding(r.standing),
      (e) => toast?.error?.(String(e?.message ?? e)),
    );
  };

  const [activeOpen, foldActive] = useFold("active", true);
  const [reviewOpen, foldReview] = useFold("review");
  const [todoOpen, foldTodo] = useFold("todo");
  const [doneOpen, foldDone] = useFold("done");
  const [otherOpen, foldOther] = useFold("other", true);

  // Tasks by status. A task's worker may have a pane (drawn as Code's own row) or not yet (our row; a click opens it)
  const all = tasks ?? [];
  const taskOf = new Map<string, Task>();
  for (const t of all) if (t.session && t.status !== "dropped") taskOf.set(t.session, t);
  const paneOf = new Map<string, CodeRowInfo>();
  for (const r of rows) if (r.session && r.kind === "session" && !paneOf.has(r.session)) paneOf.set(r.session, r);
  const byRecent = (a: Task, b: Task) => b.updatedAt - a.updatedAt;
  const running = all.filter((t) => t.status === "running");
  const youTasks = running.filter((t) => t.column === "you").sort(byRecent);
  const activeTasks = running.filter((t) => t.column !== "you").sort(byRecent);
  const review = all.filter((t) => t.status === "review").sort(byRecent);
  const todo = all.filter((t) => t.status === "todo").sort(byRecent);
  // The ones not archived yet (local/_archive.ts moves old ones out): the newest few are enough here
  const done = all
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt))
    .slice(0, 30);

  // The rest of Code's panes: the person's own conversations (and ours no task has: a helper, an old secretary). In
  // the same groups as the tasks and moved the same way, not told apart from them (the person's call): 进行中 until
  // they move one, 等你 while its agent waits on them. What isn't a conversation (a terminal, a file, a browser page)
  // has no standing: 其他.
  const isMain = (id?: string) => !!id && (id === main?.id || byId[id]?.tags?.superagent === "main");
  const own = rows.filter((r) => (r.kind === "session" || r.kind === "new") && !(r.session && (taskOf.has(r.session) || isMain(r.session))));
  const needs = (r: CodeRowInfo) => !!r.session && (byId[r.session]?.status === "waiting" || byId[r.session]?.status === "error");
  const stands = (r: CodeRowInfo) => (r.session ? standing[r.session] : undefined);
  const youOwn = own.filter((r) => needs(r) && stands(r) !== "done");
  const activeOwn = own.filter((r) => !stands(r) && !needs(r));
  const reviewOwn = own.filter((r) => stands(r) === "review" && !needs(r));
  const doneOwn = own.filter((r) => stands(r) === "done");
  const other = rows.filter((r) => r.kind !== "session" && r.kind !== "new");
  const you = youTasks.length + youOwn.length;

  const move = (t: Task, to: Status) => act("setStatus", { id: t.id, status: to }).catch((e) => toast?.error?.(String(e?.message ?? e)));
  // A row dragged onto a group (Code's row: by its conversation; ours: by the task's id), or 移到… in a menu: it takes
  // that status. Only the person moves things (DESIGN.md), and this is them doing it. A task and a conversation of
  // their own move alike; only where it's written differs
  const onMove = (to: Status, row: { session?: string; task?: string }) => {
    const t = row.task ? all.find((x) => x.id === row.task) : row.session ? taskOf.get(row.session) : undefined;
    if (t) return void (t.status !== to && move(t, to));
    if (row.session && !isMain(row.session)) moveOwn(row.session, to);
  };
  // The same moves in the pane's ⋯ menu and the row's right-click menu: the only way on a phone (no hover, no drag)
  useCodeRowMenu(({ session }) => {
    if (!session || isMain(session)) return [];
    const t = taskOf.get(session);
    const at: Status = t ? (t.status as Status) : (standing[session] ?? "running");
    const items = (["running", "review", "done"] as const)
      .filter((to) => to !== at)
      .map((to) => ({ id: `move-${to}`, label: `移到${LABEL[to]}`, icon: ICON[to], onSelect: () => onMove(to, { session }) }));
    if (t) items.push({ id: "drop", label: "放弃任务", icon: <Ban />, onSelect: () => void act("drop", { id: t.id }).catch((e) => toast?.error?.(String(e?.message ?? e))) } as any);
    return items;
  });
  const taskRow = (t: Task, action: React.ReactNode) => <TaskRow key={t.id} t={t} pane={t.session ? paneOf.get(t.session) : undefined} current={!!t.session && cur === t.session} action={action} />;
  const toReview = (t: Task) => (
    <RowButton title="移到待验收" onClick={() => move(t, "review")}>
      <Check className="size-3.5" />
    </RowButton>
  );
  const ownRow = (r: CodeRowInfo) => <CodeRow key={r.pane} pane={r.pane} where={base(r.cwd)} />;

  return (
    <div className="pt-1.5 pb-1" data-fusion-section>
      <RowShell current={!!main && cur === main.id} onClick={openMain} title="和秘书说话：交给它的事、它怎么判断外面来的消息、派给了谁，都在这段对话里">
        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">秘书</span>
        {asks > 0 ? (
          <span className="shrink-0 rounded-full bg-warn px-1.5 text-[10px] leading-4 font-semibold text-background tabular-nums">{asks} 个问题</span>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">{status === "running" ? "在判断" : status === "waiting" ? "等你回答" : status === "error" ? "出错了" : ""}</span>
        )}
        <AgentPick main={main?.id} current={cur} />
        <button
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          title="秘书背后的东西：设置（谁干活、仓库）、流程、记忆、触发器、定时任务、外面来的消息的去向"
          onClick={(e) => (e.stopPropagation(), openSettings("settings"))}
        >
          <Settings className="size-3.5" />
        </button>
      </RowShell>

      {you > 0 && (
        <Drop to="running" onMove={onMove}>
          <GroupTitle tone="you">等你 {you}</GroupTitle>
          {youTasks.map((t) => taskRow(t, toReview(t)))}
          {youOwn.map(ownRow)}
        </Drop>
      )}

      <Drop to="running" onMove={onMove}>
        <FoldTitle open={activeOpen} onClick={foldActive}>
          进行中 {activeTasks.length + activeOwn.length}
          <span className="flex-1" />
          <span
            role="button"
            className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
            title="新对话：自己随手开一个，不经过秘书"
            onClick={(e) => (e.stopPropagation(), newCodeTab())}
          >
            <Plus className="size-3.5" />
          </span>
        </FoldTitle>
        {activeOpen && (
          <>
            {activeTasks.map((t) => taskRow(t, toReview(t)))}
            {activeOwn.map(ownRow)}
            {!activeTasks.length && !activeOwn.length && <div className="py-1 pl-[26px] text-[12px] text-muted-foreground">没有进行中的</div>}
          </>
        )}
      </Drop>

      {/* Always listed, empty ones too: each is where a row is dragged to */}
      <>
          <Drop to="review" onMove={onMove}>
            <FoldTitle open={reviewOpen} onClick={foldReview}>
              待验收 {review.length + reviewOwn.length}
            </FoldTitle>
            {reviewOpen &&
              review.map((t) =>
                taskRow(
                  t,
                  <RowButton title="通过：移到已完成" onClick={() => move(t, "done")}>
                    <Check className="size-3.5" />
                  </RowButton>,
                ),
              )}
            {reviewOpen && reviewOwn.map(ownRow)}
          </Drop>
          <Drop to="todo" onMove={onMove}>
            <FoldTitle open={todoOpen} onClick={foldTodo}>
              待办 {todo.length}
            </FoldTitle>
            {todoOpen &&
              todo.map((t) =>
                taskRow(
                  t,
                  <RowButton title="派出去：交给 agent 开始做" onClick={() => move(t, "running")}>
                    <Play className="size-3.5" />
                  </RowButton>,
                ),
              )}
          </Drop>
          <Drop to="done" onMove={onMove}>
            <FoldTitle open={doneOpen} onClick={foldDone}>
              已完成 {done.length + doneOwn.length}
            </FoldTitle>
            {doneOpen && doneOwn.map(ownRow)}
            {doneOpen &&
              done.map((t) =>
                taskRow(
                  t,
                  <RowButton title="打回：移回进行中" onClick={() => move(t, "running")}>
                    <Undo2 className="size-3.5" />
                  </RowButton>,
                ),
              )}
          </Drop>
      </>
      {other.length > 0 && (
        <>
          <FoldTitle open={otherOpen} onClick={foldOther}>
            其他 {other.length}
          </FoldTitle>
          {otherOpen && other.map(ownRow)}
        </>
      )}
    </div>
  );
}

/**
 * A group as a place to drop rows on: Code's own rows (core useCodeRowDrop, lit up by Code) and ours (a task whose
 * conversation has no pane yet: plain HTML drag). The whole group, title included, so a folded one takes drops too.
 */
function Drop({ to, onMove, children }: { to: Status; onMove: (to: Status, row: { session?: string; task?: string }) => void; children: React.ReactNode }) {
  const ref = useCodeRowDrop((r) => onMove(to, { session: r.session }));
  const [over, setOver] = useState(false);
  return (
    <div
      ref={ref}
      className={clsx("rounded-md", over && "bg-brand/10 ring-2 ring-brand")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TASK_MIME)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const task = e.dataTransfer.getData(TASK_MIME);
        if (task) (e.preventDefault(), onMove(to, { task }));
      }}
    >
      {children}
    </div>
  );
}

function GroupTitle({ tone, children }: { tone?: "you"; children: React.ReactNode }) {
  return <div className={clsx("flex h-7 items-center pr-1 pl-[26px] text-[11px] font-medium select-none", tone === "you" ? "text-warn" : "text-muted-foreground")}>{children}</div>;
}

type AgentOpt = { id: string; name: string; default?: boolean };

/**
 * Which agent the secretary runs as, changed on its row: the same setting as 设置 → 谁派活 (settings.router.agent),
 * here because in the Code view the settings are two clicks away in the board. Who a conversation runs as is fixed
 * when it starts, so a change means a new conversation that carries the old one on (local/_main.ts); it is started
 * right away when the secretary is idle, and shown in place of the old one if that was the pane in front. Model and
 * effort go back to the new agent's defaults: they are names of the old agent's.
 * A native select: the panel's own menus are portaled into its page, which isn't drawn while Code shows.
 */
function AgentPick({ main, current }: { main?: string; current?: string }) {
  const [agents, setAgents] = useState<AgentOpt[]>([]);
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const changed = usePanelChange("user");
  useRefresh(() => run<{ settings: { router: { agent: string } } }>("settings.get").then((r) => setAgent(r.settings.router.agent ?? ""), () => {}), [changed], { fallback: 600_000, poll: 600_000 });
  // The list comes from Gerdr's own config (a few commands): once, not with every change of ours
  useRefresh(() => run<AgentOpt[]>("settings.agents").then(setAgents, () => {}), [], { fallback: 600_000, poll: 600_000 });
  if (!agents.length) return null;
  const def = agents.find((a) => a.default);
  const pick = async (id: string) => {
    setBusy(true);
    setAgent(id);
    try {
      await run("settings.set", { router: { agent: id, model: "", effort: "" } });
      const r = await run<{ main: string }>("secretary.open", {});
      if (main && current === main && r.main !== main) showInCode(r.main);
    } catch (e: any) {
      toast?.error?.(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <select
      value={agent}
      disabled={busy}
      title="秘书用哪个 agent：换了之后新开一段对话接着聊（之前说的都带着）；秘书正忙时，等它这一轮结束后的下一条消息起生效"
      className="max-w-[45%] shrink-0 cursor-pointer appearance-none truncate rounded-sm bg-transparent px-1 text-right text-[11px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground disabled:opacity-50"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => void pick(e.target.value)}
    >
      <option value="">{def ? `默认（${def.name}）` : "默认"}</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

function RowShell({ current, onClick, title, drag, children }: { current?: boolean; onClick: () => void; title?: string; /** A task's id: the row can be dragged onto a group */ drag?: string; children: React.ReactNode }) {
  return (
    <div
      role="button"
      title={title}
      onClick={onClick}
      draggable={!!drag}
      onDragStart={drag ? (e) => (e.dataTransfer.setData(TASK_MIME, drag), (e.dataTransfer.effectAllowed = "move")) : undefined}
      className={clsx(
        "group relative flex min-h-8 cursor-default items-center gap-2 rounded-md py-1 pr-2 pl-1.5 text-[12px] select-none",
        current ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent/60",
      )}
    >
      {children}
    </div>
  );
}

function RowButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      className="hidden size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground group-hover/task:flex hover:bg-muted hover:text-foreground [@media(hover:none)]:flex"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

/** What the row says under its title: what it waits on the person for, else the newest line of its worker. */
function lineOf(t: Task): string {
  if (t.column === "you") {
    const a = openAsks(t)[0];
    if (a) return `${a.handBack.kind === "none" ? "要你做" : "待你答"}：${a.title}`;
    if (t.live?.status === "waiting") return t.live.waiting || "等你审批";
    if (t.live?.status === "error") return t.live.error || "出错了";
    if (t.stopWhy) return t.stopWhy;
  }
  return (t.latest || t.summary || (t.status === "todo" ? t.prompt : "") || "").split("\n")[0];
}

/**
 * A task: Code's own row when its worker's conversation has a pane (so it's closed, renamed, split, dragged like any
 * row), ours when it hasn't been opened yet (a click opens it). Under it, what Code's row can't say: what it waits
 * on the person for, or its worker's newest line, and the one move that makes sense from where it stands.
 */
function TaskRow({ t, pane, current, action }: { t: Task; pane?: CodeRowInfo; current: boolean; action?: React.ReactNode }) {
  const you = t.column === "you" && t.status === "running";
  const busy = t.live?.status === "running";
  // Never empty: the line is also where the row's one move sits, and a row that grows on hover makes the list jump
  const line = lineOf(t) || (t.status === "todo" ? "还没派出去" : t.status === "review" ? "等你验收" : t.status === "done" ? "已完成" : t.id);
  return (
    <div className="group/task" title={`${t.id} ${t.title}${t.repo ? `\n${t.repo}` : ""}`}>
      {pane ? (
        <CodeRow pane={pane.pane} where={base(t.repo)} />
      ) : (
        <RowShell current={current} drag={t.id} onClick={() => t.session && showInCode(t.session)}>
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <span className={clsx("size-2 rounded-full", you ? "bg-warn" : busy ? "animate-pulse bg-ok" : "bg-muted-foreground/40")} />
          </span>
          <span className={clsx("min-w-0 flex-1 truncate", you && "font-medium")}>{t.title}</span>
          {t.repo && <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground">{base(t.repo)}</span>}
        </RowShell>
      )}
      {(line || action) && (
        <div className="group -mt-0.5 flex min-h-5 items-center gap-1 pr-2 pl-[26px]">
          <span className={clsx("min-w-0 flex-1 truncate text-[11px]", you ? "text-warn" : "text-muted-foreground")}>{line}</span>
          {action}
        </div>
      )}
    </div>
  );
}
