import { Loader2, Plus, Save, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { AgentPick, input, PathPick } from "../components/pickers";
import { run } from "../lib/gerdr";
import { normalize, type Repo, type Settings, type Who } from "../lib/settings";

// 设置: the values the code acts on (lib/settings.ts says why they're settings and not prose in the skill). Each field
// carries its why as its description, which is what the sentence around a {{variable}} used to do. Stored as this
// person's (user/settings.json), only what differs from the defaults (local/settings.ts).

export default function SettingsPage({ onFlow }: { onFlow: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState("");
  const [etag, setEtag] = useState<string | undefined>();
  const [broken, setBroken] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = !!s && JSON.stringify(s) !== saved;

  const load = () =>
    run<{ settings: Settings; etag?: string; broken: boolean }>("settings.get").then(
      (r) => (setS(r.settings), setSaved(JSON.stringify(r.settings)), setEtag(r.etag), setBroken(r.broken), setErr("")),
      (e) => setErr(String(e.message || e)),
    );
  useEffect(() => {
    void load();
  }, []);

  async function save() {
    if (!s) return;
    setBusy(true);
    setErr("");
    try {
      const r = await run<{ etag: string }>("settings.save", { settings: s, etag });
      const n = normalize(s);
      setS(n);
      setSaved(JSON.stringify(n));
      setEtag(r.etag);
      setBroken(false);
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !busy) void save();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const put = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => (x ? { ...x, [k]: v } : x));
  const mr = <K extends keyof Settings["mr"]>(k: K, v: Settings["mr"][K]) => setS((x) => (x ? { ...x, mr: { ...x.mr, [k]: v } } : x));

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 max-md:p-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">设置</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            代码照着做的值：谁来派活、谁来干活、有哪些仓库、MR 怎么合、主动工作开不开。只存在你这里，不会随面板分享出去。
            怎么做事（怎么交付、review 意见怎么处理、怎么挑仓库）是你用自己的话写的，在
            <button className="mx-0.5 text-brand hover:underline" onClick={onFlow}>
              流程
            </button>
            里。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-[12px] text-warn">没保存</span>}
          <Button disabled={!dirty || busy} onClick={save}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            保存
          </Button>
        </div>
      </header>
      {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}
      {broken && <p className="text-[13px] text-warn">user/settings.json 不是合法的 JSON，现在用的是默认值。在这里保存一次就会覆盖它。</p>}
      {!s && !err && <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>}

      {s && (
        <>
          <Section title="派活：Superagent 的调度会话" note="看板上没指定仓库的任务、外面来的消息，都由它判断接不接、挑仓库和 agent 再派出去。它一直开着，只判断、不写代码，用快一点、便宜一点的模型就够。">
            <WhoFields who={s.router} onChange={(v) => put("router", v)} />
          </Section>

          <Section
            title="干活：worker 的默认"
            note="派出去真正改代码的会话。任务上单独指定了 agent / 模型的，以任务为准；任务换成别的 agent 时，这里的模型不套用（claude 的模型名对 codex 没意义），用那个 agent 自己的默认。"
          >
            <WhoFields who={s.worker} onChange={(v) => put("worker", v)} />
          </Section>

          <Section
            title="仓库"
            note="新任务的仓库下拉和调度会话都只看这份。说明写给调度会话看（这是哪个服务、哪个产品），它靠这个挑仓库。空着时，看板拿最近用过的目录当建议。"
          >
            <Repos repos={s.repos} onChange={(v) => put("repos", v)} />
          </Section>

          <Section title="GitLab" note="mrwatch 查 MR、变基、合并时找的 GitLab（glab 要先在这台电脑上登录过它）。">
            <Field label="地址">
              <input className={clsx(input, "font-mono text-[12px]")} value={s.gitlab.host} placeholder="gitlab.com" onChange={(e) => put("gitlab", { host: e.target.value })} />
            </Field>
          </Section>

          <Section title="MR 合并" note="盯 MR 的定时任务（mrwatch）照这里做。worker 自己从不合并，只按「流程」里的规则处理 review 意见、流水线和冲突。">
            <Field label="合并" hint={s.mr.merge === "manual" ? "看板上会显示「可以合并」，等你点「立即合并」" : "被批准、GitLab 也说可以合并时，自己合并"}>
              <Choice value={s.mr.merge} options={[["auto", "自动"], ["manual", "手动"]]} onChange={(v) => mr("merge", v)} />
            </Field>
            <Field label="至少几个人批准">
              <input className={clsx(input, "w-24")} type="number" min={0} max={10} value={s.mr.minApprovals} onChange={(e) => mr("minApprovals", Number(e.target.value))} />
            </Field>
            <Field label="落后目标分支时变基">
              <Choice value={s.mr.rebase} options={[["auto", "自动"], ["manual", "手动"], ["off", "不做"]]} onChange={(v) => mr("rebase", v)} />
            </Field>
            <Field label="变基时的流水线" hint="跳过省时间；项目要求流水线必须通过时，要允许跳过的流水线才能合">
              <Choice value={s.mr.rebaseSkipCI ? "skip" : "run"} options={[["run", "跑"], ["skip", "跳过"]]} onChange={(v) => mr("rebaseSkipCI", v === "skip")} />
            </Field>
            <Field label="最多几轮" hint="同一个 MR 改了这么多轮还有新意见，就停下来问你，不再交给 worker">
              <input className={clsx(input, "w-24")} type="number" min={1} max={20} value={s.mr.maxRounds} onChange={(e) => mr("maxRounds", Number(e.target.value))} />
            </Field>
          </Section>

          <Section
            title="主动工作"
            note="不是找你的事（触发器里设成「不是找我的」的来源：频道闲聊、告警、没人跟的 MR）。照「流程 → proactive」里你写的规则判断；新加一条规则时，先改回「只记录」看几天。"
          >
            <Field
              label="模式"
              hint={{ off: "这类事一律不看", observe: "照规则判断但不做：「去向」里看得到本来会接哪些、怎么派，看对了点「照做」", on: "符合规则的直接接了派出去" }[s.proactive]}
            >
              <Choice value={s.proactive} options={[["off", "关"], ["observe", "只记录"], ["on", "照做"]]} onChange={(v) => put("proactive", v)} />
            </Field>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div>
        <h2 className="text-[14px] font-medium">{title}</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{note}</p>
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid items-start gap-1.5 md:grid-cols-[160px_minmax(0,1fr)]">
      <span className="pt-1.5 text-[13px]">{label}</span>
      <div className="space-y-1">
        {children}
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={clsx("rounded-sm px-2.5 py-1 text-[12px]", v === value ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>
          {label}
        </button>
      ))}
    </div>
  );
}

function WhoFields({ who, onChange }: { who: Who; onChange: (w: Who) => void }) {
  return (
    <>
      <Field label="agent">
        <AgentPick value={who.agent} onChange={(agent) => onChange({ ...who, agent })} />
      </Field>
      <Field label="模型" hint="这个 agent 模型菜单里有的值（claude：sonnet、haiku、fable 这类）。空着用 Gerdr 设置里给它定的默认；写错了，派活时会报错并列出可选的。">
        <input className={input} value={who.model} placeholder="默认" onChange={(e) => onChange({ ...who, model: e.target.value })} />
      </Field>
      <Field label="思考强度" hint="low / medium / high……看 agent 和模型支持什么。空着用默认。">
        <input className={input} value={who.effort} placeholder="默认" onChange={(e) => onChange({ ...who, effort: e.target.value })} />
      </Field>
    </>
  );
}

function Repos({ repos, onChange }: { repos: Repo[]; onChange: (r: Repo[]) => void }) {
  const [add, setAdd] = useState("");
  const at = (i: number, r: Partial<Repo>) => onChange(repos.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const push = () => {
    const p = add.trim();
    if (p && !repos.some((r) => r.path === p)) onChange([...repos, { path: p }]);
    setAdd("");
  };
  return (
    <div className="space-y-2">
      {!repos.length && <p className="text-[12px] text-muted-foreground">还没有仓库。</p>}
      {repos.map((r, i) => (
        <div key={r.path} className="space-y-1.5 rounded-lg border bg-background p-2.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={r.path}>
              {r.path}
            </span>
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px]" title="小改动不走 MR，直接推到目标分支；改动大、拿不准的 worker 还是开 MR（「流程 → deliver」）">
              <input type="checkbox" checked={!!r.direct} onChange={(e) => at(i, { direct: e.target.checked || undefined })} />
              小改动可直推
            </label>
            <Button variant="ghost" size="icon" aria-label={`去掉 ${r.path}`} onClick={() => onChange(repos.filter((_, j) => j !== i))}>
              <X className="size-3.5" />
            </Button>
          </div>
          <input className={input} value={r.note ?? ""} placeholder="说明（给调度会话看）：比如「行情服务的后端」" onChange={(e) => at(i, { note: e.target.value })} />
        </div>
      ))}
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <PathPick value={add} onChange={setAdd} placeholder="加一个仓库：绝对路径，或点右边选" />
        </div>
        <Button variant="outline" disabled={!add.trim()} onClick={push}>
          <Plus className="size-3.5" />
          加
        </Button>
      </div>
    </div>
  );
}
