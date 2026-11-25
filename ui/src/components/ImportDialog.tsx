import clsx from "clsx";
import { Check, Folder, Loader2 } from "lucide-react";
import { useState } from "react";
import * as core from "@gerdr/core";
import { run } from "../lib/gerdr";
import { Button } from "./Button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const AgentIcon = (core as unknown as { AgentIcon?: (p: { agent: string; className?: string }) => React.ReactNode }).AgentIcon;
const toast = (core as unknown as { toast?: ((m: string) => unknown) & { error?: (m: string) => unknown } }).toast;

export type ImportRepo = { path: string; name: string; have: boolean };
export type ImportSession = { id: string; title: string; cwd: string; agent: string; status: string; updatedAt?: number };

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
function ago(ms?: number) {
  if (!ms) return "";
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? "刚刚" : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
}

/**
 * 从 Code 导入: what Code has in this project, to pick from. The workspaces become repositories (设置 → 仓库: what the
 * secretary picks from and the new-conversation page offers), ticked to begin with; conversations become tasks, each
 * carried on by a worker of ours (local/import.ts), unticked to begin with: every one starts an agent. Once: the panel
 * doesn't follow Code after this.
 */
export function ImportDialog({ repos, sessions, onClose, onDone }: { repos: ImportRepo[]; sessions: ImportSession[]; onClose: () => void; onDone: (firstWorker?: string) => void }) {
  const [pickRepos, setPickRepos] = useState(() => new Set(repos.filter((r) => !r.have).map((r) => r.path)));
  const [pick, setPick] = useState(() => new Set<string>());
  const [busy, setBusy] = useState(false);
  const blocked = (s: ImportSession) => (s.status === "running" || s.status === "starting" ? "在跑，停下后再导" : s.status === "waiting" ? "在等你，先去处理" : "");
  const free = sessions.filter((s) => !blocked(s));
  const toggle = (set: Set<string>, put: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    put(next);
  };
  const go = async () => {
    setBusy(true);
    try {
      const r = await run<{ repos: string[]; tasks: { task: string; worker?: string }[]; failed: { session: string; why: string }[] }>("import.run", { repos: [...pickRepos], sessions: [...pick] });
      const said = [r.repos.length && `${r.repos.length} 个仓库`, r.tasks.length && `${r.tasks.length} 个对话`].filter(Boolean).join("、");
      if (said) toast?.(`导入了 ${said}`);
      for (const f of r.failed) toast?.error?.(`「${sessions.find((s) => s.id === f.session)?.title ?? f.session}」没导入：${f.why}`);
      onDone(r.tasks[0]?.worker);
    } catch (e: any) {
      toast?.error?.(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const n = pickRepos.size + pick.size;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[85vh] flex-col gap-3 p-5 sm:max-w-xl">
        <DialogTitle className="text-[15px]">从 Code 导入</DialogTitle>
        <p className="text-[12px] text-muted-foreground">这个面板只列它自己的任务。Code 里已有的东西，选了才带进来，只做这一次；之后在 Code 里新开的，不会自己出现在这里。</p>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <Section title="仓库" hint="这个项目的工作空间，加进「设置 → 仓库」：秘书从里面挑，新对话页也列它们" none="没有工作空间">
            {repos.map((r) => (
              <Line key={r.path} on={r.have || pickRepos.has(r.path)} disabled={r.have} onClick={() => toggle(pickRepos, setPickRepos, r.path)} title={r.path}>
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                {/* The path even when it's already there: two workspaces often share a folder name (work, ui…) */}
                <span className="max-w-[55%] shrink-0 truncate font-mono text-[11px] text-muted-foreground" style={{ direction: "rtl" }}>{"\u200e" + r.path}</span>
                {r.have && <span className="shrink-0 text-[11px] text-muted-foreground">已有</span>}
              </Line>
            ))}
          </Section>
          <Section
            title="对话"
            hint="变成任务：有编号，秘书知道它，能盯 MR、能等你。每个会起一个 agent 接着原来的聊，原来那个对话关掉（记录还在）"
            none="Code 里没有别的对话"
            action={
              free.length > 1 ? (
                <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setPick(pick.size === free.length ? new Set() : new Set(free.map((s) => s.id)))}>
                  {pick.size === free.length ? "都不选" : "全选"}
                </button>
              ) : null
            }
          >
            {sessions.map((s) => {
              const why = blocked(s);
              return (
                <Line key={s.id} on={pick.has(s.id)} disabled={!!why} onClick={() => toggle(pick, setPick, s.id)} title={s.cwd}>
                  {AgentIcon ? <AgentIcon agent={s.agent} className="size-3.5 shrink-0" /> : null}
                  <span className="min-w-0 flex-1 truncate">{s.title || base(s.cwd)}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{why || `${base(s.cwd)} · ${ago(s.updatedAt)}`}</span>
                </Line>
              );
            })}
          </Section>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !n} onClick={() => void go()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy
              ? "在导入…"
              : [pickRepos.size && `${pickRepos.size} 个仓库`, pick.size && `${pick.size} 个对话`].filter(Boolean).join("、")
                ? `导入 ${[pickRepos.size && `${pickRepos.size} 个仓库`, pick.size && `${pick.size} 个对话`].filter(Boolean).join("、")}`
                : "导入"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, hint, none, action, children }: { title: string; hint: string; none: string; action?: React.ReactNode; children: React.ReactNode[] }) {
  return (
    <div className="pb-3">
      <div className="flex items-baseline gap-2 pb-1">
        <span className="text-[13px] font-medium">{title}</span>
        <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{hint}</span>
        {action}
      </div>
      {children.length ? <div className="flex flex-col gap-px">{children}</div> : <div className="py-2 text-[12px] text-muted-foreground">{none}</div>}
    </div>
  );
}

function Line({ on, disabled, onClick, title, children }: { on: boolean; disabled?: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button title={title} disabled={disabled} onClick={onClick} className={clsx("flex min-h-8 items-center gap-2 rounded-md px-2 text-left text-[12.5px] max-md:min-h-10", disabled ? "opacity-55" : "hover:bg-accent/60")}>
      <span className={clsx("flex size-4 shrink-0 items-center justify-center rounded-sm border", on ? "border-brand bg-brand text-background" : "border-muted-foreground/40")}>
        {on && <Check className="size-3" strokeWidth={3} />}
      </span>
      {children}
    </button>
  );
}
