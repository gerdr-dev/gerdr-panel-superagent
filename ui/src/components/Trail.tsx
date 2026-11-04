import { ChevronDown, ChevronRight, ExternalLink, GitFork, Settings2 } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
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

const ROLE = { router: "调度", worker: "worker", helper: "子会话", subagent: "子 agent" };

function count(n: Node[]): number {
  return n.reduce((k, x) => k + 1 + count(x.children), 0);
}

export function Trail({
  task,
  version,
  current,
  router,
  onSession,
  onTask,
  onRules,
}: {
  task: string;
  /** Changes when the task does (its updatedAt): the tree is fetched again. */
  version?: number;
  current?: string;
  router?: string;
  onSession: (id: string) => void;
  onTask: (id: string) => void;
  onRules?: () => void;
}) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [open, setOpen] = useState(false);
  // Gone to another conversation (a subagent from 在等 or its chat card, a helper asking): the list opens, so it's clear
  // where in the task this is and how to get back. Not on the drawer's first showing
  const first = useRef(current);
  useEffect(() => {
    if (current !== first.current) setOpen(true);
  }, [current]);
  useEffect(() => {
    run<Tree>("tasks.tree", { id: task }).then(setTree, () => setTree(null));
  }, [task, version]);
  if (!tree) return null;
  const n = count(tree.roots);
  if (!n && !tree.origin && !tree.from && !tree.splits.length) return null;
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
        title={x.title}
        onClick={() => onSession(x.id)}
      >
        <span className={clsx("size-1.5 shrink-0 rounded-full", x.status === "running" ? "bg-ok" : x.status === "waiting" || x.status === "error" ? "bg-warn" : "bg-muted-foreground/40")} />
        <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px]">{ROLE[x.role]}</span>
        <span className="min-w-0 flex-1 truncate">{x.title}</span>
        {x.agent && <span className="shrink-0 text-[10px] text-muted-foreground">{x.agent}</span>}
      </button>
      {x.children.map((c) => node(c, depth + 1))}
    </div>
  );
  return (
    <div className="shrink-0 border-b px-3 py-1">
      <button className="flex w-full items-center gap-1.5 py-0.5 text-left text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <GitFork className="size-3.5" />
        <span className="font-medium text-foreground">链路</span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </button>
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
      {current && router && current === router && onRules && (
        <button className="mb-1 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onRules}>
          <Settings2 className="size-3.5" />
          派得不对？改仓库、模型或派活规则
        </button>
      )}
    </div>
  );
}
