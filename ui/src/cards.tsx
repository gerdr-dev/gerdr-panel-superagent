import { useEffect, useState } from "react";
import { AlarmClock, Check, Hourglass, Pencil, Undo2 } from "lucide-react";
import { DefaultCard, registerCard, type CardProps } from "@gerdr/core";
import { run } from "./lib/gerdr";

// Cards the board's panel tools put in a worker's chat (local/board.ts). Gerdr loads this file at start, so they're drawn
// this way wherever the chat is shown: the board's drawer, or the worker's tab in Code.

type Step = { status: string; handedBack?: string; title?: string; kind?: string };

/**
 * A step or decision the worker put on the board (ask_human): the built-in card while it waits, so it can be answered
 * right there; once it's done or taken back on the board, a one-line record of how it ended instead of a card that
 * still looks open. The board is asked again every 30s while the card is on screen.
 */
function TaskStep({ card }: CardProps) {
  const id = String(card.ref ?? "");
  // Which board it belongs to: one person can have this panel in several projects, each with its own t4. Not the page's
  // project — this runs in Gerdr's own page. Older cards only carried it in their answer button (choose.project);
  // one with neither isn't asked about at all rather than asked of the wrong board.
  const c = card as { project?: string; choose?: { project?: string } };
  const board = c.project ?? c.choose?.project;
  const [st, setSt] = useState<Step>();
  // Changing an answer already sent: the built-in card again, its pick going to tasks.reanswer (with its few seconds
  // of undo too). The card's own undo only covers the seconds before a pick is sent.
  const [changing, setChanging] = useState<string | false>(false); // the answer it had when the change was opened
  // The new answer arrived (a poll after tasks.reanswer): back to the one-line record, showing it
  useEffect(() => {
    if (changing !== false && st?.handedBack !== changing) setChanging(false);
  }, [st?.handedBack]);
  useEffect(() => {
    if (!id || !board) return;
    let dead = false;
    const get = () => run<Step>("tasks.status", { id }, { project: board }).then((v) => !dead && setSt(v), () => {});
    void get();
    const timer = setInterval(get, 30000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [id, board]);
  const changeable = st?.status === "done" && (st.kind === "choice" || st.kind === "value") && !!card.choose && !!board;
  if (changing && changeable) {
    // A question of several is changed the way it's answered; an older single ask through tasks.reanswer
    const choose = { ...card.choose!, fn: card.choose!.fn === "tasks.answerQuestion" ? card.choose!.fn : "tasks.reanswer", project: board! };
    return (
      <div>
        {/* Its own ref: the first answer's pick (sent) is kept under the card's ref, and would show here as already made */}
        <DefaultCard card={{ ...card, ref: `${id}:change:${changing}`, kicker: `改答案 · ${id} · 现在是「${changing}」`, choose }} />
        <button className="mb-1.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setChanging(false)}>
          不改了
        </button>
      </div>
    );
  }
  if (st?.status === "done" || st?.status === "dropped") {
    const done = st.status === "done";
    return (
      <div className="my-1.5 flex items-center gap-2 rounded-lg border border-l-2 border-l-ok bg-card px-3 py-2 text-[12px] text-muted-foreground">
        {done ? <Check className="size-3.5 shrink-0 text-ok" /> : <Undo2 className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">
          {id} {card.title}
        </span>
        <span className="min-w-0 shrink truncate">{done ? (st.handedBack ? `已处理：${st.handedBack}` : "已处理") : "已撤回"}</span>
        {changeable && (
          <button className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground" title="答错了？改成别的，worker 会收到新旧两个答案" onClick={() => setChanging(st.handedBack ?? "")}>
            <Pencil className="size-3" />
            改答案
          </button>
        )}
      </div>
    );
  }
  return <DefaultCard card={card} />;
}

registerCard("task-step", TaskStep);

type Wait = { state: "waiting" | "ended" | "gone"; body?: string; how?: string; at?: number };

/**
 * A worker ending its turn to wait on someone / something outside (wait_for, local/waits.ts). Without it the chat just
 * stopped after "I'll wait", and the user couldn't tell whether anything was still going on. While the wait is on: what
 * it waits for and what will wake it, with a pulse; once over, what woke it. The board is asked every 20s.
 */
function TaskWait({ card }: CardProps) {
  // kind "mr": an MR handed to the watcher (task_update delivering); else a wait_for
  const c = card as { project?: string; task?: string; since?: number; title?: string; body?: string; kind?: string; url?: string };
  const [st, setSt] = useState<Wait>();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!c.project || !c.task || !c.since) return;
    let dead = false;
    const get = () => run<Wait>("waits.status", { id: c.task, since: c.since, kind: c.kind }, { project: c.project }).then((v) => !dead && setSt(v), () => {});
    void get();
    const timer = setInterval(() => (get(), tick((n) => n + 1)), 20000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [c.project, c.task, c.since, c.kind]);
  const on = !st || st.state === "waiting";
  const mins = c.since ? Math.max(0, Math.round((Date.now() - c.since) / 60000)) : 0;
  const waited = mins < 1 ? "刚开始" : mins < 60 ? `等了 ${mins} 分钟` : `等了 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分`;
  if (!on)
    return (
      <div className="my-1.5 flex items-center gap-2 rounded-lg border border-l-2 border-l-ok bg-card px-3 py-2 text-[12px] text-muted-foreground">
        <Check className="size-3.5 shrink-0 text-ok" />
        <span className="min-w-0 flex-1 truncate">等：{c.title}</span>
        <span className="shrink-0">{st?.how ?? "不等了"}{st?.at ? ` · ${new Date(st.at).toTimeString().slice(0, 5)}` : ""}</span>
      </div>
    );
  return (
    <div className="my-1.5 space-y-1 rounded-lg border border-l-2 border-l-brand bg-card px-3 py-2">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-brand" />
        </span>
        <span>在等 · {c.task}</span>
        <span className="ml-auto shrink-0">{waited}</span>
      </div>
      <p className="text-[13px] font-medium">
        {c.url ? (
          <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">
            {c.title}
          </a>
        ) : (
          c.title
        )}
      </p>
      {(st?.body ?? c.body) && (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          {st?.body?.includes("回来看") || c.body?.includes("回来看") ? <AlarmClock className="size-3.5 shrink-0" /> : <Hourglass className="size-3.5 shrink-0" />}
          {st?.body ?? c.body}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">它这一轮结束后不占着，等到了会被叫醒接着做；想催它或改主意，直接在下面说。</p>
    </div>
  );
}

registerCard("task-wait", TaskWait);
