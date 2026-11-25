import * as core from "@gerdr/core";
import clsx from "clsx";
import { ArrowRightLeft, Ban, Bot, CheckCircle2, ChevronRight, Circle, CircleDashed, CircleDot, LayoutGrid, MessageSquare, Play, Plus, Settings } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { run } from "../lib/gerdr";
import { WholeWindow } from "../lib/portal";
import { NewTaskDialog, TaskDetail } from "./TaskDetail";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { openAsks, type Task, useTasks } from "../lib/tasks";
import { CodeRow, type CodeRowInfo, closeCodeDrawer, newCodeTab, useCodeDirs, openSettings, showInCode, useCodeRowDrop, useCodeRowMenu, useCodeRows, useCodeSession } from "../lib/view";
import { usePanelChange, usePanelVisible, useRefresh, useSessions } from "../lib/visible";

// Code's whole list, drawn by this panel (lib/view.ts, layout.tsx; core CodeView list="replace"): not Code's
// workspaces but where each piece of work stands. The secretary first; then 等你, 进行中, 待验收, 待办 — the tasks the
// secretary handed out and the person's own conversations in the same groups (2026-11-24, the person: the groups on
// the left are the board's statuses, not workspaces) — and 其他 for panes that aren't conversations (a terminal, a
// file, a browser page). A row whose conversation has a pane is Code's own row (core CodeRow).
//
// A task's group is its status, which only the person changes (DESIGN.md). Their own conversations have none: one is
// 进行中 while its tab is open and 等你 while its agent waits on them (an approval, an error); closing it ends it.

const AgentIcon = (core as unknown as { AgentIcon?: (p: { agent: string; className?: string }) => React.ReactNode }).AgentIcon;
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

/** A status's icon, the board's own (its columns' titles had them): the same four in the groups' titles and in 移到…. */
const STATUS_ICON: Record<Status, React.ReactNode> = {
  todo: <Circle className="size-3.5 shrink-0 text-muted-foreground max-md:size-4" />,
  running: <CircleDashed className="size-3.5 shrink-0 text-brand max-md:size-4" />,
  review: <CircleDot className="size-3.5 shrink-0 text-ok max-md:size-4" />,
  done: <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground max-md:size-4" />,
};

/**
 * A group's title, laid out as a row is (Code's Row: the icon column, then the text): the status icon sits where the
 * rows' icons do and the name starts where their titles do, so the list reads as one column. The fold arrow follows
 * the name, small, in every group alike (其他, which had no icon, got one: with its arrow in the icon column it folded
 * from the other side than the rest). Before, arrow + icon pushed the name right of the titles under it. Sizes follow
 * Code's rows on a phone (max-md: the drawer's roomier rows).
 */
function FoldTitle({ open, onClick, icon, label, children }: { open: boolean; onClick: () => void; icon: React.ReactNode; label: React.ReactNode; children?: React.ReactNode }) {
  const arrow = <ChevronRight className={clsx("size-3 shrink-0 transition-transform", open && "rotate-90")} />;
  return (
    <button className="flex h-7 w-full items-center gap-2 rounded-md pr-1 pl-1.5 text-[11px] font-medium text-muted-foreground select-none hover:bg-accent/60 hover:text-foreground max-md:h-9" onClick={onClick}>
      <span className="flex size-3.5 shrink-0 items-center justify-center max-md:size-4">{icon}</span>
      <span className="flex min-w-0 items-center gap-1">
        {label}
        {arrow}
      </span>
      <span className="flex-1" />
      {children}
    </button>
  );
}
const base = (p?: string) => (p ?? "").replace(/\/+$/, "").split("/").pop() ?? "";

