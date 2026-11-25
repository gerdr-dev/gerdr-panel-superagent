import { ExternalLink, Link2Off, Loader2, Play, RotateCcw, Send, X } from "lucide-react";
import clsx from "clsx";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/Button";
import { run } from "../lib/gerdr";
import { since } from "../lib/tasks";
import { usePanelChange, useRefresh } from "../lib/visible";

// 去向: every outside message and where it went (local/superagent.ts log). Answers "what happened to the message I
// sent it?" without reading the main session's chat: handed to a task, judged not work (and why), or let through
// by nobody. What needs a person comes first: ones the main session gave no decision on, then the rest, newest first.
// 对话 is the other half: which task follows which conversation, so where the next message there goes before it comes
// (superagent.threads). That table sent a DM past the secretary to t229 and later to t202, and was shown nowhere (c700).

type Item = {
  id: string;
  at: number;
  state: "filtered" | "delivered" | "pending" | "accepted" | "attached" | "stopped" | "ignored" | "unavailable" | "observed" | "waiting";
  reason?: string;
  inferred?: boolean;
  rule?: string;
  would?: { title?: string; parts: { repo: string; agent?: string; model?: string; title?: string }[] };
  tasks?: string[];
  handBacks?: { task: string; reason: string; at?: number }[];
  via?: { task: string; why: "thread" | "wait" }[];
  linked?: boolean;
  hint?: string;
  event: { id: string; source: string; kind: string; key?: string; place?: string; actor?: string; who?: string; title?: string; text?: string; url?: string };
};

