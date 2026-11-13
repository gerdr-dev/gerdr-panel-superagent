import { ChevronDown, ChevronRight, ExternalLink, GitFork, Settings2 } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState, type ReactNode } from "react";
import { run } from "../lib/gerdr";

// 链路: where a task came from and every conversation behind it, as a tree of any depth — the event, who handed
// it out, the router, its workers and whatever sessions they started in turn (Gerdr records each session's parent;
// local/tasks.ts tree). In the task's drawer, not the panel's agent's side: it belongs to the task. Picking a
// conversation shows it in the same drawer; in the router's, a way to the settings and rules it went by (设置, 流程), to tune them.

/** id: a session's, or a subagent's "<session>#<toolCallId>" (lib/convo.ts) — picking either shows it in the drawer. */
type Node = { id: string; title: string; agent: string; status: string; role: "router" | "worker" | "helper" | "subagent"; children: Node[] };
type Tree = {
  origin?: { source: string; kind: string; title?: string; url?: string };
  from?: { id: string; title: string };
  splits: { id: string; title: string }[];
  up: { id: string; title: string }[];
  roots: Node[];
};

const ROLE = { router: "秘书", worker: "worker", helper: "子会话", subagent: "子 agent" };
// The secretary's conversation is one for everything it judges: the name Gerdr gave it from its first turns says
// nothing about this task. What opening it shows instead
const ROUTER = "派这个任务时的判断";

function count(n: Node[]): number {
  return n.reduce((k, x) => k + 1 + count(x.children), 0);
}

export type TrailProps = {
  task: string;
  /** Changes when the task does (its updatedAt): the tree is fetched again. */
  version?: number;
  current?: string;
  router?: string;
  onSession: (id: string) => void;
  onTask: (id: string) => void;
  onRules?: () => void;
};

/**
 * `header` draws the drawer's title row with the 链路 toggle in it (null while there's nothing to show): a row of its
 * own took a whole line on a phone for one word. The list opens under that row.
 */
export function Trail({
  header,
  task,
  version,
  current,
  router,
  onSession,
  onTask,
  onRules,
}: TrailProps & { header: (toggle: ReactNode) => ReactNode }) {
  const [tree, setTree] = useState<Tree | null>(null);
  // Closed until clicked, even after switching to another conversation of the task: the user found it in the way
  const [open, setOpen] = useState(false);
  useEffect(() => {
    run<Tree>("tasks.tree", { id: task }).then(setTree, () => setTree(null));
  }, [task, version]);
  const n = tree ? count(tree.roots) : 0;
  if (!tree || (!n && !tree.origin && !tree.from && !tree.splits.length)) return <>{header(null)}</>;
  const summary = [
    tree.origin && `来自 ${tree.origin.source}`,
    tree.up.length > 0 && `${tree.up[tree.up.length - 1].title || "上一级"} 派的`,
    tree.from && `拆自 ${tree.from.id}`,
    n > 0 && `${n} 个对话`,
    tree.splits.length > 0 && `拆出 ${tree.splits.length} 个`,
  ]
    .filter(Boolean)
    .join(" · ");
  const row = "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px]";
  const node = (x: Node, depth: number): React.ReactNode => (
    <div key={x.id}>
      <button
        className={clsx(row, x.id === current ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
        style={{ paddingLeft: 6 + depth * 14 }}
        title={x.role === "router" ? ROUTER : x.title}
        onClick={() => onSession(x.id)}
      >
        <span className={clsx("size-1.5 shrink-0 rounded-full", x.status === "running" ? "bg-ok" : x.status === "waiting" || x.status === "error" ? "bg-warn" : "bg-muted-foreground/40")} />
        <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px]">{ROLE[x.role]}</span>
        <span className="min-w-0 flex-1 truncate">{x.role === "router" ? ROUTER : x.title}</span>
        {x.agent && <span className="shrink-0 text-[10px] text-muted-foreground">{x.agent}</span>}
      </button>
      {x.children.map((c) => node(c, depth + 1))}
    </div>
  );
  const toggle = (
    <button
      className={clsx("flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground", open && "bg-accent text-foreground")}
      title={`链路：${summary}`}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      <GitFork className="size-3.5" />
      <span className="max-md:hidden">链路</span>
      {n > 0 && <span className="tabular-nums">{n}</span>}
      {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
    </button>
  );
  const rules = current && router && current === router && onRules;
  return (
    <>
      {header(toggle)}
      {(open || rules) && (
    <div className="shrink-0 border-b px-3 py-1">
      {open && <div className="truncate px-1.5 pt-0.5 text-[11px] text-muted-foreground">{summary}</div>}
      {open && (
        <div className="max-h-[200px] space-y-0.5 overflow-y-auto pt-1 pb-1.5">
          {tree.origin &&
            (tree.origin.url ? (
              <a className={clsx(row, "text-muted-foreground hover:bg-accent/60 hover:text-foreground")} href={tree.origin.url} target="_blank" rel="noreferrer" title={tree.origin.title}>
                <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px]">来源</span>
                <span className="min-w-0 flex-1 truncate">{tree.origin.title || `${tree.origin.source}/${tree.origin.kind}`}</span>
                <ExternalLink className="size-3 shrink-0" />
              </a>
            ) : (
              <div className={clsx(row, "text-muted-foreground")}>
                <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px]">来源</span>
                <span className="min-w-0 flex-1 truncate">{tree.origin.title || `${tree.origin.source}/${tree.origin.kind}`}</span>
              </div>
            ))}
          {tree.up.map((u) => (
            <button key={u.id} className={clsx(row, "text-muted-foreground hover:bg-accent/60 hover:text-foreground")} title="派出这个任务的对话" onClick={() => onSession(u.id)}>
              <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px]">上一级</span>
              <span className="min-w-0 flex-1 truncate">{u.title}</span>
            </button>
          ))}
          {tree.from && (
            <button className={clsx(row, "text-muted-foreground hover:bg-accent/60 hover:text-foreground")} onClick={() => onTask(tree.from!.id)}>
              <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px]">拆自</span>
              <span className="min-w-0 flex-1 truncate">
                {tree.from.id} {tree.from.title}
              </span>
            </button>
          )}
          {tree.roots.map((r) => node(r, 0))}
          {tree.splits.map((x) => (
            <button key={x.id} className={clsx(row, "text-muted-foreground hover:bg-accent/60 hover:text-foreground")} onClick={() => onTask(x.id)}>
              <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px]">拆出</span>
              <span className="min-w-0 flex-1 truncate">
                {x.id} {x.title}
              </span>
            </button>
          ))}
        </div>
      )}
      {rules && (
        <button className="mb-1 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onRules}>
          <Settings2 className="size-3.5" />
          派得不对？改仓库、模型或派活规则
        </button>
      )}
    </div>
      )}
    </>
  );
}