type Main = { id: string; status: string; waiting?: string } | null;
type Sess = { id: string; status: string; agent?: string; updatedAt?: number; turn?: { startedAt?: number }; tags?: Record<string, string> };
/** What the functions last answered, for the next mount to start from. */
const last: { main: Main; asks: number; standing: Record<string, "review" | "done">; agents: AgentOpt[]; agent: string; repos: { path: string }[] } = {
  main: null,
  asks: 0,
  standing: {},
  agents: [],
  agent: "",
  repos: [],
};
type Status = "todo" | "running" | "review" | "done";
const LABEL: Record<Status, string> = { todo: "待办", running: "进行中", review: "待验收", done: "已完成" };
const ICON: Record<"running" | "review" | "done", React.ReactNode> = { running: <CircleDashed />, review: <CircleDot />, done: <CheckCircle2 /> };
/** A task row of ours being dragged (rows that are Code's own are dragged by Code: useCodeRowDrop). */
const TASK_MIME = "text/x-gerdr-task";

/** The list as Fusion draws it, for CodeSection to put where Code's list goes. */
const ListContext = createContext<React.ReactNode>(null);

/**
 * The list, put into Code's frame (layout.tsx gives it to CodeView as `sidebar`). Nothing else: what it shows and
 * everything that goes with it (the tasks, the menus' items, the folders offered) lives in Fusion, which is mounted
 * for as long as the panel is. This is only mounted while Code's list is on screen: on a phone, while the drawer is
 * open. When all of it lived here, a phone with the drawer closed had no 移到… in a pane's ⋯ menu at all (they were
 * registered from here), and every opening of the drawer started from nothing.
 */
export function CodeSection() {
  return useContext(ListContext);
}

