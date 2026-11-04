import { FileText, Plus } from "lucide-react";
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

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6 max-md:p-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">流程</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            你的做事方式，用自己的话写。它是一个 skill：右边的助手和它派出去的 worker 都有，需要时自己翻到对应的参考。改动只存在你这里，不会随面板分享出去（带点的是你改过的）。
            代码照着做的值（用哪个模型、有哪些仓库、MR 自动合不合）在「设置」里，不写在这里。
          </p>
        </div>
        <div className="flex items-center gap-2">
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
                  </button>
                ))}
              <NewRef skill={skill} onCreate={async (n, when) => { const r = await run<{ name: string }>("playbooks.addReference", { skill, name: n, when }); await loadList(); await open(r.name); }} />
            </div>
          ))}
        </nav>

        <textarea
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          className="h-[70vh] w-full resize-none rounded-lg border bg-card p-3 font-sans text-[13px] leading-6 outline-none focus:ring-2 focus:ring-ring max-md:h-[50vh] max-md:text-[16px]"
        />
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
