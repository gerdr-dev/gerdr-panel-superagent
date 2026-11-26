import { Plus, Trash2 } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { input } from "../components/pickers";
import { SaveBar } from "../components/SaveBar";
import { run } from "../lib/gerdr";
import { normalize, type Settings } from "../lib/settings";
import { DAY_NAMES, GATE_NAME, GATES, type Gate, type LetGo, type Policy, type Window } from "../lib/letgo";
import { Choice, Field, MODES, Section } from "./Settings";

// 放行 (Let it go): when the agents carry on without the user. Everything that decides whether they stop for the user
// is on this page, 平时 next to 放行 (the person, 2026-11-26: "全部统一到一个地方"): what holds as usual (设置's inboxWork
// and replies), the policies (each its own gates, repositories, people still looked at first, note), the week of times
// that picks one, the permission mode, and the note shared by all (prose, the skill file letgo.md). lib/letgo.ts has the
// rules, local/_letgo.ts where each one acts. DESIGN.md「放行」.

const NOTE = "superagent-panel/references/letgo.md";

type Status = { text: string; by: "manual" | "time" | "none"; until?: number; manual?: { policy: string; until: number }; log: { at: number; kind: string; task?: string; text: string }[] };

export default function LetGoPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState("");
  const [etag, setEtag] = useState<string | undefined>();
  const [note, setNote] = useState<{ text: string; saved: string; etag?: string } | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = (!!s && JSON.stringify(s) !== saved) || (!!note && note.text !== note.saved);

  const status = () => run<Status>("letgo.status").then(setSt, () => {});
  const load = () => {
    run<{ settings: Settings; etag?: string }>("settings.get").then(
      (r) => (setS(r.settings), setSaved(JSON.stringify(r.settings)), setEtag(r.etag), setErr("")),
      (e) => setErr(String(e.message || e)),
    );
    run<{ text: string; etag: string }>("playbooks.read", { name: NOTE }).then(
      (r) => setNote({ text: r.text, saved: r.text, etag: r.etag }),
      () => setNote({ text: "", saved: "" }),
    );
    void status();
  };
  useEffect(load, []);

  async function save() {
    if (!s) return;
    setBusy(true);
    setErr("");
    try {
      if (JSON.stringify(s) !== saved) {
        const r = await run<{ etag: string }>("settings.save", { settings: s, etag });
        const n = normalize(s);
        setS(n);
        setSaved(JSON.stringify(n));
        setEtag(r.etag);
      }
      if (note && note.text !== note.saved) {
        const r = await run<{ etag: string }>("playbooks.save", { name: NOTE, text: note.text, etag: note.etag });
        setNote({ ...note, saved: note.text, etag: r.etag });
      }
      void status();
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
  const putL = (l: Partial<LetGo>) => setS((x) => (x ? { ...x, letgo: { ...x.letgo, ...l } } : x));
  const l = s?.letgo;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 max-md:p-3">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">放行 · Let it go</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          你不在的时候让秘书和 worker 自己往下做：活直接派、该拍板的自己定、消息直接发。可以建几套策略，每套各自定放开哪些环节、放行哪些仓库、哪些人仍要你过目、额外说明；
          再按时间表给每个时间段挑一套。放行期间替你做的事都会记下来，放行结束时秘书给你写一份简报。
        </p>
      </header>
      {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}
      {!s && !err && <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>}

      {s && l && (
        <>
          <Now st={st} policies={l.policies} onChange={(x) => setSt(x)} onError={setErr} />

          <Section title="平时" note="不在放行时间里（或者策略没放行那个仓库）时怎么做。">
            <Field label="像是活的消息" hint={{ review: "秘书在「待办」里建好任务，不派出去：你看过、改好再点「派出去」，不要就放弃", dispatch: "秘书接了就直接派出去" }[s.inboxWork]}>
              <Choice value={s.inboxWork} options={[["review", "放进待办等我过目"], ["dispatch", "直接派出去"]]} onChange={(v) => put("inboxWork", v)} />
            </Field>
            <Field label="worker 回话" hint={{ review: "worker 要回那段对话里的人时，先变成一张「待发送」卡片：你点发送才发出去，点不发就算了。worker 不等你、也不会知道你选了哪个", auto: "worker 写好就直接发出去" }[s.replies]}>
              <Choice value={s.replies} options={[["review", "先给我过目"], ["auto", "直接发"]]} onChange={(v) => put("replies", v)} />
            </Field>
            <p className="text-[11px] text-muted-foreground">秘书拿不准、worker 要拍板时问你；worker 用「设置 → 干活」里的权限模式。</p>
          </Section>

          <Section title="策略" note="每套策略单独定：放开哪些环节、放行哪些仓库（没勾的仓库照平时）、哪些人或对话仍要你过目（比如 leader：给他们的消息还是出卡片等你发）、给秘书和 worker 的额外说明。">
            {l.policies.map((p, i) => (
              <PolicyCard
                key={p.id}
                p={p}
                repos={s.repos.map((r) => r.path)}
                used={l.times.some((w) => w.policy === p.id)}
                onChange={(np) => putL({ policies: l.policies.map((x, j) => (j === i ? np : x)) })}
                onRemove={() => putL({ policies: l.policies.filter((_, j) => j !== i), times: l.times.filter((w) => w.policy !== p.id) })}
              />
            ))}
            <Button variant="outline" onClick={() => putL({ policies: [...l.policies, { id: newId(l.policies), name: `策略 ${l.policies.length + 1}`, gates: ["inbox"], repos: [], confirm: [], note: "" }] })}>
              <Plus className="size-3.5" />
              加一套策略
            </Button>
          </Section>

          <Section title="时间表" note="每个时间段挑一套策略；时间段重叠时，排在上面的为准。结束时间早于开始时间就是跨过午夜（19:00–09:00 是到第二天早上）。没有时间段时只能在上面手动打开。">
            {!l.times.length && <p className="text-[12px] text-muted-foreground">还没有时间段。</p>}
            {l.times.map((w, i) => (
              <WindowRow key={i} w={w} policies={l.policies} onChange={(nw) => putL({ times: l.times.map((x, j) => (j === i ? nw : x)) })} onRemove={() => putL({ times: l.times.filter((_, j) => j !== i) })} />
            ))}
            <Button
              variant="outline"
              disabled={!l.policies.length}
              onClick={() => putL({ times: [...l.times, { days: [0, 1, 2, 3, 4, 5, 6], from: "19:00", to: "09:00", policy: l.policies[l.policies.length - 1]?.id ?? "" }] })}
            >
              <Plus className="size-3.5" />
              加一个时间段
            </Button>
          </Section>

          <Section title="放行时的权限模式" note="策略放开「worker 用放行的权限模式开」、仓库也放行时，那段时间里新开的 worker 用这个模式（已经在跑的不变）。auto 不弹批准，claude 的 auto 还会自己拦下明显危险的操作。">
            <Field label="claude">
              <Choice value={l.mode.claude} options={MODES.claude.map((m) => [m.id, m.name] as [string, string])} onChange={(v) => putL({ mode: { ...l.mode, claude: v } })} />
            </Field>
            <Field label="codex">
              <Choice value={l.mode.codex} options={MODES.codex.map((m) => [m.id, m.name] as [string, string])} onChange={(v) => putL({ mode: { ...l.mode, codex: v } })} />
            </Field>
          </Section>

          {note && (
            <Section title="共用的放行说明" note="每套策略都会带上的话，写给秘书和 worker：红线（发生产、动线上数据、付钱之前停下）、拿不准时怎么定。存在流程里的 letgo.md，那边也能改。">
              <textarea className={clsx(input, "h-56 py-1.5 font-mono text-[12px] leading-relaxed")} value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} />
            </Section>
          )}
        </>
      )}
      <SaveBar
        dirty={dirty}
        busy={busy}
        onSave={save}
        onRevert={() => {
          if (saved) setS(JSON.parse(saved));
          if (note) setNote({ ...note, text: note.saved });
        }}
      />
    </div>
  );
}

