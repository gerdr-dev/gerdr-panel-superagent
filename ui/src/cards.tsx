import { useEffect, useState } from "react";
import { Check, Pencil, Undo2 } from "lucide-react";
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
