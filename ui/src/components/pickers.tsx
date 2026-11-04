import { Folder } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { Button } from "./Button";
import { run } from "../lib/gerdr";

// Controls the 设置 page shares: a folder (typed, or browsed from the user's projects down) and an agent / role.

export const input = "h-8 w-full rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]";

type Here = { path: string; home: string; recent: string[]; entries: { name: string; path: string }[] };

/** A folder: type it, or browse (the user's recent projects listed under the folders). */
export function PathPick({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [here, setHere] = useState<Here | null>(null);
  const go = (path?: string) => run<Here>("settings.browse", { path }).then(setHere, () => {});
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <input className={clsx(input, "font-mono text-[12px]")} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        <Button variant="outline" size="icon" aria-label="选择文件夹" onClick={() => (setOpen(!open), !here && go(value || undefined))}>
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
            <button className="text-brand hover:underline" onClick={() => (onChange(here.path), setOpen(false))}>
              选这里
            </button>
          </div>
          {here.entries.map((e) => (
            <button key={e.path} onClick={() => go(e.path)} className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-accent">
              <Folder className="size-3 text-muted-foreground" />
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

let agentList: Promise<{ id: string; name: string }[]> | null = null;

/** An agent / role set up in Gerdr; "" = Gerdr's default agent. */
export function AgentPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    agentList ??= run("settings.agents");
    agentList.then(setList, () => (agentList = null));
  }, []);
  return (
    <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Gerdr 的默认 agent</option>
      {value && !list.some((a) => a.id === value) && <option value={value}>{value}</option>}
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} ({a.id})
        </option>
      ))}
    </select>
  );
}
