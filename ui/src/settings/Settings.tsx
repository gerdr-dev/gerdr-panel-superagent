import { Palette, Plus, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { AgentPick, ChoicePick, input, PathPick, useAgents, type AgentChoice } from "../components/pickers";
import { run } from "../lib/gerdr";
import { ACK_TEXT, normalize, type Repo, type Settings, type Who } from "../lib/settings";
import { PRESETS } from "../lib/repoColor";
import { SaveBar } from "../components/SaveBar";
import { useUnsaved } from "../components/unsaved";

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
      setBroken(false);
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

  const put = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => (x ? { ...x, [k]: v } : x));

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 max-md:p-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">设置</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            代码照着做的值：谁来派活、谁来干活、有哪些仓库。只存在你这里，不会随面板分享出去。
            怎么做事（怎么交付、review 意见怎么处理、怎么挑仓库）是你用自己的话写的，在
            <button className="mx-0.5 text-brand hover:underline" onClick={onFlow}>
              流程
            </button>
            里。
          </p>
        </div>
      </header>
      {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}
      {broken && <p className="text-[13px] text-warn">user/settings.json 不是合法的 JSON，现在用的是默认值。在这里保存一次就会覆盖它。</p>}
      {!s && !err && <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>}

      {s && (
        <>
          <Section title="秘书" note="点任务列表最上面的「秘书」跟它说话；没指定仓库的任务、外面来的消息，也都由它判断接不接、挑仓库和 agent 再派出去。它只说话和派活、不写代码；它要听懂你、写简报，别用太弱的模型。">
            <WhoFields who={s.router} onChange={(v) => put("router", v)} />
            <Field
              label="压缩对话"
              hint={
                s.compactTokens > 0
                  ? `对话闲了一小时以上、上下文超过 ${s.compactTokens} token 时，把早先的聊天压缩成摘要（定时任务「压缩秘书的对话」决定多久看一次）`
                  : "按时间：每次到点（定时任务「压缩秘书的对话」里改时间，比如 04:00），上次压缩之后又聊过就压缩"
              }
            >
              <input
                className={input}
                type="number"
                min={0}
                step={10000}
                value={s.compactTokens}
                onChange={(e) => put("compactTokens", Math.max(0, Math.round(Number(e.target.value) || 0)))}
              />
            </Field>
          </Section>

          <Section
            title="干活：worker 的默认"
            note="派出去真正改代码的会话。任务上单独指定了 agent / 模型的，以任务为准；任务换成别的 agent 时，这里的模型不套用（claude 的模型名对 codex 没意义），用那个 agent 自己的默认。"
          >
            <WhoFields who={s.worker} onChange={(v) => put("worker", v)} />
            <Field
              label="自动压缩：上下文占比（%）"
              hint={
                s.workerCompact.percent > 0
                  ? `没结束的任务，worker 上下文到了窗口的 ${s.workerCompact.percent}%、又 ${s.workerCompact.idleMinutes} 分钟没动静时，把早先的内容压缩成摘要（定时任务「压缩 worker 的对话」决定多久看一次，摘要留什么在流程 → worker-compact.md）`
                  : "不自动压缩 worker 的对话"
              }
            >
              <input
                className={input}
                type="number"
                min={0}
                max={100}
                step={5}
                value={s.workerCompact.percent}
                onChange={(e) => put("workerCompact", { ...s.workerCompact, percent: Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))) })}
              />
            </Field>
            <Field label="自动压缩：闲了多久（分钟）" hint="worker 最后一次动静之后过了这么久才压缩：正在等它下一步的对话不打断，提示缓存也已经凉了">
              <input
                className={input}
                type="number"
                min={0}
                step={5}
                value={s.workerCompact.idleMinutes}
                onChange={(e) => put("workerCompact", { ...s.workerCompact, idleMinutes: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              />
            </Field>
          </Section>

          <Section
            title="仓库"
            note="新任务弹窗的仓库下拉、⌘T 页上的文件夹和秘书都只看这份。说明写给秘书看（这是哪个服务、哪个产品），它靠这个挑仓库。空着时，拿最近用过的目录当建议。"
          >
            <Repos repos={s.repos} onChange={(v) => put("repos", v)} />
          </Section>

          <Section title="问题卡片" note="worker 问你的问题，在对话里点一个选项后，先等几秒再交给它：点错了可以在这几秒里撤回。交出去之后它就照着做了，只能「改答案」。">
            <Field label="撤回时间（秒）" hint={s.undoSeconds > 0 ? `点完 ${s.undoSeconds} 秒后提交` : "点了立刻提交，不能撤回"}>
              <input className={input} type="number" min={0} max={30} step={1} value={s.undoSeconds} onChange={(e) => put("undoSeconds", Math.min(30, Math.max(0, Math.round(Number(e.target.value) || 0))))} />
            </Field>
          </Section>

          <Section title="归档" note="完成（或放弃）很久的任务移出任务数据，面板和秘书每次就不用再读它们；什么都不删。秘书能搜到它们，按编号查一个就放回来，它的 worker 又干起活来也会自己回来。">
            <Field label="完成多少天后归档" hint={s.archiveDays > 0 ? `一个需求里所有任务都结束超过 ${s.archiveDays} 天，而且没有还在进行的任务提到它` : "不归档"}>
              <input className={input} type="number" min={0} step={1} value={s.archiveDays} onChange={(e) => put("archiveDays", Math.max(0, Math.round(Number(e.target.value) || 0)))} />
            </Field>
          </Section>

          <Section
            title="外面来的消息"
            note="触发器收进来、找你的消息（私信、@ 你）。闲聊、道谢这类秘书不接，只记在「去向」里。像是活的进不进待办、worker 回话要不要先给你过目，在「Let it go」的策略里定。"
          >
            <Field
              label="任务对话里的后续"
              hint={{ worker: "已有任务那段对话里又来的消息，直接交给那个任务的 worker。这些情况还是先给秘书判断：那段对话里有过不止一个任务、任务已经完成、worker 把消息交回过（交回后它就不再跟着这段对话）", secretary: "先交给秘书判断：可以不理，交给这个任务，或者交给别的任务" }[s.followUps]}
            >
              <Choice value={s.followUps} options={[["worker", "交给那个 worker"], ["secretary", "先给秘书判断"]]} onChange={(v) => put("followUps", v)} />
            </Field>
            <Field
              label="回复对方"
              hint={{ accept: "秘书一接下就回", dispatch: "任务派出去时才回：没过目之前不替你说话。待办任务的「派出去」上面有个框，预先填好下面的回复内容，可以改，留空就不回", never: "不替你回" }[s.ack]}
            >
              <Choice value={s.ack} options={[["accept", "接下时"], ["dispatch", "派出去时"], ["never", "不回"]]} onChange={(v) => put("ack", v)} />
            </Field>
            {s.ack !== "never" && (
              <Field label="回复内容" hint="{id} {title} 会换成任务号和标题">
                <input className={input} value={s.ackText} placeholder={ACK_TEXT} onChange={(e) => put("ackText", e.target.value)} />
              </Field>
            )}
          </Section>
        </>
      )}
      <SaveBar dirty={dirty} busy={busy} onSave={save} onRevert={() => saved && setS(JSON.parse(saved))} />
    </div>
  );
}

