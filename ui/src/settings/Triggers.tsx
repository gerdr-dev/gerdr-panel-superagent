import { Loader2, Zap } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { Button } from "../components/Button";
import { project, run } from "../lib/gerdr";
import { since } from "../lib/tasks";
import { usePoll } from "../lib/visible";

// 触发器: which events come in to the Superagent, and who may ask through each (the gate). The choices are whatever Gerdr can deliver now (ctx.events.catalog: what the
// installed add-ons emit, what came lately) — nothing here names Slack or Feishu, so someone without them sees
// neither. Turning one on writes a Gerdr trigger file (triggers/inbox-*.json, local/inbox.ts); its runs come from
// /api/work/triggers.

type Source = { on: string; title?: string; description?: string; addon?: string; canReply?: boolean; seen?: number; enabled: boolean; key?: string; allow?: string[]; inferred?: boolean; by?: string };
/** One of the panel's own triggers (triggers/*.json): always on. */
type Builtin = { id: string; on: string; name?: string; key?: string };
type TriggerInfo = { id: string; on: string; runs: number; last?: { startedAt: string; ok: boolean; error?: string } };

export default function TriggersPage() {
  const [list, setList] = useState<Source[] | null>(null);
  const [own, setOwn] = useState<Builtin[]>([]);
  const [runs, setRuns] = useState<Record<string, TriggerInfo>>({});
  const [err, setErr] = useState("");
  const load = () => {
    run<Builtin[]>("inbox.builtin").then(setOwn, () => {});
    run<Source[]>("inbox.sources").then(
      (l) => (setList(l), setErr("")),
      (e) => setErr(String(e.message || e)),
    );
    fetch(`/api/work/triggers?project=${encodeURIComponent(project)}`, { credentials: "same-origin", headers: { "X-Gerdr": "1" } })
      .then((r) => (r.ok ? r.json() : { list: [] }))
      .then((d: { list: TriggerInfo[] }) => setRuns(Object.fromEntries((d.list ?? []).map((t) => [t.on, t]))), () => {});
  };
  usePoll(load, 15_000);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 max-md:p-3">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">触发器</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          这个面板收哪些外面发生的事（私信、@ 你、MR、告警……），都在这一页。已有任务的对话里的后续直接交给那个任务，其余的由秘书判断是不是活、派给谁（每条去了哪，看「去向」）。
          能选什么取决于装了哪些插件、有哪些事件来过；来源支持回复的，接了活、有了结果都会回到原来的对话里说一声。
        </p>
      </header>
      {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}
      {own.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-[13px] font-medium text-muted-foreground">面板自带，一直开着</h2>
          {own.map((b) => (
            <OwnRow key={b.id} b={b} info={runs[b.on]} />
          ))}
        </section>
      )}
      {list && list.length > 0 && <h2 className="pt-2 text-[13px] font-medium text-muted-foreground">你选的：勾上就收进来</h2>}
      {!list && !err && <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>}
      {list?.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
          现在还没有可选的事件。装一个会发事件的插件（比如 Slack、飞书），或者让秘书写一个定时任务去轮询你关心的东西。
        </p>
      )}
      <div className="space-y-3">
        {list?.map((s) => (
          <Row key={s.on} s={s} info={runs[s.on]} onSaved={load} />
        ))}
      </div>
    </div>
  );
}

/**
 * One of the panel's own triggers. The MR one (triggers/mr.json) carries what it needs: the GitLab the MR watcher
 * (schedules/mrwatch) asks, a setting (gitlab.host), shown here so everything about what comes in is on one page.
 */
function OwnRow({ b, info }: { b: Builtin; info?: TriggerInfo }) {
  const last = info?.last;
  return (
    <article className="space-y-2 rounded-xl border bg-card p-4 max-md:p-3">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-[14px] font-medium">
          <Zap className="size-3.5 text-brand" />
          {b.name || b.on}
        </h3>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          <span className="font-mono">{b.on}</span>
          {b.key && <> · 只要 <span className="font-mono">{b.key}</span></>}
          {info && (
            <span className={clsx(last && !last.ok && "text-bad")}>
              {" "}· 收过 {info.runs} 条{last ? ` · 上次${since(Date.parse(last.startedAt))}前${last.ok ? "" : `失败：${last.error}`}` : ""}
            </span>
          )}
        </p>
      </div>
      {b.id === "mr" && <GitLab />}
    </article>
  );
}

