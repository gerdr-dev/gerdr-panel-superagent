import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { input } from "../components/pickers";
import { SaveBar } from "../components/SaveBar";
import { useUnsaved } from "../components/unsaved";
import { run } from "../lib/gerdr";
import { normalize, type Settings } from "../lib/settings";
import { ALL_DAYS, ANY_REPO, DAY_NAMES, GATE_TEXT, GATES, type Policy, type Window } from "../lib/letgo";
import { Field, MODES, Section } from "./Settings";

// Let it go: policies for what the agents may do without the user (lib/letgo.ts has the rules and why, local/_letgo.ts
// where each acts). Each policy is whole — its repositories first (the person, 2026-11-26: "先选择仓库"), its own times, gates, repositories, people still looked at first, permission
// mode and note — and nothing here is global: when no policy is in effect, nothing is let go. DESIGN.md「Let it go」.

type Status = { text: string; by: "manual" | "time" | "none"; until?: number; manual: { policy: string; until: number } | null; log: { at: number; kind: string; task?: string; text: string }[] };

export default function LetGoPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState("");
  const [etag, setEtag] = useState<string | undefined>();
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = !!s && JSON.stringify(s) !== saved;

  const status = () => run<Status>("letgo.status").then(setSt, () => {});
  useEffect(() => {
    run<{ settings: Settings; etag?: string }>("settings.get").then(
      (r) => (setS(r.settings), setSaved(JSON.stringify(r.settings)), setEtag(r.etag), setErr("")),
      (e) => setErr(String(e.message || e)),
    );
    void status();
  }, []);

  async function save(): Promise<boolean> {
    if (!s) return false;
    setBusy(true);
    setErr("");
    try {
      const r = await run<{ etag: string }>("settings.save", { settings: s, etag });
      const n = normalize(s);
      setS(n);
      setSaved(JSON.stringify(n));
      setEtag(r.etag);
      void status();
      return true;
    } catch (e: any) {
      setErr(String(e.message || e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  useUnsaved(dirty && !busy, save);

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

  const policies = s?.letgo.policies ?? [];
  const setPolicies = (ps: Policy[]) => setS((x) => (x ? { ...x, letgo: { ...x.letgo, policies: ps } } : x));
  const move = (i: number, d: number) => {
    const ps = [...policies];
    [ps[i], ps[i + d]] = [ps[i + d], ps[i]];
    setPolicies(ps);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 max-md:p-3">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Let it go</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          秘书和 worker 什么时候可以不问你自己往下做。每套策略先选管哪些仓库，再定在哪些时间生效、各环节放不放开、哪些人仍要你过目、worker 用什么权限模式、给它们的说明。
          几套可以同时生效、各管各的仓库（比如 a 仓库全天全放行，其余仓库只在白天放开一部分）；同一个仓库被几套管着时，排在上面的为准。没有策略管着的仓库，什么都问你。
          没问你就做了的事都会记下来，策略一换秘书给你写一份简报。
        </p>
      </header>
      {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}
      {!s && !err && <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>}

      {s && (
        <>
          <Now st={st} policies={policies} onChange={setSt} onError={setErr} />
          {policies.map((p, i) => (
            <PolicyCard
              key={p.id}
              p={p}
              repos={s.repos.map((r) => r.path)}
              first={i === 0}
              last={i === policies.length - 1}
              onUp={() => move(i, -1)}
              onDown={() => move(i, 1)}
              onChange={(np) => setPolicies(policies.map((x, j) => (j === i ? np : x)))}
              onRemove={() => setPolicies(policies.filter((_, j) => j !== i))}
            />
          ))}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() =>
                setPolicies([
                  ...policies,
                  { id: newId(policies), name: `策略 ${policies.length + 1}`, times: [{ days: [1, 2, 3, 4, 5], from: "09:00", to: "19:00" }], gates: [], repos: [], confirm: [], mode: { claude: "", codex: "" }, note: "" },
                ])
              }
            >
              <Plus className="size-3.5" />
              加一套策略
            </Button>
            {policies.length > 1 && <span className="text-[12px] text-muted-foreground">同一个仓库被几套同时管着时，排在上面的为准。</span>}
          </div>
        </>
      )}
      <SaveBar dirty={dirty} busy={busy} onSave={save} onRevert={() => saved && setS(JSON.parse(saved))} />
    </div>
  );
}

const newId = (ps: Policy[]) => {
  for (let i = ps.length + 1; ; i++) if (!ps.some((p) => p.id === `p${i}`)) return `p${i}`;
};

const name = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;
const sel = "h-8 rounded-md border bg-background px-2 text-[13px]";

/** Which policy is in effect now, and picking one by hand until a time (letgo.set). */
function Now({ st, policies, onChange, onError }: { st: Status | null; policies: Policy[]; onChange: (s: Status) => void; onError: (e: string) => void }) {
  const [pick, setPick] = useState("");
  const [until, setUntil] = useState("09:00");
  const call = (input: object) => run<Status>("letgo.set", input).then(onChange, (e) => onError(String(e.message || e)));
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-[14px] font-medium">现在</h2>
        <span className="text-[13px]">{st?.text ?? "…"}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-muted-foreground">临时换成</span>
        <select className={sel} value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">不用策略（什么都问我）</option>
          {policies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">到</span>
        <input type="time" className={sel} value={until} onChange={(e) => setUntil(e.target.value)} />
        <Button variant="outline" onClick={() => void call({ policy: pick, until })}>
          就这样
        </Button>
        {st?.manual && (
          <Button variant="ghost" onClick={() => void call({ clear: true })}>
            回到按时间
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">临时换成一套：到点之前只有它生效，别的都暂停，到点自动回到按时间。点了就生效，不用保存。</p>
      {!!st?.log.length && (
        <div className="space-y-0.5 border-t pt-2">
          <p className="text-[12px] text-muted-foreground">这段时间没问你就做了的：</p>
          {st.log.slice(-12).map((d, i) => (
            <p key={i} className="truncate text-[12px]" title={d.text}>
              <span className="text-muted-foreground">{new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> {d.task ? `${d.task} · ` : ""}
              {d.text}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function PolicyCard(props: { p: Policy; repos: string[]; first: boolean; last: boolean; onUp: () => void; onDown: () => void; onChange: (p: Policy) => void; onRemove: () => void }) {
  const { p, repos, onChange } = props;
  const any = p.repos.includes(ANY_REPO);
  const toggle = (r: string) => onChange({ ...p, repos: p.repos.includes(r) ? p.repos.filter((x) => x !== r) : [...p.repos, r] });
  // A repository ticked here but gone from 设置 → 仓库 still shows, to untick
  const all = [...repos, ...p.repos.filter((r) => r !== ANY_REPO && !repos.includes(r))];
  const [confirm, setConfirm] = useState(p.confirm.join("\n"));
  useEffect(() => setConfirm(p.confirm.join("\n")), [p.confirm.join("\n")]);
  const modeOptions = (engine: "claude" | "codex") => [["", "跟设置走"], ...MODES[engine].map((m) => [m.id, m.name])] as [string, string][];
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-1">
        <input className={clsx(input, "font-medium")} value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value })} />
        <Button variant="ghost" size="icon" disabled={props.first} aria-label="往上挪" title="往上挪（同一个仓库被几套同时管着时，上面的为准）" onClick={props.onUp}>
          <ArrowUp className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" disabled={props.last} aria-label="往下挪" onClick={props.onDown}>
          <ArrowDown className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" aria-label={`删掉策略 ${p.name}`} onClick={props.onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <Field label="管哪些仓库" hint={p.repos.length ? "下面的环节和权限模式只管这些仓库。别的仓库归别的策略管，都不管的什么都问你。「秘书拿不准时」是派活前的事，不看仓库。" : "先选这套策略管哪些仓库：还没选时它什么都不管。"}>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <label className="flex items-center gap-1.5 text-[13px] font-medium">
            <input type="checkbox" checked={any} onChange={() => onChange({ ...p, repos: any ? p.repos.filter((r) => r !== ANY_REPO) : [...p.repos, ANY_REPO] })} />
            所有仓库
          </label>
          {all.map((r) => (
            <label key={r} className={clsx("flex items-center gap-1.5 text-[13px]", (any || !repos.includes(r)) && "text-muted-foreground", !repos.includes(r) && "line-through")} title={r}>
              <input type="checkbox" disabled={any} checked={any || p.repos.includes(r)} onChange={() => toggle(r)} />
              {name(r)}
            </label>
          ))}
        </div>
      </Field>

      <Field label="生效时间" hint="结束早于开始就是跨过午夜（19:00–09:00 到第二天早上）；结束填 24:00 是到当天结束。没有时间段的策略只在上面临时换成它时生效。">
        <div className="space-y-1.5">
          {p.times.map((w, i) => (
            <WindowRow key={i} w={w} onChange={(nw) => onChange({ ...p, times: p.times.map((x, j) => (j === i ? nw : x)) })} onRemove={() => onChange({ ...p, times: p.times.filter((_, j) => j !== i) })} />
          ))}
          <Button variant="ghost" onClick={() => onChange({ ...p, times: [...p.times, { days: ALL_DAYS, from: "19:00", to: "09:00" }] })}>
            <Plus className="size-3.5" />
            加一个时间段
          </Button>
        </div>
      </Field>

      <Field label="各环节">
        <div className="space-y-1.5">
          {GATES.map((g) => (
            <div key={g} className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="w-32 shrink-0 text-muted-foreground">{GATE_TEXT[g].label}</span>
              <div className="inline-flex rounded-md border p-0.5">
                {[false, true].map((open) => (
                  <button
                    key={String(open)}
                    onClick={() => onChange({ ...p, gates: GATES.filter((x) => (x === g ? open : p.gates.includes(x))) })}
                    className={clsx("rounded-sm px-2.5 py-1 text-[12px]", p.gates.includes(g) === open ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}
                  >
                    {open ? GATE_TEXT[g].open : GATE_TEXT[g].closed}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Field>

      <Field label="仍要你过目的人" hint="一行一个：Slack 成员 id、显示名（包含就算）、或者对话 / 频道 id。就算放开了「以我的名义发消息」，给他们的消息也出卡片等你发。">
        <textarea
          className={clsx(input, "h-16 py-1.5")}
          value={confirm}
          placeholder={"比如你的 leader\nU01ABCDEF"}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => onChange({ ...p, confirm: confirm.split(/\n|,|，/).map((x) => x.trim()).filter(Boolean) })}
        />
      </Field>

      <Field label="worker 权限模式" hint="这套策略生效时、在它管的仓库里新开的 worker 用的模式（已经在跑的不变）。跟设置走 = 「设置 → 干活」里的。auto 不弹批准。">
        <div className="space-y-1.5">
          {(["claude", "codex"] as const).map((engine) => (
            <div key={engine} className="flex items-center gap-2">
              <span className="w-12 text-[12px] text-muted-foreground">{engine}</span>
              <div className="inline-flex flex-wrap rounded-md border p-0.5">
                {modeOptions(engine).map(([v, label]) => (
                  <button key={v} onClick={() => onChange({ ...p, mode: { ...p.mode, [engine]: v } })} className={clsx("rounded-sm px-2.5 py-1 text-[12px]", p.mode[engine] === v ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Field>

      <Field label="说明" hint="这套策略生效时写给秘书和 worker 的话：红线（发生产、动线上数据、付钱之前停下）、拿不准时怎么定（有八成把握就直接派、选改动最小的）。">
        <textarea className={clsx(input, "h-24 py-1.5")} value={p.note} onChange={(e) => onChange({ ...p, note: e.target.value })} />
      </Field>
    </section>
  );
}

function WindowRow({ w, onChange, onRemove }: { w: Window; onChange: (w: Window) => void; onRemove: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-md border p-0.5">
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <button
            key={d}
            onClick={() => onChange({ ...w, days: w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d].sort() })}
            className={clsx("size-7 rounded-sm text-[12px]", w.days.includes(d) ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}
          >
            {DAY_NAMES[d]}
          </button>
        ))}
      </div>
      <input type="time" className={sel} value={w.from} onChange={(e) => onChange({ ...w, from: e.target.value })} />
      <span className="text-muted-foreground">–</span>
      {/* A text field, not type=time: 24:00 (to the end of the day) is a valid end the time picker can't hold */}
      <input className={clsx(sel, "w-20 font-mono", !/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(w.to) && "border-bad")} title="HH:MM，24:00 是到当天结束；格式不对的时间段保存时会被丢掉" value={w.to} placeholder="HH:MM" onChange={(e) => onChange({ ...w, to: e.target.value.trim() })} />
      <Button variant="ghost" size="icon" aria-label="删掉这个时间段" onClick={onRemove}>
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
