import { CirclePause, CirclePlay, Clock, Loader2, Play, RotateCw } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { project, run } from "../lib/gerdr";
import { since } from "../lib/tasks";

// 定时任务: schedules/<id>.json, what this Work does by itself on time (Gerdr runs them with the App closed too).
// The list and its runs come from Gerdr's /api/work/schedules; changing when one runs rewrites its file
// (local/schedules.ts). Run now / pause / resume are Gerdr's, and this machine's only.

type Run = { startedAt: string; ms: number; ok: boolean; error?: string; result?: string; runId?: string };
type Item = { id: string; fn?: string; prompt?: string; name?: string; every?: string; at?: string; paused?: boolean; running?: boolean; last?: Run; fails?: number; next?: string };

async function api<T>(method: string, path: string): Promise<T> {
  const res = await fetch(path, { method, credentials: "same-origin", headers: { "X-Gerdr": "1", "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
  const data = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

export default function SchedulesPage() {
  const [list, setList] = useState<Item[] | null>(null);
  const [err, setErr] = useState("");
  const load = () =>
    api<{ list: Item[] }>("GET", `/api/work/schedules?project=${encodeURIComponent(project)}`).then(
      (r) => (setList(r.list), setErr("")),
      (e) => setErr(String(e.message || e)),
    );
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
    return () => clearInterval(t);
  }, []);
  const op = async (id: string, what: "run" | "pause" | "resume") => {
    try {
      await api("POST", `/api/work/schedules/${encodeURIComponent(id)}/${what}?project=${encodeURIComponent(project)}`);
    } catch (e: any) {
      setErr(String(e.message || e));
    }
    setTimeout(load, 400);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 max-md:p-3">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">定时任务</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          这个 Work 到点自己做的事（<span className="font-mono">schedules/</span>）。Gerdr 后台开着就会跑，App 关着也一样；错过的只补跑一次。
        </p>
      </header>
      {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}
      {!list && !err && <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>}
      {list?.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">还没有定时任务。让右边的助手加一个，比如「每 5 分钟盯一下我的 MR」。</p>}
      <div className="space-y-3">
        {list?.map((s) => (
          <Row key={s.id} s={s} onOp={(w) => op(s.id, w)} onSaved={load} />
        ))}
      </div>
    </div>
  );
}

function Row({ s, onOp, onSaved }: { s: Item; onOp: (w: "run" | "pause" | "resume") => void; onSaved: () => void }) {
  const [mode, setMode] = useState<"every" | "at">(s.at ? "at" : "every");
  const [val, setVal] = useState(s.at ?? s.every ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const cur = s.at ?? s.every ?? "";
  const changed = val.trim() !== cur || (mode === "at") !== !!s.at;
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      await run("schedules.setTiming", mode === "at" ? { id: s.id, at: val } : { id: s.id, every: val });
      onSaved();
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };
  const last = s.last;
  return (
    <article className="space-y-3 rounded-xl border bg-card p-4 max-md:p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[14px] font-medium">
            {s.name || s.id}
            {s.paused && <span className="rounded-sm bg-muted px-1.5 text-[11px] font-normal text-muted-foreground">已暂停</span>}
            {s.running && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          </h2>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{s.fn ? `跑 ${s.fn}` : `交给助手：${s.prompt}`}</p>
        </div>
        <div className="flex gap-1.5">
          <Button variant="outline" disabled={s.running} onClick={() => onOp("run")}>
            <Play className="size-3.5" />
            立即运行
          </Button>
          <Button variant="ghost" onClick={() => onOp(s.paused ? "resume" : "pause")}>
            {s.paused ? <CirclePlay className="size-3.5" /> : <CirclePause className="size-3.5" />}
            {s.paused ? "恢复" : "暂停"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Clock className="size-3.5 text-muted-foreground" />
        <select className="h-8 rounded-md border bg-background px-2 text-[13px]" value={mode} onChange={(e) => (setMode(e.target.value as any), setVal(e.target.value === "at" ? (s.at ?? "09:00") : (s.every ?? "5m")))}>
          <option value="every">每隔</option>
          <option value="at">每天</option>
        </select>
        <input className="h-8 w-36 rounded-md border bg-background px-2 font-mono text-[13px]" value={val} placeholder={mode === "at" ? "09:00,16:00" : "30s、5m、1h"} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && changed && save()} />
        {mode === "every" &&
          ["30s", "1m", "5m", "15m", "1h", "1d"].map((d) => (
            <button key={d} onClick={() => setVal(d)} className={clsx("rounded-sm px-1.5 text-[12px]", d === val ? "bg-brand/15 text-brand" : "text-muted-foreground hover:bg-accent")}>
              {d}
            </button>
          ))}
        {changed && (
          <Button disabled={busy} onClick={save}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : "保存"}
          </Button>
        )}
      </div>
      {err && <p className="text-[12px] text-bad">{err}</p>}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-muted-foreground">上次</dt>
        <dd>
          {last ? (
            <span className={clsx(last.ok ? "text-ok" : "text-bad")}>
              {since(Date.parse(last.startedAt))}前 · {last.ok ? "成功" : "失败"} · {(last.ms / 1000).toFixed(1)}s{s.fails ? ` · 连续失败 ${s.fails} 次` : ""}
            </span>
          ) : (
            <span className="text-muted-foreground">还没跑过</span>
          )}
        </dd>
        {last?.error && (
          <>
            <dt className="text-muted-foreground">出错</dt>
            <dd className="text-bad break-all">{last.error}</dd>
          </>
        )}
        {last?.result && (
          <>
            <dt className="text-muted-foreground">结果</dt>
            <dd className="font-mono text-[11px] break-all text-muted-foreground">{last.result}</dd>
          </>
        )}
        <dt className="text-muted-foreground">下次</dt>
        <dd>{s.paused ? "暂停中" : s.next ? <NextTime at={s.next} /> : "—"}</dd>
      </dl>
    </article>
  );
}

function NextTime({ at }: { at: string }) {
  const ms = Date.parse(at) - Date.now();
  if (ms <= 30_000)
    return (
      <span className="inline-flex items-center gap-1">
        <RotateCw className="size-3" />
        马上
      </span>
    );
  const t = new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return <span>{t}（{Math.round(ms / 60000)} 分钟后）</span>;
}