const STATE: Record<Item["state"], { label: string; tone: string }> = {
  pending: { label: "在判断", tone: "text-brand" },
  waiting: { label: "等你", tone: "text-warn" },
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
  const [view, setView] = useState<"items" | "threads">("items");
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 max-md:p-3">
      <header className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight">去向</h1>
          <div className="flex rounded-md border p-0.5 text-[12px]">
            {(
              [
                ["items", "消息"],
                ["threads", "对话"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={clsx("rounded px-2 py-0.5", view === k ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")} onClick={() => setView(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[13px] text-muted-foreground">
          {view === "items" ? (
            <>
              外面来的每条消息去了哪。已有任务的对话里的后续直接交给那个任务；其余的由 Superagent 判断是不是活、派给谁。
              「不是找你的」只按主动工作的规则接；规则还在「只记录」时，记成「本来会接」，看对了点「照做」。你自己在任务列表里建的任务不在这里。
            </>
          ) : (
            <>哪段对话有任务跟着、那里下一条消息会给谁。跟着的任务会直接收到那里的消息，不经过秘书；跟错了点「解绑」，之后那里的消息先给秘书判断。</>
          )}
        </p>
      </header>
      {view === "items" ? <Items onTask={onTask} /> : <Threads onTask={onTask} />}
    </div>
  );
}

function Items({ onTask }: { onTask: (id: string) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState("");
  const load = () =>
    run<{ items: Item[] }>("superagent.log", {}).then(
      (r) => (setItems(r.items), setErr("")),
      (e) => setErr(String(e.message || e)),
    );
  useRefresh(load, [usePanelChange("user/data")], { poll: 10_000 });
  const top = (x: Item) => x.state === "waiting" || x.state === "unavailable" || x.state === "observed";
  const first = (items ?? []).filter(top);
  const rest = (items ?? []).filter((x) => !top(x));
  return (
    <>
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
    </>
  );
}

function Row({ x, onTask, onRetried }: { x: Item; onTask: (id: string) => void; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 重新判断 opens a box first: the user usually disagrees with the last decision and wants to say how
  const [asking, setAsking] = useState(false);
  const [hint, setHint] = useState("");
  const st = STATE[x.state] ?? { label: x.state, tone: "" };
  const e = x.event;
  const again = x.state === "ignored" || x.state === "filtered" || x.state === "unavailable";
  const doIt = x.state === "observed" && !!x.would;
  const close = x.state === "pending" || x.state === "unavailable" || x.state === "waiting";
  const call = async (fn: string, input: unknown) => {
    setBusy(true);
    setErr("");
    try {
      await run(fn, input);
      setAsking(false);
      setHint("");
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
      <Clamped text={e.text || e.title || ""} />
      {x.rule && <p className="text-[12px] text-muted-foreground">按规则：{x.rule}</p>}
      {x.would && x.state === "observed" && (
        <p className="text-[12px] text-muted-foreground">
          会建「{x.would.title || "（标题取第一行）"}」，派到 {x.would.parts.map((p) => [p.repo.split("/").pop(), p.agent, p.model].filter(Boolean).join(" / ")).join("、")}
        </p>
      )}
      {x.via?.length || x.handBacks?.length ? (
        <Path x={x} onTask={onTask} />
      ) : (
        <>
          {x.reason && <p className="text-[12px] text-muted-foreground">{x.state === "pending" ? "" : x.state === "waiting" ? "秘书问你：" : "理由："}{x.reason}</p>}
          {x.state === "attached" && !x.reason && <p className="text-[12px] text-muted-foreground">理由：没写（那时并进还不要求写理由）</p>}
          {x.state === "attached" && x.linked && <p className="text-[12px] text-muted-foreground">这段对话之后的消息直接给 {x.tasks?.join("、")}（看「对话」）</p>}
        </>
      )}
      {x.hint && <p className="text-[12px] text-muted-foreground">你的意见：{x.hint}</p>}
      {asking && (
        <div className="space-y-2 pt-1">
          <textarea
            autoFocus
            rows={2}
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) call("superagent.retry", { ids: [x.id], hint });
              if (e.key === "Escape") setAsking(false);
            }}
            placeholder="给 Superagent 的意见，可不填（比如：这是活，导入到 xx 表，派给 yy 仓库）"
            className="w-full rounded-md border bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]"
          />
          <div className="flex items-center gap-2">
            <Button disabled={busy} onClick={() => call("superagent.retry", { ids: [x.id], hint })}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              重新判断
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
              取消
            </Button>
            {err && <span className="text-[12px] text-bad">{err}</span>}
          </div>
        </div>
      )}
      {!asking && (again || doIt || close || err) && (
        <div className="flex items-center gap-2">
          {doIt && (
            <Button disabled={busy} onClick={() => call("superagent.execute", { id: x.id })} title="照它判断的建任务、派出去">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              照做
            </Button>
          )}
          {again && (
            <Button variant="outline" disabled={busy} onClick={() => setAsking(true)} title="交给 Superagent 重新判断，可以附一句意见">
              <RotateCcw className="size-3.5" />
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

/**
 * The message, three lines at most until clicked: long requirements (a Meegle item's nodes and status) were cut off
 * with no way to read the rest here. Only clickable when something is actually hidden.
 */
function Clamped({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setCut(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <div>
      <p
        ref={ref}
        className={clsx("text-[13px] break-words whitespace-pre-wrap", !open && "line-clamp-3", (cut || open) && "cursor-pointer")}
        onClick={() => (cut || open) && !window.getSelection()?.toString() && setOpen(!open)}
      >
        {text}
      </p>
      {(cut || open) && (
        <button className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
          {open ? "收起" : "展开全部"}
        </button>
      )}
    </div>
  );
}

function TaskChip({ id, onTask }: { id: string; onTask: (id: string) => void }) {
  return (
    <button className="rounded-sm bg-muted px-1 font-mono text-[11px] text-foreground hover:bg-accent" onClick={() => onTask(id)}>
      {id}
    </button>
  );
}

/**
 * How a message got where it is, one hop per line: where it was said → the task(s) it went straight to and why →
 * who gave it back and why → what the secretary then decided. These were separate lines the user had to put together
 * (c700: a DM went straight to t229, came back, and the secretary attached it to t202).
 */
function Path({ x, onTask }: { x: Item; onTask: (id: string) => void }) {
  const e = x.event;
  const hops: { key: string; body: ReactNode }[] = [];
  hops.push({ key: "from", body: <>来自 {[e.source, e.place, e.who || e.actor].filter(Boolean).join(" · ")}</> });
  // Older items kept no via: a hand-back still means it went straight to that task first (only those can be given back)
  const via = x.via ?? x.handBacks?.map((h) => ({ task: h.task, why: undefined })) ?? [];
  for (const v of via)
    hops.push({
      key: `via-${v.task}`,
      body: (
        <>
          直接给 <TaskChip id={v.task} onTask={onTask} />：{v.why === "wait" ? "它在等这段对话里的回复" : v.why === "thread" ? "它跟着这段对话（从这里建的，或之前并进过）" : "它跟着这段对话（那时还没记是哪种）"}，不经过秘书
        </>
      ),
    });
  for (const h of x.handBacks ?? [])
    hops.push({
      key: `back-${h.task}`,
      body: (
        <>
          <TaskChip id={h.task} onTask={onTask} /> 交回{h.at ? `（${since(h.at)}前）` : ""}：{h.reason}
        </>
      ),
    });
  const st = STATE[x.state] ?? { label: x.state, tone: "" };
  if (x.state !== "delivered" || x.handBacks?.length) {
    const said = x.state === "pending" ? "" : x.reason || (x.state === "attached" ? "没写理由（那时并进还不要求写）" : "");
    hops.push({
      key: "sec",
      body: (
        <>
          秘书：<span className={clsx("font-medium", st.tone)}>{st.label}</span>
          {x.state !== "delivered" && x.tasks?.map((t) => <span key={t}> <TaskChip id={t} onTask={onTask} /></span>)}
          {said && <>{x.state === "waiting" ? "，问你：" : "，理由："}{said}</>}
          {x.state === "attached" && x.linked && <>；这段对话之后的消息直接给它</>}
        </>
      ),
    });
  }
  return (
    <ol className="space-y-0.5 border-l-2 border-border pl-2.5 text-[12px] text-muted-foreground">
      {hops.map((h) => (
        <li key={h.key} className="break-words">
          {h.body}
        </li>
      ))}
    </ol>
  );
}

type Conv = {
  source: string;
  key: string;
  place: string;
  url?: string;
  lastAt?: number;
  last?: string;
  tasks: { id: string; title: string; status: string; why: "thread" | "wait" }[];
  straight: boolean;
  to: string[];
  why: string;
};

/** 对话: superagent.threads, one card per conversation some task follows, with where its next message goes. */
function Threads({ onTask }: { onTask: (id: string) => void }) {
  const [list, setList] = useState<Conv[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const load = () =>
    run<{ conversations: Conv[] }>("superagent.threads", {}).then(
      (r) => (setList(r.conversations), setErr("")),
      (e) => setErr(String(e.message || e)),
    );
  useRefresh(load, [usePanelChange("user/data")], { poll: 10_000 });
  const ws = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (list ?? []).filter((c) => {
    const hay = [c.place, c.key, c.last, ...c.tasks.flatMap((t) => [t.id, t.title])].join(" ").toLowerCase();
    return ws.every((w) => hay.includes(w));
  });
  return (
    <>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="按人名、地方、任务找"
        className="w-full rounded-md border bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]"
      />
      {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}
      {!list && !err && <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>}
      {list?.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">还没有任务跟着哪段对话。</p>}
      <div className="space-y-2">
        {shown.map((c) => (
          <ConvRow key={`${c.source}\u0000${c.key}`} c={c} onTask={onTask} onChanged={load} />
        ))}
      </div>
    </>
  );
}

const ENDED = new Set(["done", "dropped"]);

function ConvRow({ c, onTask, onChanged }: { c: Conv; onTask: (id: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const unfollow = async (task: string) => {
    setBusy(task);
    setErr("");
    try {
      const r = await run<{ note: string }>("superagent.unfollow", { task, source: c.source, key: c.key });
      setNote(r.note);
      onChanged();
    } catch (er: any) {
      setErr(String(er.message || er));
    } finally {
      setBusy("");
    }
  };
  return (
    <article className="space-y-1.5 rounded-xl border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground">
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{c.place}</span>
        <span className="ml-auto shrink-0">{c.lastAt ? `${since(c.lastAt)}前` : ""}</span>
        {c.url && (
          <a href={c.url} target="_blank" rel="noreferrer" className="hover:text-foreground" title="打开这段对话">
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {c.last && <p className="truncate text-[13px]">{c.last}</p>}
      <p className="text-[12px]">
        下一条消息：
        {c.straight ? (
          <span className="text-ok">
            直接给 {c.to.map((t) => <TaskChip key={t} id={t} onTask={onTask} />)}，不经过秘书
          </span>
        ) : (
          <span className="text-muted-foreground">先给秘书判断（{c.why}）</span>
        )}
      </p>
      <ul className="space-y-1">
        {c.tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <TaskChip id={t.id} onTask={onTask} />
            <span className={clsx("min-w-0 flex-1 truncate", ENDED.has(t.status) ? "" : "text-foreground")}>{t.title}</span>
            <span className="shrink-0">{t.why === "wait" ? "在等这里的回复" : "跟着"}</span>
            {t.why === "thread" && (
              <Button variant="ghost" disabled={!!busy} onClick={() => unfollow(t.id)} title="这个任务不再跟着这段对话：之后那里的消息先给秘书判断">
                {busy === t.id ? <Loader2 className="size-3.5 animate-spin" /> : <Link2Off className="size-3.5" />}
                解绑
              </Button>
            )}
          </li>
        ))}
      </ul>
      {note && <p className="text-[12px] text-muted-foreground">{note}</p>}
      {err && <p className="text-[12px] text-bad">{err}</p>}
    </article>
  );
}