const newId = (ps: Policy[]) => {
  for (let i = ps.length + 1; ; i++) if (!ps.some((p) => p.id === `p${i}`)) return `p${i}`;
};

const name = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** What holds right now, and picking a policy by hand until a time (letgo.set). */
function Now({ st, policies, onChange, onError }: { st: Status | null; policies: Policy[]; onChange: (s: Status) => void; onError: (e: string) => void }) {
  const [pick, setPick] = useState(policies[policies.length - 1]?.id ?? "");
  const [until, setUntil] = useState("09:00");
  const call = (input: object) => run<Status>("letgo.set", input).then(onChange, (e) => onError(String(e.message || e)));
  const sel = "h-8 rounded-md border bg-background px-2 text-[13px]";
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-[14px] font-medium">现在</h2>
        <span className="text-[13px]">{st?.text ?? "…"}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-muted-foreground">手动：</span>
        <select className={sel} value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">不放行（平时）</option>
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
            回到时间表
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">手动选的盖过时间表，到点自动回到时间表。不用保存，点了就生效。</p>
      {!!st?.log.length && (
        <div className="space-y-0.5 border-t pt-2">
          <p className="text-[12px] text-muted-foreground">这次放行替你做的：</p>
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

function PolicyCard({ p, repos, used, onChange, onRemove }: { p: Policy; repos: string[]; used: boolean; onChange: (p: Policy) => void; onRemove: () => void }) {
  const toggle = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  // A repository ticked here but gone from 设置 → 仓库 still shows, to untick
  const all = [...repos, ...p.repos.filter((r) => !repos.includes(r))];
  const [confirm, setConfirm] = useState(p.confirm.join("\n"));
  useEffect(() => setConfirm(p.confirm.join("\n")), [p.confirm.join("\n")]);
  return (
    <div className="space-y-3 rounded-lg border bg-background p-3">
      <div className="flex items-center gap-2">
        <input className={clsx(input, "font-medium")} value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value })} />
        <Button variant="ghost" size="icon" aria-label={`删掉策略 ${p.name}`} title={used ? "删掉它，时间表里用它的时间段也一起删掉" : "删掉它"} onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <Field label="放开的环节">
        <div className="space-y-1">
          {GATES.map((g: Gate) => (
            <label key={g} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={p.gates.includes(g)} onChange={() => onChange({ ...p, gates: GATES.filter((x) => (x === g ? !p.gates.includes(g) : p.gates.includes(x))) })} />
              {GATE_NAME[g]}
            </label>
          ))}
        </div>
      </Field>
      <Field label="放行的仓库" hint="没勾的仓库（复杂的、不熟的）在这套策略下也照平时：进待办、要拍板的问你、消息先给你过目。">
        {all.length ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {all.map((r) => (
              <label key={r} className={clsx("flex items-center gap-1.5 text-[13px]", !repos.includes(r) && "text-muted-foreground line-through")} title={r}>
                <input type="checkbox" checked={p.repos.includes(r)} onChange={() => onChange({ ...p, repos: toggle(p.repos, r) })} />
                {name(r)}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">设置里还没有仓库。</p>
        )}
      </Field>
      <Field label="仍要你过目的人" hint="一行一个：Slack 成员 id、显示名（包含就算）、或者对话 / 频道 id。给他们的消息还是出待发送卡片等你发。">
        <textarea
          className={clsx(input, "h-16 py-1.5")}
          value={confirm}
          placeholder={"比如你的 leader\nU01ABCDEF"}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => onChange({ ...p, confirm: confirm.split(/\n|,|，/).map((x) => x.trim()).filter(Boolean) })}
        />
      </Field>
      <Field label="这套的说明" hint="写给秘书和 worker，在共用说明后面带上：比如「有八成把握就直接派」「拍板时选改动最小的」。">
        <textarea className={clsx(input, "h-20 py-1.5")} value={p.note} onChange={(e) => onChange({ ...p, note: e.target.value })} />
      </Field>
    </div>
  );
}

function WindowRow({ w, policies, onChange, onRemove }: { w: Window; policies: Policy[]; onChange: (w: Window) => void; onRemove: () => void }) {
  const sel = "h-8 rounded-md border bg-background px-2 text-[13px]";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2">
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
      <input type="time" className={sel} value={w.to} onChange={(e) => onChange({ ...w, to: e.target.value })} />
      <select className={sel} value={w.policy} onChange={(e) => onChange({ ...w, policy: e.target.value })}>
        {policies.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <Button variant="ghost" size="icon" className="ml-auto" aria-label="删掉这个时间段" onClick={onRemove}>
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