export function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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

export function Choice<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
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

// Permission modes each engine takes, for an agent that hasn't run here yet (Gerdr lists an agent's own once it has)
export const MODES: Record<string, AgentChoice[]> = {
  claude: ["default", "acceptEdits", "plan", "auto"].map((id) => ({ id, name: id })),
  codex: ["ask", "auto", "read-only", "full-access"].map((id) => ({ id, name: id })),
};

function WhoFields({ who, onChange }: { who: Who; onChange: (w: Who) => void }) {
  const agents = useAgents();
  // The agent the menus are for: the one picked, else Gerdr's default agent
  const a = agents.find((x) => x.id === who.agent) ?? (who.agent ? undefined : agents.find((x) => x.default));
  const engine = a?.base ?? a?.id ?? "";
  // The agent's own list (Gerdr reports it once it has run here); the known engines' as a fallback before that
  const modes = a?.modes?.length ? a.modes : (MODES[engine] ?? [...MODES.claude, ...MODES.codex.filter((m) => m.id !== "auto")]);
  // What 默认 is: Gerdr's default for this agent, else the one the agent's own list marks (claude: "默认 · …")
  const named = (list: AgentChoice[] | undefined, id: string | undefined) => {
    const hit = id != null ? list?.find((o) => o.id === id) : undefined;
    return (hit ?? list?.find((o) => o.description?.startsWith("默认")))?.name ?? id;
  };
  return (
    <>
      <Field label="agent">
        {/* A different agent: its own models and efforts, so the old ones (claude's names mean nothing to codex) go */}
        <AgentPick value={who.agent} onChange={(agent) => onChange({ ...who, agent, ...(agent !== who.agent ? { model: "", effort: "", mode: "" } : {}) })} />
      </Field>
      <Field label="模型" hint={a?.models?.length ? "默认：Gerdr 设置里给这个 agent 定的。" : "这个 agent 在这台电脑上还没跑过，Gerdr 还不知道它有哪些模型：先手写（claude：sonnet、haiku、fable 这类），跑过一次后这里就能选。"}>
        {a?.models?.length ? (
          <ChoicePick value={who.model} options={a.models} def={named(a.models, a.defaults?.model)} onChange={(model) => onChange({ ...who, model })} />
        ) : (
          <input className={input} value={who.model} placeholder="默认" onChange={(e) => onChange({ ...who, model: e.target.value })} />
        )}
      </Field>
      <Field label="思考强度">
        {a?.efforts?.length ? (
          <ChoicePick value={who.effort} options={a.efforts} def={named(a.efforts, a.defaults?.effort)} onChange={(effort) => onChange({ ...who, effort })} />
        ) : (
          <input className={input} value={who.effort} placeholder="默认" onChange={(e) => onChange({ ...who, effort: e.target.value })} />
        )}
      </Field>
      <Field label="权限模式" hint="它的会话用什么权限模式开。默认：Gerdr 设置里的（那个默认是全部自动批准时不算）。会话要人批准时会停下来等你：不想它停，就选 auto。">
        <ChoicePick value={who.mode} options={modes} def={a?.defaults?.mode} onChange={(mode) => onChange({ ...who, mode })} />
      </Field>
    </>
  );
}

