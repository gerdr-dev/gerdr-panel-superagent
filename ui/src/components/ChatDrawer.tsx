import { ArrowDownRight, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { SessionChat, useSession } from "@gerdr/core";
import { Button } from "./Button";

// A worker's conversation over the right of the board: Gerdr's own chat (SessionChat from @gerdr/core, the same one as
// a pane in Code: images, files, approvals, cards), with the board's line, things waiting on the user and buttons above
// it. A drawer: Esc or a click outside closes it.

/** A button above the chat. confirm: the first click asks (the label becomes this), the second does it. */
export type ChatAction = { id: string; label: string; kind?: "primary" | "danger"; confirm?: string };
/** One thing waiting on the user: a line; jump scrolls the chat to the card with that ref. */
export type ChatItem = { text: string; jump?: string };

export function ChatDrawer({
  session,
  label,
  actions,
  items,
  onAction,
  onClose,
}: {
  session: string;
  label?: string;
  actions?: ChatAction[];
  items?: ChatItem[];
  onAction?: (id: string) => void;
  onClose: () => void;
}) {
  const s = useSession(session);
  const [armed, setArmed] = useState("");
  const [jump, setJump] = useState<{ ref: string; seq: number }>();
  useEffect(() => setArmed(""), [session]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      // The chat uses Esc itself (stopping the agent, closing its menus): only one nobody took closes the drawer
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[role=dialog][data-state=open]")) onClose();
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
  const go = (ref: string) => setJump((j) => ({ ref, seq: (j?.seq ?? 0) + 1 }));
  return (
    <>
      <div className="absolute inset-0 z-20 bg-black/20" onClick={onClose} aria-hidden />
      <aside className="absolute inset-y-0 right-0 z-30 flex w-[min(640px,100%)] flex-col border-l bg-background shadow-xl" aria-label={s?.title || session}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <span className={clsx("size-2 shrink-0 rounded-full", s?.status === "running" ? "bg-ok" : s?.status === "waiting" || s?.status === "error" ? "bg-warn" : "bg-muted-foreground/40")} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s?.title || session}</span>
          <Button variant="ghost" size="icon" className="size-7" title="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        {(label || actions?.length || items?.length) && (
          <div className="shrink-0 space-y-1 border-b bg-muted/40 px-3 py-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {label && (
                <span className="line-clamp-4 min-w-0 flex-1 text-[12px] whitespace-pre-wrap text-muted-foreground" title={label}>
                  {label}
                </span>
              )}
              <div className="ml-auto flex max-w-full flex-wrap justify-end gap-1.5">
                {actions?.map((a) => (
                  <Button
                    key={a.id}
                    variant={a.kind === "primary" ? "default" : "ghost"}
                    title={a.label}
                    className={clsx("h-7 max-w-[20rem] min-w-0 text-[12px]", (a.kind === "danger" || armed === a.id) && "text-bad hover:text-bad")}
                    onClick={() => {
                      if (a.confirm && armed !== a.id) return setArmed(a.id);
                      setArmed("");
                      onAction?.(a.id);
                    }}
                  >
                    <span className="min-w-0 truncate">{armed === a.id ? a.confirm : a.label}</span>
                  </Button>
                ))}
              </div>
            </div>
            {items?.map((it, n) => (
              <button
                key={n}
                title={it.text}
                onClick={() => it.jump && go(it.jump)}
                className="flex w-full items-center gap-2 rounded-md border-l-2 border-l-warn bg-warn/5 py-1.5 pr-1.5 pl-2 text-left text-[12px] hover:bg-warn/10"
              >
                <span className="min-w-0 flex-1 truncate">{it.text}</span>
                <ArrowDownRight className="size-3.5 shrink-0 text-warn" />
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <SessionChat id={session} focused jump={jump} />
        </div>
      </aside>
    </>
  );
}
