import { AlertTriangle, Braces, FileText, Folder, KeyRound, Loader2, Plus, Save, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button";
import { askSecret, secretNames } from "../lib/bridge";
import { run } from "../lib/gerdr";
import { format, joinList, parse, setValue, specFor, splitList, TYPES, type Var, type VarType } from "../lib/vars";

// 流程: the user's skills (skills/<name>/SKILL.md + references/). Prose in their own words, which Gerdr gives the Work
// agent and every session the Work starts as a skill (they read what they need), with {{name: value ; type}}
// variables where the code needs a value (lib/vars.ts). The text area highlights the variables; the panel beside it
// gives each one a control of its type, and inserts new ones. Saved as plain text: editing the file by hand works too.
// Saved as this person's copy (user/skills/, never shared): the panel's own file stays the default, 恢复默认 brings it
// back (local/playbooks.ts).

type Entry = { name: string; skill: string; index: boolean; vars: number; errors: number; changed?: boolean; own?: boolean };

export default function FlowPage() {
  const [files, setFiles] = useState<Entry[] | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [etag, setEtag] = useState<string | undefined>();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [caret, setCaret] = useState(-1);
  const [inserting, setInserting] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== saved;

  const loadList = () => run<Entry[]>("playbooks.list").then(setFiles, (e) => setErr(String(e.message || e)));
  useEffect(() => {
    void loadList();
  }, []);
  useEffect(() => {
    if (!name && files?.length) void open(files[0].name);
  }, [files]);

  async function open(n: string) {
    // Unsaved changes go with you rather than asking (no browser confirm box): save, then switch
    if (dirty && name) await save();
    setErr("");
    try {
      const r = await run<{ text: string; etag: string }>("playbooks.read", { name: n });
      setName(n);
      setText(r.text);
      setSaved(r.text);
      setEtag(r.etag);
    } catch (e: any) {
      setErr(String(e.message || e));
    }
  }

  async function save() {
    setBusy(true);
    setErr("");
    try {
      const r = await run<{ etag: string }>("playbooks.save", { name, text, etag });
      setEtag(r.etag);
      setSaved(text);
      void loadList();
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setErr("");
    try {
      const r = await run<{ text: string; etag: string }>("playbooks.reset", { name });
      setText(r.text);
      setSaved(r.text);
      setEtag(r.etag);
      void loadList();
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

  const vars = useMemo(() => parse(text), [text]);
  const active = vars.find((v) => caret >= v.start && caret <= v.end);
  const insertAt = (snippet: string) => {
    const at = ta.current?.selectionStart ?? text.length;
    setText(text.slice(0, at) + snippet + text.slice(at));
    setInserting(false);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(at + snippet.length, at + snippet.length);
    });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6 max-md:p-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">流程</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            你的做事方式，用自己的话写。它是一个 skill：右边的助手和它派出去的 worker 都有，需要时自己翻到对应的参考。改动只存在你这里，不会随面板分享出去（带点的是你改过的）；
            <span className="rounded-sm bg-brand/15 px-1 text-brand">高亮的变量</span>是代码要用的值，在右边改。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-[12px] text-warn">没保存</span>}
          {!dirty && files?.find((f) => f.name === name)?.changed && (
            <Button variant="outline" disabled={busy} title="这份你改过：去掉你的修改，用面板自带的默认内容" onClick={reset}>
              恢复默认
            </Button>
          )}
          <Button disabled={!dirty || busy} onClick={save}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            保存
          </Button>
        </div>
      </header>
      {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}

      <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)_300px]">
        <nav className="space-y-1">
          {[...new Set((files ?? []).map((f) => f.skill))].map((skill) => (
            <div key={skill} className="space-y-0.5 pb-2">
              <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{skill}</div>
              {(files ?? [])
                .filter((f) => f.skill === skill)
                .map((f) => (
                  <button key={f.name} onClick={() => open(f.name)} className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent", f.name === name && "bg-accent font-medium")}>
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{f.index ? "索引（SKILL.md）" : f.name.split("/").pop()!.replace(/\.md$/, "")}</span>
                    {f.changed && <span className="size-1.5 shrink-0 rounded-full bg-brand" title="你改过（只在你这里）" />}
                    {f.errors > 0 ? <AlertTriangle className="size-3 text-bad" /> : f.vars > 0 && <span className="text-[11px] text-muted-foreground">{f.vars}</span>}
                  </button>
                ))}
              <NewRef skill={skill} onCreate={async (n, when) => { const r = await run<{ name: string }>("playbooks.addReference", { skill, name: n, when }); await loadList(); await open(r.name); }} />
            </div>
          ))}
        </nav>

        <Editor ta={ta} text={text} vars={vars} active={active} onChange={setText} onCaret={setCaret} />

        <aside className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-medium">变量 · {vars.length}</h2>
            <Button variant="outline" onClick={() => setInserting(!inserting)}>
              <Braces className="size-3.5" />
              插入变量
            </Button>
          </div>
          {inserting && <InsertVar onInsert={insertAt} onCancel={() => setInserting(false)} />}
          {!vars.length && !inserting && <p className="text-[12px] text-muted-foreground">这份流程里还没有变量。代码要用的值（要不要自动合并、多久一次）用「插入变量」放进句子里。</p>}
          <ul className="space-y-2">
            {vars.map((v) => (
              <VarRow key={`${v.start}-${v.name}`} v={v} active={active?.start === v.start} onChange={(value) => setText(setValue(text, v.start, value))} />
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

// Both layers keep the scrollbar's room ([scrollbar-gutter:stable]): otherwise the text wraps at different widths and
// the highlights drift off their words.
const TYPO = "p-3 text-[13px] leading-6 whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-sans [scrollbar-gutter:stable]";

/**
 * The text is drawn by the layer behind (so variables can have their own colour), the textarea on top only carries
 * the caret and the selection: its own text is transparent. Same typography and scrollbar room on both, scrolled
 * together, or the colours drift off their words.
 */
function Editor({ ta, text, vars, active, onChange, onCaret }: { ta: React.RefObject<HTMLTextAreaElement | null>; text: string; vars: Var[]; active?: Var; onChange: (t: string) => void; onCaret: (n: number) => void }) {
  const back = useRef<HTMLDivElement>(null);
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const v of vars) {
    parts.push(text.slice(at, v.start));
    parts.push(
      <mark key={v.start} className={clsx("rounded-sm [box-decoration-break:clone]", v.error ? "bg-bad/20 text-bad" : active?.start === v.start ? "bg-brand/35 text-brand" : "bg-brand/20 text-brand")}>
        {text.slice(v.start, v.end)}
      </mark>,
    );
    at = v.end;
  }
  parts.push(text.slice(at) + "\n");
  const caret = () => onCaret(ta.current?.selectionStart ?? -1);
  return (
    <div className="relative h-[70vh] overflow-hidden rounded-lg border bg-card max-md:h-[50vh]">
      <div ref={back} aria-hidden className={clsx(TYPO, "pointer-events-none absolute inset-0 overflow-hidden text-foreground")}>
        {parts}
      </div>
      <textarea
        ref={ta}
        value={text}
        spellCheck={false}
        onChange={(e) => (onChange(e.target.value), caret())}
        onSelect={caret}
        onClick={caret}
        onKeyUp={caret}
        onScroll={(e) => back.current && (back.current.scrollTop = e.currentTarget.scrollTop)}
        className={clsx(TYPO, "absolute inset-0 size-full resize-none bg-transparent text-transparent caret-foreground outline-none selection:bg-brand/30")}
      />
    </div>
  );
}

const input = "h-8 w-full rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]";

function VarRow({ v, active, onChange }: { v: Var; active: boolean; onChange: (value: string) => void }) {
  const t = TYPES.find((x) => x.type === v.type);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <li ref={ref} className={clsx("space-y-1.5 rounded-lg border p-2.5", active ? "border-ring" : "bg-card")}>
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium">{v.name}</span>
        <span className="text-[11px] text-muted-foreground">{t?.label}</span>
      </div>
      <Control v={v} onChange={onChange} />
      {v.error && <p className="text-[11px] text-bad">{v.error}</p>}
    </li>
  );
}

function Control({ v, onChange }: { v: Var; onChange: (value: string) => void }) {
  const val = v.value.trim();
  switch (v.type) {
    case "choice":
      return (
        <select className={input} value={val} onChange={(e) => onChange(e.target.value)}>
          {!v.options?.includes(val) && <option value={val}>{val || "（空）"}</option>}
          {v.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
    case "multi": {
      const on = new Set(splitList(val));
      return (
        <div className="flex flex-wrap gap-1.5">
          {v.options?.map((o) => (
            <button
              key={o}
              onClick={() => onChange(joinList(v.options!.filter((x) => (x === o ? !on.has(o) : on.has(x)))))}
              className={clsx("rounded-md border px-2 py-0.5 text-[12px]", on.has(o) ? "border-brand bg-brand/15 text-brand" : "text-muted-foreground hover:bg-accent")}
            >
              {o}
            </button>
          ))}
        </div>
      );
    }
    case "number":
      return <input className={input} type="number" min={v.min} max={v.max} value={val} onChange={(e) => onChange(e.target.value)} />;
    case "duration":
      return (
        <div className="space-y-1.5">
          <input className={clsx(input, "font-mono")} value={val} onChange={(e) => onChange(e.target.value)} />
          <div className="flex gap-1">
            {["5m", "30m", "1h", "6h", "1d"].map((d) => (
              <button key={d} onClick={() => onChange(d)} className={clsx("rounded-sm px-1.5 text-[11px]", d === val ? "bg-brand/15 text-brand" : "text-muted-foreground hover:bg-accent")}>
                {d}
              </button>
            ))}
          </div>
        </div>
      );
    case "time":
      return <Items items={splitList(val)} onChange={(l) => onChange(joinList(l))} type="time" />;
    case "list":
      return <Items items={splitList(val)} onChange={(l) => onChange(joinList(l))} />;
    case "dir":
    case "file":
      return <PathPick value={val} files={v.type === "file"} onChange={onChange} />;
    case "secret":
      return <SecretPick value={val} onChange={onChange} />;
    case "agent":
      return <AgentPick value={val} onChange={onChange} />;
  }
  return <input className={input} value={val} onChange={(e) => onChange(e.target.value)} />;
}

/** Several values: one chip each, removable, and a box to add one (Enter). */
function Items({ items, onChange, type }: { items: string[]; onChange: (l: string[]) => void; type?: "time" }) {
  const [add, setAdd] = useState("");
  const push = () => {
    const x = add.trim();
    if (x && !items.includes(x)) onChange([...items, x]);
    setAdd("");
  };
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {items.map((x) => (
          <span key={x} className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[12px]">
            {x}
            <button aria-label={`去掉 ${x}`} onClick={() => onChange(items.filter((y) => y !== x))} className="text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          </span>
        ))}
        {!items.length && <span className="text-[12px] text-muted-foreground">（空）</span>}
      </div>
      <div className="flex gap-1.5">
        <input className={input} type={type} value={add} placeholder={type ? undefined : "加一项，回车"} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => e.key === "Enter" && push()} />
        <Button variant="outline" size="icon" aria-label="加" onClick={push}>
          <Plus className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** A folder / file: type it, or browse from the user's projects down. */
function PathPick({ value, files, onChange }: { value: string; files: boolean; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [here, setHere] = useState<{ path: string; home: string; recent: string[]; entries: { name: string; path: string; dir: boolean }[] } | null>(null);
  const go = (path?: string) => run("playbooks.browse", { path, files }).then(setHere, () => {});
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <input className={clsx(input, "font-mono text-[12px]")} value={value} onChange={(e) => onChange(e.target.value)} />
        <Button variant="outline" size="icon" aria-label="选择" onClick={() => (setOpen(!open), !here && go(value && !files ? value : undefined))}>
          <Folder className="size-3.5" />
        </Button>
      </div>
      {open && here && (
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border bg-background p-1.5 text-[12px]">
          <div className="flex items-center gap-1 px-1 font-mono text-[11px] text-muted-foreground">
            <button className="hover:text-foreground" onClick={() => go(here.path.replace(/\/[^/]+\/?$/, "") || "/")}>
              ..
            </button>
            <span className="min-w-0 flex-1 truncate">{here.path}</span>
            {!files && (
              <button className="text-brand hover:underline" onClick={() => (onChange(here.path), setOpen(false))}>
                选这里
              </button>
            )}
          </div>
          {here.entries.map((e) => (
            <button key={e.path} onClick={() => (e.dir ? go(e.path) : (onChange(e.path), setOpen(false)))} className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-accent">
              {e.dir ? <Folder className="size-3 text-muted-foreground" /> : <FileText className="size-3 text-muted-foreground" />}
              <span className="truncate">{e.name}</span>
            </button>
          ))}
          {here.recent.length > 0 && (
            <>
              <div className="px-1 pt-1 text-[11px] text-muted-foreground">最近的项目</div>
              {here.recent.map((p) => (
                <button key={p} onClick={() => go(p)} className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left font-mono text-[11px] hover:bg-accent">
                  <Folder className="size-3 text-muted-foreground" />
                  <span className="truncate">{p.replace(here.home, "~")}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A Work secret by name; the value is typed into Gerdr's own dialog and never seen here. */
function SecretPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [names, setNames] = useState<string[]>([]);
  const reload = () => secretNames().then(setNames, () => {});
  useEffect(() => {
    void reload();
  }, []);
  const has = names.includes(value);
  return (
    <div className="flex items-center gap-1.5">
      <input className={clsx(input, "font-mono text-[12px]")} value={value} list="secret-names" onChange={(e) => onChange(e.target.value)} />
      <datalist id="secret-names">
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <Button variant="outline" disabled={!/^[\w.-]+$/.test(value)} onClick={async () => (await askSecret(value, { label: value }), reload())}>
        <KeyRound className="size-3.5" />
        {has ? "改" : "设置"}
      </Button>
    </div>
  );
}

function AgentPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    run("playbooks.agents").then(setList, () => {});
  }, []);
  return (
    <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
      {!list.some((a) => a.id === value) && <option value={value}>{value || "（选一个）"}</option>}
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} ({a.id})
        </option>
      ))}
    </select>
  );
}

/** A new variable: pick the type, name it, give its options / range and value. */
function InsertVar({ onInsert, onCancel }: { onInsert: (snippet: string) => void; onCancel: () => void }) {
  const [type, setType] = useState<VarType>("choice");
  const [name, setName] = useState("");
  const [extra, setExtra] = useState("");
  const [value, setValue] = useState("");
  const needsOptions = type === "choice" || type === "multi";
  const ok = name.trim() && !/[:{};]/.test(name) && (!needsOptions || extra.includes("|")) && !/;|\}\}/.test(value);
  const snippet = format({ name: name.trim(), value: value || (needsOptions ? extra.split("|")[0].trim() : ""), spec: specFor(type, extra.trim()) });
  return (
    <div className="space-y-2 rounded-lg border border-ring p-2.5">
      <div className="grid grid-cols-3 gap-1">
        {TYPES.map((t) => (
          <button key={t.type} title={t.hint} onClick={() => setType(t.type)} className={clsx("rounded-md border px-1.5 py-1 text-[12px]", type === t.type ? "border-brand bg-brand/15 text-brand" : "text-muted-foreground hover:bg-accent")}>
            {t.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{TYPES.find((t) => t.type === type)?.hint}</p>
      <input className={input} placeholder="名字（比如 合并方式）" value={name} onChange={(e) => setName(e.target.value)} />
      {needsOptions && <input className={input} placeholder="选项，用 | 隔开：自动 | 手动" value={extra} onChange={(e) => setExtra(e.target.value)} />}
      {type === "number" && <input className={input} placeholder="范围（可不填）：0-5" value={extra} onChange={(e) => setExtra(e.target.value)} />}
      <input className={input} placeholder={needsOptions ? "当前值（不填就是第一个选项）" : "当前值"} value={value} onChange={(e) => setValue(e.target.value)} />
      <p className="rounded-sm bg-muted px-1.5 py-1 font-mono text-[11px] break-all">{snippet}</p>
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button disabled={!ok} onClick={() => onInsert(snippet)}>
          插入到光标处
        </Button>
      </div>
    </div>
  );
}

/** A new reference in a skill: its name, and when to read it (that line goes into the skill's index). */
function NewRef({ skill, onCreate }: { skill: string; onCreate: (name: string, when: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState("");
  const [when, setWhen] = useState("");
  const [err, setErr] = useState("");
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent">
        <Plus className="size-3.5" />
        新参考
      </button>
    );
  const go = async () => {
    try {
      await onCreate(n.trim(), when.trim());
      setOpen(false);
      setN("");
      setWhen("");
    } catch (e: any) {
      setErr(String(e.message || e));
    }
  };
  return (
    <div className="space-y-1.5 rounded-md border p-2">
      <input autoFocus className={input} placeholder="名字（比如 weekly）" value={n} onChange={(e) => setN(e.target.value)} />
      <input className={input} placeholder="什么时候看（写进索引）" value={when} onChange={(e) => setWhen(e.target.value)} onKeyDown={(e) => e.key === "Enter" && n.trim() && go()} />
      {err && <p className="text-[11px] text-bad">{err}</p>}
      <div className="flex justify-end gap-1">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          取消
        </Button>
        <Button disabled={!n.trim()} onClick={go}>
          加
        </Button>
      </div>
    </div>
  );
}