function GitLab() {
  const [host, setHost] = useState<string | null>(null);
  const [cur, setCur] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  usePoll(
    () =>
      run<{ settings: { gitlab: { host: string } } }>("settings.get").then(
        (r) => (setCur(r.settings.gitlab.host), setHost((h) => h ?? r.settings.gitlab.host)),
        () => {},
      ),
    60_000,
  );
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      await run("settings.set", { gitlab: { host: (host ?? "").trim() } });
      setCur((host ?? "").trim());
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1 text-[12px] text-muted-foreground">
      <p>
        这个面板的任务在跟的 MR（worker 开的、在等的），由定时任务 mrwatch 去 GitLab 查：新的 review 意见、流水线、能合了、合并了，交给跟着它的任务。
        别的项目的面板发出的 MR 消息不收。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span>GitLab 地址（glab 要先在这台电脑上登录过它）</span>
        <input className="h-7 w-56 rounded-md border bg-background px-2 font-mono text-[12px] text-foreground" value={host ?? ""} placeholder="gitlab.com" onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === "Enter" && host !== cur && save()} />
        {host !== null && host.trim() !== cur && (
          <Button disabled={busy} onClick={save}>
            保存
          </Button>
        )}
      </div>
      {err && <p className="text-bad">{err}</p>}
    </div>
  );
}

function Row({ s, info, onSaved }: { s: Source; info?: TriggerInfo; onSaved: () => void }) {
  const [key, setKey] = useState(s.key ?? "");
  const [allow, setAllow] = useState((s.allow ?? []).join(", "));
  const allowNow = (s.allow ?? []).join(", ");
  const [inferred, setInferred] = useState(!!s.inferred);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async (enabled: boolean) => {
    setBusy(true);
    setErr("");
    try {
      await run("inbox.setSource", { on: s.on, enabled, key, title: s.title, allow, inferred });
      onSaved();
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };
  const last = info?.last;
  return (
    <article className="space-y-2 rounded-xl border bg-card p-4 max-md:p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[14px] font-medium">
            <Zap className={clsx("size-3.5", s.enabled ? "text-brand" : "text-muted-foreground")} />
            {s.title || s.on}
            {s.canReply && <span className="rounded-sm bg-muted px-1.5 text-[11px] font-normal text-muted-foreground">能回复</span>}
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            <span className="font-mono">{s.on}</span>
            {s.addon && <> · 插件 {s.addon}</>}
            {s.seen ? <> · 最近一条 {since(s.seen)}前</> : null}
          </p>
          {s.description && <p className="mt-1 text-[12px] text-muted-foreground">{s.description}</p>}
        </div>
        {s.by ? (
          // Taken by one of the panel's own triggers already: a second one would take each event twice
          <span className="shrink-0 text-[12px] text-muted-foreground">已由「{s.by}」收着</span>
        ) : (
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[13px]">
            {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={s.enabled} disabled={busy} onChange={(e) => save(e.target.checked)} />
            收进来
          </label>
        )}
      </div>
      {s.enabled && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-muted-foreground">只要这些（key，可用 *，空 = 全部）</span>
          <input className="h-7 w-56 rounded-md border bg-background px-2 font-mono text-[12px]" value={key} placeholder="比如某个频道 id" onChange={(e) => setKey(e.target.value)} />
          <span className="text-muted-foreground">只收这些人（发送人 ID 或名字，逗号分隔；空 = 来源放进来的都收）</span>
          <input className="h-7 w-56 rounded-md border bg-background px-2 font-mono text-[12px]" value={allow} placeholder="比如 U012ABCD" onChange={(e) => setAllow(e.target.value)} />
          <span className="text-muted-foreground">这些消息是</span>
          <select className="h-7 rounded-md border bg-background px-1.5 text-[12px]" value={inferred ? "inferred" : "explicit"} onChange={(e) => setInferred(e.target.value === "inferred")}>
            <option value="explicit">找我的（私信、@ 我）</option>
            <option value="inferred">不是找我的（只按主动工作的规则接）</option>
          </select>
          {(key !== (s.key ?? "") || allow !== allowNow || inferred !== !!s.inferred) && (
            <Button disabled={busy} onClick={() => save(true)}>
              保存
            </Button>
          )}
          {info && (
            <span className={clsx("ml-auto", last && !last.ok ? "text-bad" : "text-muted-foreground")}>
              收过 {info.runs} 条{last ? ` · 上次${since(Date.parse(last.startedAt))}前${last.ok ? "" : `失败：${last.error}`}` : ""}
            </span>
          )}
        </div>
      )}
      {err && <p className="text-[12px] text-bad">{err}</p>}
    </article>
  );
}
