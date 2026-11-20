import { FileText, GitCompare, Plus } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { input } from "../components/pickers";
import { run } from "../lib/gerdr";
import { isSubmitEnter } from "../lib/utils";
import { SaveBar } from "../components/SaveBar";

// 流程: the user's skills (skills/<name>/SKILL.md + references/). Prose in their own words, which Gerdr gives the panel
// agent and every session the panel starts as a skill (they read what they need). Only prose: values the code acts
// on are on the 设置 page (Settings.tsx), not variables in here. Saved as this person's copy (user/skills/, never shared): the panel's own file stays the default, 恢复默认 brings it
// back (local/playbooks.ts).

type Entry = { name: string; skill: string; index: boolean; changed?: boolean; own?: boolean };

export default function FlowPage() {
  const [files, setFiles] = useState<Entry[] | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [etag, setEtag] = useState<string | undefined>();
  // The panel's default of a file this person changed: with it, 对比默认 shows which lines are theirs
  const [base, setBase] = useState<string | undefined>();
  const [compare, setCompare] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
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
      const r = await run<{ text: string; etag: string; base?: string }>("playbooks.read", { name: n });
      setName(n);
      setText(r.text);
      setSaved(r.text);
      setEtag(r.etag);
      setBase(r.base);
      if (r.base === undefined) setCompare(false);
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
      if (base === undefined) void run<{ base?: string }>("playbooks.read", { name }).then((x) => setBase(x.base), () => {});
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
      setBase(undefined);
      setCompare(false);
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

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6 max-md:p-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">流程</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            秘书和它派出去的 worker 读的 skill：面板自带的默认做法，按你的习惯改，也可以加你自己的 skill。改动和你加的只存在你这里，不会随面板分享出去
            （实心点是你改过的，圈是只有你有的；改过的能「对比默认」看哪些是你的）。
            代码照着做的值（用哪个模型、有哪些仓库、MR 自动合不合）在「设置」里，不写在这里。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {base !== undefined && (
            <Button variant={compare ? "default" : "outline"} title="和面板自带的默认内容比：绿的是你加的，划掉的是你删的" onClick={() => setCompare((c) => !c)}>
              <GitCompare className="size-3.5" />
              对比默认
            </Button>
          )}
          {!dirty && files?.find((f) => f.name === name)?.changed && (
            <Button variant="outline" disabled={busy} title="这份你改过：去掉你的修改，用面板自带的默认内容" onClick={reset}>
              恢复默认
            </Button>
          )}
        </div>
      </header>
      {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}

      <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
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
                    {f.own && <span className="size-1.5 shrink-0 rounded-full border border-brand" title="只有你有（你加的）" />}
                  </button>
                ))}
              <NewRef skill={skill} onCreate={async (n, when) => { const r = await run<{ name: string }>("playbooks.addReference", { skill, name: n, when }); await loadList(); await open(r.name); }} />
            </div>
          ))}
          <NewSkill onCreate={async (n, description) => { const r = await run<{ name: string }>("playbooks.addSkill", { name: n, description }); await loadList(); await open(r.name); }} />
        </nav>

        {compare && base !== undefined ? (
          <DiffView base={base} text={text} />
        ) : (
        <textarea
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          className="h-[70vh] w-full resize-none rounded-lg border bg-card p-3 font-sans text-[13px] leading-6 outline-none focus:ring-2 focus:ring-ring max-md:h-[50vh] max-md:text-[16px]"
        />
        )}
      </div>
      <SaveBar dirty={dirty} busy={busy} onSave={save} onRevert={() => setText(saved)} />
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
      <input className={input} placeholder="什么时候看（写进索引）" value={when} onChange={(e) => setWhen(e.target.value)} onKeyDown={(e) => isSubmitEnter(e) && n.trim() && go()} />
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

/**
 * This person's copy against the panel's default, line by line: what they added (green), what they took out (struck
 * through), runs of untouched lines folded. Read-only: 对比默认 again goes back to editing.
 */
function DiffView({ base, text }: { base: string; text: string }) {
  const rows = diffLines(base.split("\n"), text.split("\n"));
  const out: React.ReactNode[] = [];
  const CTX = 2;
  for (let i = 0; i < rows.length; ) {
    if (rows[i].op !== "=") {
      out.push(<DiffRow key={i} row={rows[i]} />);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].op === "=") j++;
    // Keep a little context next to each change; fold the rest of the run
    const head = i === 0 ? 0 : CTX;
    const tail = j === rows.length ? 0 : CTX;
    if (j - i > head + tail + 1) {
      for (let k = i; k < i + head; k++) out.push(<DiffRow key={k} row={rows[k]} />);
      out.push(
        <div key={`f${i}`} className="px-3 py-0.5 text-[11px] text-muted-foreground/70">
          … {j - i - head - tail} 行没改 …
        </div>,
      );
      for (let k = j - tail; k < j; k++) out.push(<DiffRow key={k} row={rows[k]} />);
    } else for (let k = i; k < j; k++) out.push(<DiffRow key={k} row={rows[k]} />);
    i = j;
  }
  const same = rows.every((r) => r.op === "=");
  return (
    <div className="h-[70vh] overflow-auto rounded-lg border bg-card py-2 text-[13px] leading-6 max-md:h-[50vh]">
      {same ? <p className="px-3 text-muted-foreground">和默认的一样：没有你的改动。可以「恢复默认」去掉这份副本。</p> : out}
    </div>
  );
}

function DiffRow({ row }: { row: { op: "=" | "+" | "-"; line: string } }) {
  return (
    <div className={clsx("flex gap-2 whitespace-pre-wrap break-words px-3", row.op === "+" && "bg-ok/10", row.op === "-" && "bg-bad/10 text-muted-foreground line-through", row.op === "=" && "text-muted-foreground")}>
      <span className="w-3 shrink-0 select-none text-muted-foreground/70">{row.op === "=" ? "" : row.op}</span>
      <span className="min-w-0 flex-1">{row.line || "\u00a0"}</span>
    </div>
  );
}

/** Line diff by longest common subsequence: skill files are a few hundred lines at most. */
function diffLines(a: string[], b: string[]): { op: "=" | "+" | "-"; line: string }[] {
  const n = a.length, m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { op: "=" | "+" | "-"; line: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "=", line: a[i] });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", line: a[i++] });
    else out.push({ op: "+", line: b[j++] });
  }
  while (i < n) out.push({ op: "-", line: a[i++] });
  while (j < m) out.push({ op: "+", line: b[j++] });
  return out;
}

/** A skill of the user's own: its name and when to read it (the description agents decide by). */
function NewSkill({ onCreate }: { onCreate: (name: string, description: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState("");
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState("");
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="flex w-full items-center gap-2 rounded-md border-t px-2 pb-1.5 pt-2.5 text-left text-[12px] text-muted-foreground hover:bg-accent">
        <Plus className="size-3.5" />
        新 skill
      </button>
    );
  const go = async () => {
    try {
      await onCreate(n.trim(), desc.trim());
      setOpen(false);
      setN("");
      setDesc("");
    } catch (e: any) {
      setErr(String(e.message || e));
    }
  };
  return (
    <div className="space-y-1.5 rounded-md border p-2">
      <input autoFocus className={input} placeholder="名字（比如 weekly-report）" value={n} onChange={(e) => setN(e.target.value)} />
      <input className={input} placeholder="什么时候该读它（agent 照这句决定读不读）" value={desc} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => isSubmitEnter(e) && n.trim() && go()} />
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