/** The panel's working part, around CodeView: follows the tasks and the panes, gives Code's menus and pages our items, and draws the list. */
export function Fusion({ children }: { children: React.ReactNode }) {
  const { tasks, act } = useTasks();
  const cur = useCodeSession();
  const rows = useCodeRows();
  // From what was last known (see lib/tasks.ts lastTasks: this mounts anew with every opening of a phone's drawer)
  const [main, setMain] = useState<Main>(last.main);
  const [asks, setAsks] = useState(last.asks);
  // Which session is the secretary only changes with the log (pushed); its status is followed live below
  useRefresh(
    () =>
      run<{ main: Main; asks?: { open: unknown[] } }>("superagent.log", { limit: 1 }).then(
        (r) => {
          last.main = r.main;
          last.asks = r.asks?.open?.length ?? 0;
          setMain(last.main);
          setAsks(last.asks);
        },
        () => {},
      ),
    [usePanelChange("user/data")],
    { poll: 10_000 },
  );
  // The conversations in Code's panes, and the secretary: what each is doing now
  const open = new Set(rows.map((r) => r.session).filter(Boolean) as string[]);
  const openKey = [...open].sort().join(",");
  // …and every worker's, pane or not: which agent it is (its row's icon)
  const live = useSessions((s) => open.has(s.id) || s.id === main?.id || !!s.tags?.task) as Sess[];
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
  const [standing, setStanding0] = useState<Record<string, "review" | "done">>(last.standing);
  const setStanding = (f: Record<string, "review" | "done"> | ((cur: Record<string, "review" | "done">) => Record<string, "review" | "done">)) =>
    setStanding0((cur) => (last.standing = typeof f === "function" ? f(cur) : f));
  useRefresh(
    () =>
      run<{ standing: Record<string, "review" | "done"> }>("own.get").then(
        (r) => setStanding(r.standing),
        () => {},
      ),
    [usePanelChange("user/data")],
    { poll: 30_000 },
  );
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

  // The new-conversation page's quick picks are the repositories in 设置 → 仓库 (the person: that page should take them
  // from here, not from Code's workspaces, which this panel doesn't show; Code mode keeps its own). The same list the
  // secretary picks from, so a conversation started by hand lands where one it dispatched would
  const [repos, setRepos] = useState<{ path: string }[]>(last.repos);
  // Which agent the secretary runs as (设置 → 秘书 → agent, settings.router.agent), and the ones there are
  const [agent, setAgent] = useState(last.agent);
  const [agents, setAgents] = useState<AgentOpt[]>(last.agents);
  useRefresh(
    () =>
      run<{ settings: { repos: { path: string }[]; router: { agent: string } } }>("settings.get").then(
        (r) => (setRepos((last.repos = r.settings.repos ?? [])), setAgent((last.agent = r.settings.router.agent ?? ""))),
        () => {},
      ),
    [usePanelChange("user")],
    { fallback: 600_000, poll: 600_000 },
  );
  // The list comes from Gerdr's own config (a few commands): once, not with every change of ours
  useRefresh(
    () =>
      run<AgentOpt[]>("settings.agents").then(
        (a) => setAgents((last.agents = a)),
        () => {},
      ),
    [],
    { fallback: 600_000, poll: 600_000 },
  );
  // Who a conversation runs as is fixed when it starts, so a change means a new conversation that carries the old
  // one on (local/_main.ts): started right away when the secretary is idle, and shown in place of the old one when
  // that was the pane in front. Model and effort go back to the new agent's defaults: they are names of the old one's
  const pickAgent = async (id: string) => {
    setAgent((last.agent = id));
    try {
      await run("settings.set", { router: { agent: id, model: "", effort: "" } });
      const r = await run<{ main: string }>("secretary.open", {});
      if (main && cur === main.id && r.main !== main.id) showInCode(r.main);
    } catch (e: any) {
      toast?.error?.(String(e?.message ?? e));
    }
  };
  useCodeDirs(repos.map((r) => ({ path: r.path, name: base(r.path) })));

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
  // Before the tasks are known at all (the very first load), a worker's pane is told by its tag and waits for its
  // task rather than show among the person's own and jump groups a second later
  const unknownTask = (id: string) => tasks == null && !!byId[id]?.tags?.task;
  const own = rows.filter((r) => r.kind === "session" && !(r.session && (taskOf.has(r.session) || isMain(r.session) || unknownTask(r.session))));
  const needs = (r: CodeRowInfo) => !!r.session && (byId[r.session]?.status === "waiting" || byId[r.session]?.status === "error");
  const stands = (r: CodeRowInfo) => (r.session ? standing[r.session] : undefined);
  const youOwn = own.filter((r) => needs(r) && stands(r) !== "done");
  const activeOwn = own.filter((r) => !stands(r) && !needs(r));
  const reviewOwn = own.filter((r) => stands(r) === "review" && !needs(r));
  const doneOwn = own.filter((r) => stands(r) === "done");
  // A tab with no conversation started in it ("新会话") isn't work in progress, and mostly isn't anyone's doing: Code
  // keeps one in every workspace that has nothing else, so with the workspaces not shown they turned up in 进行中 one
  // per empty workspace, and closing one only made Code put it back. Not listed, except the one in front (so the
  // list still says where one is), under 其他.
  const other = rows.filter((r) => r.kind !== "session" && (r.kind !== "new" || r.current));
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
  // A task's menu items, the same wherever its menu is: Code's (its pane's ⋯, its row's right click) or our own row's
  // when its conversation has no pane. 待办 → 进行中 is handing it out
  const taskItems = (t: Task) => [
    ...(["running", "review", "done"] as const)
      .filter((to) => to !== t.status && (t.session || to === "running"))
      .map((to) => ({ id: `move-${to}`, label: t.status === "todo" ? "派出去" : `移到${LABEL[to]}`, icon: ICON[to], onSelect: () => onMove(to, { task: t.id }) })),
    { id: "drop", label: "放弃任务", icon: <Ban />, danger: true, onSelect: () => void act("drop", { id: t.id }).catch((e) => toast?.error?.(String(e?.message ?? e))) },
  ];
  // The same moves in the pane's ⋯ menu and the row's right-click menu: the only way on a phone (no hover, no drag)
  useCodeRowMenu(({ session }) => {
    // The secretary's own conversation: which agent it runs as. Here, in its pane's ⋯ menu, rather than a dropdown on
    // its row in the list, where it took a third of the row for something changed once in a while (the person,
    // 2026-11-24). 设置 → 秘书 has it too, with the model and effort
    if (session && isMain(session)) {
      const def = agents.find((a) => a.default);
      const now = agents.find((a) => a.id === agent)?.name ?? (def ? `默认（${def.name}）` : "默认");
      return [
        {
          id: "agent",
          label: `秘书的 agent：${now}`,
          icon: <Bot />,
          // A second level, unfolded when picked: listed outright, seven agents made the menu twice as long
          children: [{ id: "", name: def ? `默认（${def.name}）` : "默认" }, ...agents]
            .filter((a) => a.id !== agent)
            .map((a) => ({ id: `agent-${a.id || "default"}`, label: `换成 ${a.name}`, icon: <ArrowRightLeft />, onSelect: () => void pickAgent(a.id) })),
        },
      ];
    }
    if (!session) return [];
    const t = taskOf.get(session);
    if (t) return taskItems(t);
    const at: Status = standing[session] ?? "running";
    return (["running", "review", "done"] as const).filter((to) => to !== at).map((to) => ({ id: `move-${to}`, label: `移到${LABEL[to]}`, icon: ICON[to], onSelect: () => onMove(to, { session }) }));
  });
  // No buttons on the rows for moving a task (there was a ✓ at the end of its line): every status is changed from the
  // menus (the pane's ⋯, the row's right click) or by dragging, one way for all. The exception is 待办: a task not
  // handed out has no conversation, so no pane and no menu, and its ▶ is the only way to start it on a phone
  const taskRow = (t: Task, action?: React.ReactNode) => (
    <TaskRow
      key={t.id}
      t={t}
      pane={t.session ? paneOf.get(t.session) : undefined}
      current={(!!t.session && cur === t.session) || detail === t.id}
      action={action}
      agent={(t.session && byId[t.session]?.agent) || t.agent}
      menu={taskItems(t)}
      onDetail={() => openDetail(t.id)}
    />
  );
  const ownRow = (r: CodeRowInfo) => <CodeRow key={r.pane} pane={r.pane} where={base(r.cwd)} />;

  // One order for a group, tasks and the person's own conversations together (they aren't told apart): what's
  // running now first, then by when each last moved, newest first. "Moved" is when its turn started, not its last
  // output (as Code sorts its rows): a row mustn't climb with every line its agent prints. Before this the tasks came first and the person's own followed in Code's
  // order, workspace by workspace, which read as no order at all once the workspaces weren't shown.
  const at = (id?: string) => (id && byId[id] ? (byId[id].turn?.startedAt ?? byId[id].updatedAt ?? 0) : 0);
  const busy = (id?: string) => !!id && byId[id]?.status === "running";
  const sorted = (ts: Task[], rs: CodeRowInfo[]) =>
    [
      ...ts.map((t) => ({ run: busy(t.session) || t.live?.status === "running", at: Math.max(at(t.session), t.live?.turnStartedAt ?? 0) || t.updatedAt, el: taskRow(t) })),
      ...rs.map((r) => ({ run: busy(r.session), at: at(r.session), el: ownRow(r) })),
    ]
      .sort((a, b) => Number(b.run) - Number(a.run) || b.at - a.at)
      .map((x) => x.el);

  // A task not handed out has no conversation to open: its row opens the board's card for it (TaskDetail), over the
  // whole window. Without it such a task could only be started as it was: no way to read what was asked, set its
  // repository, answer whoever asked, or give it up (lost with the board, 2026-11-25)
  const [detail, setDetail] = useState("");
  const [creating, setCreating] = useState(false);
  const detailTask = detail ? all.find((t) => t.id === detail) : undefined;
  const byTask = useMemo(() => Object.fromEntries(all.map((t) => [t.id, t])), [tasks]);
  const openDetail = (id: string) => (closeCodeDrawer(), setDetail(id));
  // Handed out meanwhile (its ▶, or 派出去 in the card): the card gives way to its worker's conversation
  useEffect(() => {
    if (detailTask?.session && detailTask.status !== "todo") (setDetail(""), showInCode(detailTask.session));
  }, [detailTask?.session, detailTask?.status]);
  const panelShown = usePanelVisible();
  useEffect(() => {
    if (!panelShown) (setDetail(""), setCreating(false));
  }, [panelShown]);
  const overlays = (
    <WholeWindow>
      {detailTask && <TaskDetail t={detailTask} byId={byTask} act={act} onClose={() => setDetail("")} onGo={setDetail} onSession={(id) => (setDetail(""), showInCode(id))} />}
      {creating && <NewTaskDialog act={act} onClose={() => setCreating(false)} />}
    </WholeWindow>
  );

  const list = (
    <div className="pt-1.5 pb-1" data-fusion-section>
      <RowShell current={!!main && cur === main.id} onClick={openMain} title="和秘书说话：交给它的事、它怎么判断外面来的消息、派给了谁，都在这段对话里">
        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground max-md:size-4" />
        <span className="min-w-0 flex-1 truncate font-medium">秘书</span>
        {/* As everywhere in the list: what it asks of the person is 等你 N in amber (it read 「2 个问题」 here, a second
            word for the same thing), and what it's doing is a dot, as on any agent's row — running, waiting, failed —
            not words (「在判断」) */}
        {asks > 0 ? (
          <span className="shrink-0 rounded-full bg-warn px-1.5 text-[10px] leading-4 font-semibold text-background tabular-nums">等你 {asks}</span>
        ) : (
          status &&
          status !== "idle" && (
            <span
              title={status === "running" ? "在干活" : status === "waiting" ? "等你回答" : status === "error" ? "出错了" : status}
              className={clsx("size-2 shrink-0 rounded-full", status === "running" ? "bg-ok" : status === "error" ? "bg-bad" : "bg-warn")}
            />
          )
        )}
        <button
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          title="秘书背后的东西：设置（谁干活、仓库）、流程、记忆、触发器、定时任务、外面来的消息的去向"
          onClick={(e) => (e.stopPropagation(), openSettings("settings"))}
        >
          <Settings className="size-3.5" />
        </button>
      </RowShell>

      {/* 待办 first (the person, 2026-11-25): what hasn't been started is what to look at before what runs by itself */}
      <Drop to="todo" onMove={onMove}>
        <FoldTitle open={todoOpen} onClick={foldTodo} icon={STATUS_ICON.todo} label={`待办 ${todo.length}`}>
          <span
            role="button"
            className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
            title="新任务：写清楚要做什么，选仓库和 agent；先放在待办，或者直接派出去"
            onClick={(e) => (e.stopPropagation(), closeCodeDrawer(), setCreating(true))}
          >
            <Plus className="size-3.5" />
          </span>
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

      <Drop to="running" onMove={onMove}>
        <FoldTitle open={activeOpen} onClick={foldActive} icon={STATUS_ICON.running} label={`进行中 ${you + activeTasks.length + activeOwn.length}`}>
          {/* What waits on the person is in 进行中, first and in amber, not a group of its own: DESIGN.md, 2026-11-13
              (「不需要 等你 和 进行中。否则就是会跳来跳去…等我的直接提前，黄色」). It was a group here for a day, right under
              the secretary, and read as something of the secretary's rather than work in progress */}
          {you > 0 && <span className="rounded-full bg-warn px-1.5 text-[10px] leading-4 font-semibold text-background tabular-nums">等你 {you}</span>}
          <span
            role="button"
            className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
            title="新对话：自己随手开一个，不经过秘书"
            onClick={(e) => (e.stopPropagation(), newCodeTab())}
          >
            <Plus className="size-3.5" />
          </span>
        </FoldTitle>
        {/* Shown with the group folded too: they are the reason to look */}
        {sorted(youTasks, youOwn)}
        {activeOpen && (
          <>
            {sorted(activeTasks, activeOwn)}
            {!you && !activeTasks.length && !activeOwn.length && <div className="py-1 pl-[26px] text-[12px] text-muted-foreground">没有进行中的</div>}
          </>
        )}
      </Drop>

      {/* Always listed, empty ones too: each is where a row is dragged to */}
      <>
        <Drop to="review" onMove={onMove}>
          <FoldTitle open={reviewOpen} onClick={foldReview} icon={STATUS_ICON.review} label={`待验收 ${review.length + reviewOwn.length}`} />
          {reviewOpen && sorted(review, reviewOwn)}
        </Drop>
        <Drop to="done" onMove={onMove}>
          <FoldTitle open={doneOpen} onClick={foldDone} icon={STATUS_ICON.done} label={`已完成 ${done.length + doneOwn.length}`} />
          {doneOpen && sorted(done, doneOwn)}
        </Drop>
      </>
      {other.length > 0 && (
        <>
          <FoldTitle open={otherOpen} onClick={foldOther} icon={<LayoutGrid className="size-3.5 shrink-0 text-muted-foreground max-md:size-4" />} label={`其他 ${other.length}`} />
          {otherOpen && other.map(ownRow)}
        </>
      )}
    </div>
  );
  return (
    <ListContext.Provider value={list}>
      {children}
      {overlays}
    </ListContext.Provider>
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

type AgentOpt = { id: string; name: string; default?: boolean };

function RowShell({
  current,
  onClick,
  title,
  drag,
  children,
}: {
  current?: boolean;
  onClick: () => void;
  title?: string;
  /** A task's id: the row can be dragged onto a group */ drag?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="button"
      title={title}
      onClick={onClick}
      draggable={!!drag}
      onDragStart={drag ? (e) => (e.dataTransfer.setData(TASK_MIME, drag), (e.dataTransfer.effectAllowed = "move")) : undefined}
      className={clsx(
        // Code's Row metrics (UnifiedSidebar): h-7 beside the rail, 44px in a phone's drawer. pr-1 as the groups'
        // titles: the button at this row's end (the secretary's gear) stands over theirs (进行中's +)
        "group relative flex min-h-7 cursor-default items-center gap-2 rounded-md py-0.5 pr-1 pl-1.5 text-[12px] select-none max-md:min-h-11 max-md:py-1.5",
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
      // Its room is always kept (invisible, not hidden) and it's no taller than the line: appearing on hover it made
      // the row grow and the list jump
      className="invisible flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground group-hover/task:visible hover:bg-muted hover:text-foreground [@media(hover:none)]:visible"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

/** `text` without `title` at its start (and the punctuation that joined them); all of it when it doesn't start so. */
function sameStart(text: string, title: string): string {
  const a = text.trim();
  const b = title.trim();
  if (!b || !a.startsWith(b)) return a;
  return a.slice(b.length).replace(/^[\s:：,，、。.\-—–|/·]+/, "");
}

/** What the row says under its title: what it waits on the person for, else the newest line of its worker. */
function lineOf(t: Task): string {
  if (t.column === "you") {
    // What waits on the person, counted as they would: an ask with several questions is that many things to
    // answer, not one (a card), and a step to do isn't a question. The worker's own title for the card isn't used
    // for the count: it said 「3 个问题要你定」 for one card while a second card asked for a step — four things, which
    // the line gave as 「3 个问题…（共 2 件）」. Then the first of them, by its own words
    const asks = openAsks(t);
    if (asks.length) {
      const open = (a: (typeof asks)[number]) => (a.questions ?? []).filter((q) => !q.answer && !q.dropped && !q.skipped);
      // One word for all of it, the group's own (等你): whether it's a question to answer, a step to do or a value to
      // hand over is what the title says, and three labels for "it needs you" were three things to decode
      const things = asks.flatMap((a) => (a.handBack.kind === "questions" && open(a).length ? open(a).map((q) => q.title) : [a.title]));
      const first = sameStart(things[0], t.title);
      const head = things.length > 1 ? `等你 ${things.length}` : "等你";
      return first ? `${head}：${first}` : head;
    }
    if (t.live?.status === "waiting") return t.live.waiting || "等你审批";
    if (t.live?.status === "error") return t.live.error || "出错了";
    if (t.stopWhy) return t.stopWhy;
  }
  return (t.latest || t.summary || (t.status === "todo" ? t.prompt : "") || (t.status === "running" ? t.stopWhy : "") || "").split("\n")[0];
}

/**
 * A task: Code's own row when its worker's conversation has a pane (so it's closed, renamed, split, dragged like any
 * row), ours when it hasn't been opened yet (a click opens it). Under it, what Code's row can't say: what it waits
 * on the person for, or its worker's newest line, and the one move that makes sense from where it stands.
 */
function TaskRow({ t, pane, current, action, agent, menu, onDetail }: { t: Task; pane?: CodeRowInfo; current: boolean; action?: React.ReactNode; agent?: string; menu: RowMenuItem[]; onDetail: () => void }) {
  const you = t.column === "you" && t.status === "running";
  const busy = t.live?.status === "running";
  const line = lineOf(t) || (t.status === "todo" ? "还没派出去" : "");
  // The task's number leads its line: the secretary, the workers, 去向 and the cards all name tasks by it (t202), and
  // with the board gone nothing showed which row that was (the person, 2026-11-25: 「很多地方还在说编号…还是显示出来吧」)
  const text = (
    <span className={clsx("block truncate text-[11px]", you ? "text-warn" : "text-muted-foreground")}>
      <span className="mr-1.5 font-mono text-[10.5px] text-muted-foreground">{t.id}</span>
      {line}
    </span>
  );
  // Its conversation has a pane: Code's own row with our line inside it (core CodeRow `below`), so the whole of it is
  // one item — hovered, clicked, right-clicked and dragged as one. The line used to be a box of ours under Code's
  // row, patched to look like part of it: the menu and the drag still only took on the title
  if (pane) return <CodeRow pane={pane.pane} where={base(t.repo)} below={text} />;
  return (
    // No pane (not handed out, or its conversation isn't open): a row of ours, the line included in the one block
    <RowMenu items={menu}>
      <div
        className={clsx(
          "group/task rounded-md [&>div:first-child]:bg-transparent [&>div:first-child]:hover:bg-transparent",
          current ? "bg-accent" : "hover:bg-accent/60",
          "data-[state=open]:ring-1 data-[state=open]:ring-brand/60",
        )}
        title={`${t.id} ${t.title}${t.repo ? `\n${t.repo}` : ""}`}
      >
        <RowShell current={current} drag={t.id} onClick={() => (t.session ? showInCode(t.session) : onDetail())}>
          {/* The agent's icon, as on Code's rows: with a dot here instead, the same kind of task had an icon or a dot by
              whether its conversation happened to be open in a pane, which says nothing to the person. A dot only
              while no agent has it yet (待办, not handed out) */}
          {agent && AgentIcon ? (
            <AgentIcon agent={agent} className="size-3.5 shrink-0 max-md:size-4" />
          ) : (
            <span className="flex size-3.5 shrink-0 items-center justify-center max-md:size-4">
              <span className={clsx("size-2 rounded-full", you ? "bg-warn" : busy ? "animate-pulse bg-ok" : "bg-muted-foreground/40")} />
            </span>
          )}
          <span className={clsx("min-w-0 flex-1 truncate", you && "font-medium")}>{t.title}</span>
          {t.repo && <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground">{base(t.repo)}</span>}
        </RowShell>
        {
          // Starts where the titles do: the row's left padding + its icon + the gap (28px; a phone's icon is 16px: 30px)
          // -mt / pb: it belongs to the row above. That row ends in padding (6px in a phone's drawer) and the next one
          // starts with as much, so at the row's own distance the line sat nearer the row under it than its own
          // The pull-up is for a phone's roomier row (it ends in 6px of padding); a desktop's row has none to make up for
          <div className="flex cursor-default items-center gap-1 pr-2 pb-1 pl-7 leading-4 max-md:-mt-1.5 max-md:pb-1.5 max-md:pl-[30px]" onClick={() => (t.session ? showInCode(t.session) : onDetail())}>
            <span className="min-w-0 flex-1">{text}</span>
            {action}
          </div>
        }
      </div>
    </RowMenu>
  );
}