function Repos({ repos, onChange }: { repos: Repo[]; onChange: (r: Repo[]) => void }) {
  const [add, setAdd] = useState("");
  const at = (i: number, r: Partial<Repo>) => onChange(repos.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const push = () => {
    // A completed folder ends in / (PathPick fills "…/gerdr/" to list what's inside): stored without it, so the
    // same repository isn't added twice and its name shows
    const p = add.trim().replace(/(.)\/+$/, "$1");
    if (p && !repos.some((r) => r.path === p)) onChange([...repos, { path: p }]);
    setAdd("");
  };
  return (
    <div className="space-y-2">
      {!repos.length && <p className="text-[12px] text-muted-foreground">还没有仓库。</p>}
      {repos.map((r, i) => (
        // The folder's name leads (the full paths mostly share their start, so a cut-off path showed the same few words
        // on every row); the full path sits under it, wrapped rather than cut
        // The colour in a column of its own, so the name, the path and the note all start on one line under each other
        <div key={r.path} className="flex gap-2.5 rounded-lg border bg-background p-2.5">
          <RepoColor value={r.color} onChange={(color) => at(i, { color })} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex h-5 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={r.color ? { color: r.color } : undefined} title={r.path}>
                {r.path.replace(/\/+$/, "").split("/").pop() || r.path}
              </span>
              <Button variant="ghost" size="icon" className="-my-1 shrink-0" aria-label={`去掉 ${r.path}`} onClick={() => onChange(repos.filter((_, j) => j !== i))}>
                <X className="size-3.5" />
              </Button>
            </div>
            <p className="-mt-1 break-all font-mono text-[11px] text-muted-foreground">{r.path}</p>
            <input className={input} value={r.note ?? ""} placeholder="说明：比如「行情服务的后端」" onChange={(e) => at(i, { note: e.target.value })} />
          </div>
        </div>
      ))}
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <PathPick value={add} onChange={setAdd} onEnter={push} placeholder="加一个仓库的绝对路径，或输入名字找最近用过的项目" />
        </div>
        <Button variant="outline" disabled={!add.trim()} onClick={push}>
          <Plus className="size-3.5" />
          加
        </Button>
      </div>
    </div>
  );
}

/**
 * A repository's colour (lib/repoColor.ts): a dot that opens the presets, a custom one (the system's colour picker)
 * and none. In the list it colours the repository's name on a task's row; on the new-conversation page, its folder.
 */
function RepoColor({ value, onChange }: { value?: string; onChange: (c: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", off, true);
    return () => document.removeEventListener("pointerdown", off, true);
  }, [open]);
  const dot = "size-5 shrink-0 rounded-full border";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title="颜色：列表里这个仓库的名字、⌘T 页上它的文件夹按钮用它"
        className={clsx(dot, "flex items-center justify-center", !value && "border-dashed text-muted-foreground")}
        style={value ? { background: value, borderColor: value } : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {!value && <Palette className="size-3" />}
      </button>
      {open && (
        <div className="absolute top-7 left-0 z-20 w-56 space-y-2 rounded-lg border bg-popover p-2 shadow-lg">
          <div className="grid grid-cols-5 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.hex}
                type="button"
                title={p.name}
                className={clsx(dot, value === p.hex && "ring-2 ring-foreground ring-offset-1 ring-offset-popover")}
                style={{ background: p.hex, borderColor: p.hex }}
                onClick={() => (onChange(p.hex), setOpen(false))}
              />
            ))}
          </div>
          {/* Lined up with the swatches above: no inset of its own, a hover that changes the text only */}
          <div className="flex items-center gap-2 text-[12px]">
            <label className="flex flex-1 cursor-pointer items-center gap-2 py-1 text-muted-foreground hover:text-foreground">
              {/* The system's picker: any colour, kept as #rrggbb */}
              <input type="color" className="size-5 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0" value={value ?? "#8b8d98"} onChange={(e) => onChange(e.target.value)} />
              自定义
            </label>
            {value && (
              <button type="button" className="py-1 text-muted-foreground hover:text-foreground" onClick={() => (onChange(undefined), setOpen(false))}>
                不要颜色
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
