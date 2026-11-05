import { Brain, FolderGit2 } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { run } from "../lib/gerdr";
import { SaveBar } from "../components/SaveBar";

// 记忆: what the agents learned from the user about each repository (MR or straight push, who merges, who approves a
// release), one file per repository plus one for all of them (local/memory.ts, user/memory/). The agents add lines
// with their remember tool; here the user reads them, fixes a wrong one, or writes their own. Plain text, as the
// agents get it: one line per fact.

type Entry = { name: string; label: string; repo?: string; note?: string; text: string; etag?: string };

const count = (text: string) => text.split("\n").filter((l) => l.trim()).length;

export default function MemoryPage() {
  const [files, setFiles] = useState<Entry[] | null>(null);
  const [name, setName] = useState("_general");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [etag, setEtag] = useState<string | undefined>();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = text !== saved;
  const cur = files?.find((f) => f.name === name);

  const loadList = () =>
    run<Entry[]>("memory.list").then(
      (l) => {
        setFiles(l);
        return l;
      },
      (e) => {
        setErr(String(e.message || e));
        return null;
      },
    );

  useEffect(() => {
    void loadList().then((l) => l && show(l, name));
  }, []);

  function show(l: Entry[], n: string) {
    const f = l.find((x) => x.name === n) ?? l[0];
    if (!f) return;
    setName(f.name);
    setText(f.text);
    setSaved(f.text);
    setEtag(f.etag);
  }

  async function open(n: string) {
    // Unsaved changes go with you rather than asking: save, then switch
    if (dirty) await save();
    setErr("");
    // Read again: an agent may have remembered something since the list was loaded
    const l = await loadList();
    if (l) show(l, n);
  }

  async function save() {
    setBusy(true);
    setErr("");
    try {
      const r = await run<{ etag?: string }>("memory.save", { name, text, etag });
      setEtag(r.etag);
      setSaved(text);
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
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">记忆</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          每个仓库的具体情况：走不走 MR、谁来合、发布找谁批。worker 做事时从你的话里学到、你确认过的，会一条条记在这里，以后派到这个仓库的 worker 一开始就带着。
          「通用」是对所有仓库都成立的，调度会话派活时也看。错了直接改，一行一条；只存在你这里，不随面板分享。
        </p>
      </header>
      {err && (
        <p role="alert" className="text-[13px] text-bad">
          {err}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="space-y-0.5">
          {(files ?? []).map((f) => (
            <button
              key={f.name}
              onClick={() => open(f.name)}
              title={f.repo ?? "对所有仓库都成立的"}
              className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent", f.name === name && "bg-accent font-medium")}
            >
              {f.repo || f.name !== "_general" ? <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" /> : <Brain className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className={clsx("min-w-0 flex-1 truncate", !count(f.text) && "text-muted-foreground")}>{f.label}</span>
              {count(f.text) > 0 && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{count(f.text)}</span>}
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-2">
          {cur && (
            <p className="text-[12px] text-muted-foreground">
              {cur.repo ? (
                <>
                  <span className="break-all font-mono">{cur.repo}</span>
                  {cur.note && <> · {cur.note}</>}
                </>
              ) : cur.name === "_general" ? (
                "对所有仓库都成立的；没单独写的仓库照这里做。"
              ) : (
                "这个仓库不在「设置 → 仓库」里了，记忆还留着。"
              )}
            </p>
          )}
          <textarea
            value={text}
            spellCheck={false}
            placeholder={"还没有记下什么。一行一条，比如：\n- 小改动可以直接推 master，不用开 MR\n- MR 能合了你直接合\n- 发布要在发布系统发审批，找张三批"}
            onChange={(e) => setText(e.target.value)}
            className="h-[60vh] w-full resize-none rounded-lg border bg-card p-3 font-sans text-[13px] leading-6 outline-none focus:ring-2 focus:ring-ring max-md:h-[50vh] max-md:text-[16px]"
          />
        </div>
      </div>
      <SaveBar dirty={dirty} busy={busy} onSave={save} onRevert={() => setText(saved)} />
    </div>
  );
}
