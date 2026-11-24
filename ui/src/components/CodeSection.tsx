import * as core from "@gerdr/core";
import clsx from "clsx";
import { Check, ChevronRight, Forward, Kanban, MessageSquare, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { run } from "../lib/gerdr";
import { openAsks, type Task, useTasks } from "../lib/tasks";
import { setView, showInCode, useCodeSession } from "../lib/view";
import { usePanelChange, useRefresh, useSessions } from "../lib/visible";

// The secretary's part of Code's list (lib/view.ts, layout.tsx): the secretary's own conversation first, then the
// tasks it handed out that are in progress, whatever repository each works in. Rows open as ordinary Code panes, so
// a worker gets what any conversation in Code has: splits, a terminal beside it, the diff. The person's own quick
// conversations stay below, in Code's workspaces, and never become tasks unless handed over (交给秘书).
//
// Kept short on purpose: 进行中 only, 等你 first; 待验收 folds to a line and 已完成 isn't here at all. The board has
// everything.

const toast = (core as unknown as { toast?: { error?: (m: string) => unknown } }).toast;
const useSession = (core as unknown as { useSession?: (id: string | undefined) => { id: string; title?: string; cwd?: string; tags?: Record<string, string> } | undefined }).useSession;

const FOLD = "gerdr-panel-fusion.reviewOpen";
const base = (p?: string) => (p ?? "").replace(/\/+$/, "").split("/").pop() ?? "";

type Main = { id: string; status: string; waiting?: string } | null;

export function CodeSection() {
  const { tasks, act } = useTasks();
  const cur = useCodeSession();
  const navigate = useNavigate();
  const [main, setMain] = useState<Main>(null);
  const [asks, setAsks] = useState(0);
  // Which session is the secretary only changes with the log (pushed); its status is followed live below
  useRefresh(
    () =>
      run<{ main: Main; asks?: { open: unknown[] } }>("superagent.log", { limit: 1 }).then(
        (r) => (setMain(r.main), setAsks(r.asks?.open?.length ?? 0)),
        () => {},
      ),
    [usePanelChange("user/data")],
    { poll: 10_000 },
  );
  const live = useSessions((s) => s.id === main?.id)[0];
  const status = main && main.status !== "gone" ? (live?.status ?? main.status) : "";
  const openMain = () =>
    main && status
      ? showInCode(main.id)
      : run<{ main: string }>("secretary.open", {}).then(
          (r) => showInCode(r.main),
          (e) => toast?.error?.(String(e?.message ?? e)),
        );

  const [reviewOpen, setReviewOpen] = useState(() => {
    try {
      return localStorage.getItem(FOLD) === "1";
    } catch {
      return false;
    }
  });
  const foldReview = () => {
    setReviewOpen((v) => {
      try {
        localStorage.setItem(FOLD, v ? "0" : "1");
      } catch {}
      return !v;
    });
  };

  // Members of a requirement are folded into its card on the board; here each is a row: each is a conversation
  const mine = (tasks ?? []).filter((t) => t.status === "running" || t.status === "review");
  const running = mine.filter((t) => t.status === "running").sort((a, b) => Number(b.column === "you") - Number(a.column === "you") || b.updatedAt - a.updatedAt);
  const review = mine.filter((t) => t.status === "review").sort((a, b) => b.updatedAt - a.updatedAt);
  const todo = (tasks ?? []).filter((t) => t.status === "todo").length;
  const you = running.filter((t) => t.column === "you").length + asks;

  const open = (t: Task) => {
    if (t.session) return showInCode(t.session);
    // Not handed out yet: nothing to show in Code, its card is on the board
    setView("board");
    navigate(`/?open=${t.id}`);
  };
  const move = (t: Task, to: "review" | "done" | "running") => act("setStatus", { id: t.id, status: to }).catch((e) => toast?.error?.(String(e?.message ?? e)));

  return (
    <div className="pt-1.5" data-fusion-section>
      <div className="flex h-7 items-center gap-1 pr-1 pl-1.5 text-[11px] font-medium text-muted-foreground select-none">
        <span>秘书</span>
        {you > 0 && <span className="rounded-full bg-warn px-1.5 text-[10px] leading-4 font-semibold text-background tabular-nums">等你 {you}</span>}
        <span className="flex-1" />
        <button
          className="flex h-5 items-center gap-1 rounded-sm px-1 hover:bg-muted hover:text-foreground"
          title="任务面板：四列全貌、待办、去向、设置、新任务"
          onClick={() => setView("board")}
        >
          <Kanban className="size-3.5" />
          {todo > 0 && <span className="tabular-nums">待办 {todo}</span>}
        </button>
      </div>

      <RowShell current={!!main && cur === main.id} onClick={openMain} title="和秘书说话：交给它的事、它怎么判断外面来的消息、派给了谁，都在这段对话里">
        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">秘书</span>
        <AgentPick main={main?.id} current={cur} />
        {asks > 0 ? (
          <span className="shrink-0 rounded-full bg-warn px-1.5 text-[10px] leading-4 font-semibold text-background tabular-nums">{asks} 个问题</span>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">{status === "running" ? "在判断" : status === "waiting" ? "等你回答" : status === "error" ? "出错了" : ""}</span>
        )}
      </RowShell>
      <HandOver current={cur} main={main?.id} onSent={(id) => showInCode(id)} />

      {running.map((t) => (
        <TaskRow key={t.id} t={t} current={!!t.session && cur === t.session} onOpen={() => open(t)}>
          <RowButton title="移到待验收" onClick={() => move(t, "review")}>
            <Check className="size-3.5" />
          </RowButton>
        </TaskRow>
      ))}
      {tasks && !running.length && <div className="py-1 pl-[26px] text-[12px] text-muted-foreground">没有进行中的任务</div>}

      {review.length > 0 && (
        <>
          <button
            className="flex h-7 w-full items-center gap-1 rounded-md pr-1 pl-1.5 text-[11px] font-medium text-muted-foreground select-none hover:bg-accent/60 hover:text-foreground"
            onClick={foldReview}
          >
            <ChevronRight className={clsx("size-3.5 shrink-0 transition-transform", reviewOpen && "rotate-90")} />
            待验收 {review.length}
          </button>
          {reviewOpen &&
            review.map((t) => (
              <TaskRow key={t.id} t={t} current={!!t.session && cur === t.session} onOpen={() => open(t)}>
                <RowButton title="通过：移到已完成" onClick={() => move(t, "done")}>
                  <Check className="size-3.5" />
                </RowButton>
              </TaskRow>
            ))}
        </>
      )}
      <div className="mx-1.5 mt-1.5 border-b" />
    </div>
  );
}

type AgentOpt = { id: string; name: string; default?: boolean };

/**
 * Which agent the secretary runs as, changed on its row: the same setting as 设置 → 谁派活 (settings.router.agent),
 * here because in the Code view the settings are two clicks away in the board. Who a conversation runs as is fixed
 * when it starts, so a change means a new conversation that carries the old one on (local/_main.ts); it is started
 * right away when the secretary is idle, and shown in place of the old one if that was the pane in front. Model and
 * effort go back to the new agent's defaults: they are names of the old agent's.
 * A native select: the panel's own menus are portaled into its page, which isn't drawn while Code shows.
 */
function AgentPick({ main, current }: { main?: string; current?: string }) {
  const [agents, setAgents] = useState<AgentOpt[]>([]);
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const changed = usePanelChange("user");
  useRefresh(() => run<{ settings: { router: { agent: string } } }>("settings.get").then((r) => setAgent(r.settings.router.agent ?? ""), () => {}), [changed], { fallback: 600_000, poll: 600_000 });
  // The list comes from Gerdr's own config (a few commands): once, not with every change of ours
  useRefresh(() => run<AgentOpt[]>("settings.agents").then(setAgents, () => {}), [], { fallback: 600_000, poll: 600_000 });
  if (!agents.length) return null;
  const def = agents.find((a) => a.default);
  const pick = async (id: string) => {
    setBusy(true);
    setAgent(id);
    try {
      await run("settings.set", { router: { agent: id, model: "", effort: "" } });
      const r = await run<{ main: string }>("secretary.open", {});
      if (main && current === main && r.main !== main) showInCode(r.main);
    } catch (e: any) {
      toast?.error?.(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <select
      value={agent}
      disabled={busy}
      title="秘书用哪个 agent：换了之后新开一段对话接着聊（之前说的都带着）；秘书正忙时，等它这一轮结束后的下一条消息起生效"
      className="max-w-[45%] shrink-0 cursor-pointer appearance-none truncate rounded-sm bg-transparent px-1 text-right text-[11px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground disabled:opacity-50"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => void pick(e.target.value)}
    >
      <option value="">{def ? `默认（${def.name}）` : "默认"}</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

function RowShell({ current, onClick, title, children }: { current?: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <div
      role="button"
      title={title}
      onClick={onClick}
      className={clsx(
        "group relative flex min-h-8 cursor-default items-center gap-2 rounded-md py-1 pr-2 pl-1.5 text-[12px] select-none",
        current ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent/60",
      )}
    >
      {children}
    </div>
  );
}

function RowButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      className="hidden size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground group-hover:flex hover:bg-muted hover:text-foreground [@media(hover:none)]:flex"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

/** What the row says under its title: what it waits on the person for, else the newest line of its worker. */
function lineOf(t: Task): string {
  if (t.column === "you") {
    const a = openAsks(t)[0];
    if (a) return `${a.handBack.kind === "none" ? "要你做" : "待你答"}：${a.title}`;
    if (t.live?.status === "waiting") return t.live.waiting || "等你审批";
    if (t.live?.status === "error") return t.live.error || "出错了";
    if (t.stopWhy) return t.stopWhy;
  }
  return (t.latest || t.summary || "").split("\n")[0];
}

function TaskRow({ t, current, onOpen, children }: { t: Task; current: boolean; onOpen: () => void; children?: React.ReactNode }) {
  const you = t.column === "you" && t.status === "running";
  const busy = t.live?.status === "running";
  const line = lineOf(t);
  return (
    <RowShell current={current} onClick={onOpen} title={`${t.id} ${t.title}${t.repo ? `\n${t.repo}` : ""}`}>
      <span className="flex size-3.5 shrink-0 items-center justify-center self-start pt-1.5">
        <span className={clsx("size-2 rounded-full", you ? "bg-warn" : busy ? "animate-pulse bg-ok" : "bg-muted-foreground/40")} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={clsx("min-w-0 flex-1 truncate", you && "font-medium")}>{t.title}</span>
          {t.repo && <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground group-hover:hidden">{base(t.repo)}</span>}
        </span>
        {line && <span className={clsx("truncate text-[11px]", you ? "text-warn" : "text-muted-foreground")}>{line}</span>}
      </span>
      {children}
    </RowShell>
  );
}

/**
 * 交给秘书: the conversation in Code's focused pane, when it isn't one of ours, goes to the secretary with a sentence
 * from the person. One entry for both "take this over" and "just have a look": the secretary judges from the
 * sentence (the person's call, 2026-11-24). It reads the conversation itself (`gerdr session read`), so nothing of
 * it is copied here.
 */
function HandOver({ current, main, onSent }: { current?: string; main?: string; onSent: (main: string) => void }) {
  const s = useSession?.(current);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Ours already (the secretary, a worker), or no conversation in the pane (a terminal, a new tab): nothing to hand over
  if (!s || s.tags?.panel || s.id === main) return null;
  const send = async () => {
    setBusy(true);
    const msg = [
      `我把 Code 里的一个对话交给你：「${s.title || "未命名"}」，会话 id ${s.id}${s.cwd ? `，目录 ${s.cwd}` : ""}。`,
      `先用 \`gerdr session read ${s.id}\` 读它，再照我下面说的办。我可能是要你接手跟进（建任务、派 worker，把这段对话里已经定下的东西带上），也可能只是问你一句；没说清就你来判断，拿不准再问我。`,
      text.trim() ? `我的话：${text.trim()}` : "我没多说：你看了之后告诉我你打算怎么办。",
    ].join("\n\n");
    try {
      const r = await run<{ main: string }>("secretary.say", { text: msg });
      setOpen(false);
      setText("");
      onSent(r.main);
    } catch (e: any) {
      toast?.error?.(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button
        className="flex h-7 w-full items-center gap-2 rounded-md pr-2 pl-1.5 text-[11px] text-muted-foreground select-none hover:bg-accent/60 hover:text-foreground"
        title="把正在看的这个对话交给秘书：让它接手跟进，或者只是问它一句，你说一句话，它自己判断"
        onClick={() => setOpen(true)}
      >
        <Forward className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">把「{s.title || "这个对话"}」交给秘书</span>
      </button>
    );
  return (
    <div className="mx-1 my-1 rounded-md border bg-background p-1.5">
      <div className="flex items-center gap-1 pb-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">交给秘书：{s.title || "这个对话"}</span>
        <button className="flex size-4 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground" title="不交了" onClick={() => setOpen(false)}>
          <X className="size-3" />
        </button>
      </div>
      <textarea
        autoFocus
        rows={2}
        value={text}
        disabled={busy}
        placeholder="跟秘书说一句：接手跟到合并 / 这个该放哪个仓库…（可不填）"
        className="w-full resize-none rounded-sm bg-muted/60 px-1.5 py-1 text-[12px] outline-none placeholder:text-muted-foreground/70"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), void send());
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <div className="flex justify-end pt-1">
        <button className="h-6 rounded-sm bg-brand px-2 text-[11px] font-medium text-background disabled:opacity-50" disabled={busy} onClick={() => void send()}>
          {busy ? "在交给它…" : "交给秘书"}
        </button>
      </div>
    </div>
  );
}
