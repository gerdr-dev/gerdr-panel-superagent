import { useEffect, useState } from "react";
import { Check, Undo2 } from "lucide-react";
import { DefaultCard, registerCard, type CardProps } from "@gerdr/core";
import { run } from "./lib/gerdr";

// Cards the board's panel tools put in a worker's chat (local/board.ts). Gerdr loads this file at start, so they're drawn
// this way wherever the chat is shown: the board's drawer, or the worker's tab in Code.

type Step = { status: string; handedBack?: string; title?: string };

/**
 * A step or decision the worker put on the board (ask_human): the built-in card while it waits, so it can be answered
 * right there; once it's done or taken back on the board, a one-line record of how it ended instead of a card that
 * still looks open. The board is asked again every 30s while the card is on screen.
 */
function TaskStep({ card }: CardProps) {
  const id = String(card.ref ?? "");
  const [st, setSt] = useState<Step>();
  useEffect(() => {
    if (!id) return;
    let dead = false;
    const get = () => run<Step>("tasks.status", { id }).then((v) => !dead && setSt(v), () => {});
    void get();
    const timer = setInterval(get, 30000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [id]);
  if (st?.status === "done" || st?.status === "dropped") {
    const done = st.status === "done";
    return (
      <div className="my-1.5 flex items-center gap-2 rounded-lg border border-l-2 border-l-ok bg-card px-3 py-2 text-[12px] text-muted-foreground">
        {done ? <Check className="size-3.5 shrink-0 text-ok" /> : <Undo2 className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">
          {id} {card.title}
        </span>
        <span className="shrink-0">{done ? (st.handedBack ? `已处理：${st.handedBack}` : "已处理") : "已撤回"}</span>
      </div>
    );
  }
  return <DefaultCard card={card} />;
}

registerCard("task-step", TaskStep);
