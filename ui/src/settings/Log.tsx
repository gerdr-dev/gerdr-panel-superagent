import { ExternalLink, Loader2, Play, RotateCcw, X } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { Button } from "../components/Button";
import { run } from "../lib/gerdr";
import { since } from "../lib/tasks";
import { usePanelChange, useRefresh } from "../lib/visible";

// 去向: every outside message and where it went (local/superagent.ts log). Answers "what happened to the message I
// sent it?" without reading the main session's chat: handed to a task, judged not work (and why), or let through
// by nobody. What needs a person comes first: ones the main session gave no decision on, then the rest, newest first.

type Item = {
  id: string;
  at: number;
  state: "filtered" | "delivered" | "pending" | "accepted" | "attached" | "stopped" | "ignored" | "unavailable" | "observed";
  reason?: string;
  inferred?: boolean;
  rule?: string;
  would?: { title?: string; parts: { repo: string; agent?: string; model?: string; title?: string }[] };
  tasks?: string[];
  handBacks?: { task: string; reason: string }[];
  event: { id: string; source: string; kind: string; key?: string; actor?: string; who?: string; title?: string; text?: string; url?: string };
};

const STATE: Record<Item["state"], { label: string; tone: string }> = {
  pending: { label: "在判断", tone: "text-brand" },
  unavailable: { label: "没判断成", tone: "text-warn" },
  observed: { label: "本来会接", tone: "text-brand" },
  accepted: { label: "建了任务", tone: "text-ok" },
  attached: { label: "并进任务", tone: "text-ok" },
  delivered: { label: "交给任务", tone: "text-ok" },
  stopped: { label: "停了任务", tone: "text-muted-foreground" },
  ignored: { label: "没接", tone: "text-muted-foreground" },
  filtered: { label: "没收", tone: "text-muted-foreground" },
};

export default function Log({ onTask }: { onTask: (id: string) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState("");
  const load = () =>
    run<{ items: Item[] }>("superagent.log", {}).then(
      (r) => (setItems(r.items), setErr("")),
      (e) => setErr(String(e.message || e)),
    );
  useRefresh(load, [usePanelChange("user/data")], { poll: 10_000 });
  const top = (x: Item) => x.state === "unavailable" || x.state === "observed";
  const first = (items ?? []).filter(top);
  const rest = (items ?? []).filter((x) => !top(x));
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 max-md:p-3">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">去向</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          外面来的每条消息去了哪。已有任务的对话里的后续直接交给那个任务；其余的由 Superagent 判断是不是活、派给谁。
          「不是找你的」只按主动工作的规则接；规则还在「只记录」时，记成「本来会接」，看对了点「照做」。任务面板上自己建的任务不在这里。
        </p>
      </header>
      {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}
      {!items && !err && <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>}
      {items?.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">还没有消息进来。在「触发器」里选要收哪些。</p>
      )}
      <div className="space-y-2">
        {[...first, ...rest].map((x) => (
          <Row key={x.id} x={x} onTask={onTask} onRetried={load} />
        ))}
      </div>
    </div>
  );
}

function Row({ x, onTask, onRetried }: { x: Item; onTask: (id: string) => void; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const st = STATE[x.state] ?? { label: x.state, tone: "" };
  const e = x.event;
  const again = x.state === "ignored" || x.state === "filtered" || x.state === "unavailable";
  const doIt = x.state === "observed" && !!x.would;
  const close = x.state === "pending" || x.state === "unavailable";
  const call = async (fn: string, input: unknown) => {
    setBusy(true);
    setErr("");
    try {
      await run(fn, input);
      onRetried();
    } catch (er: any) {
      setErr(String(er.message || er));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="space-y-1 rounded-xl border bg-card px-3 py-2.5">
      {/* Wraps as whole pieces on a phone: without it each span squeezed into a column of one or two characters. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] whitespace-nowrap text-muted-foreground">
        {/* Who wrote it first, as bright as the text: the user scans this list by person */}
        {(e.who || e.actor) && <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{e.who || e.actor}</span>}
        <span className={clsx("font-medium", st.tone)}>{st.label}</span>
        {x.tasks?.map((t) => (
          <button key={t} className="rounded-sm bg-muted px-1 font-mono text-[11px] text-foreground hover:bg-accent" onClick={() => onTask(t)}>
            {t}
          </button>
        ))}
        <span className="min-w-0 truncate font-mono">
          {e.source}/{e.kind}
        </span>
        {x.inferred && <span className="rounded-sm bg-muted px-1 text-[10px]">不是找你的</span>}
        <span className="ml-auto shrink-0">{since(x.at)}前</span>
        {e.url && (
          <a href={e.url} target="_blank" rel="noreferrer" className="hover:text-foreground" title="打开原消息">
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      <p className="line-clamp-3 text-[13px] break-words whitespace-pre-wrap">{e.text || e.title}</p>
      {x.rule && <p className="text-[12px] text-muted-foreground">按规则：{x.rule}</p>}
      {x.would && x.state === "observed" && (
        <p className="text-[12px] text-muted-foreground">
          会建「{x.would.title || "（标题取第一行）"}」，派到 {x.would.parts.map((p) => [p.repo.split("/").pop(), p.agent, p.model].filter(Boolean).join(" / ")).join("、")}
        </p>
      )}
      {x.reason && <p className="text-[12px] text-muted-foreground">{x.state === "pending" ? "" : "理由："}{x.reason}</p>}
      {x.handBacks?.map((h) => (
        <p key={h.task} className="text-[12px] text-muted-foreground">
          {h.task} 交回：{h.reason}
        </p>
      ))}
      {(again || doIt || close || err) && (
        <div className="flex items-center gap-2">
          {doIt && (
            <Button disabled={busy} onClick={() => call("superagent.execute", { id: x.id })} title="照它判断的建任务、派出去">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              照做
            </Button>
          )}
          {again && (
            <Button variant="outline" disabled={busy} onClick={() => call("superagent.retry", { ids: [x.id] })} title="交给 Superagent 重新判断">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              重新判断
            </Button>
          )}
          {close && (
            <Button variant="ghost" disabled={busy} onClick={() => call("superagent.dismiss", { ids: [x.id] })} title="不用 Superagent 处理了：记成没接，之后还能重新判断">
              <X className="size-3.5" />
              关掉
            </Button>
          )}
          {err && <span className="text-[12px] text-bad">{err}</span>}
        </div>
      )}
    </article>
  );
}
