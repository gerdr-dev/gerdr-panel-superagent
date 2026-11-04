import { ArrowDownRight, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { SessionChat, useSession } from "@gerdr/core";
import { Button } from "./Button";

// A worker's conversation over the right of the board: Gerdr's own chat (SessionChat from @gerdr/core: images, files,
// approvals, cards), with the board's line, things waiting on the user and buttons above it. A shadcn Sheet, not
// modal: the chat opens things of its own outside the sheet (a picture's lightbox, menus), which a modal sheet would
// make unclickable and count as a click outside. Esc or a click on the board closes it; an Esc the chat's input box
// is using (stopping the agent) doesn't.

/** A button above the chat. confirm: the first click asks (the label becomes this), the second does it. */
export type ChatAction = { id: string; label: string; kind?: "primary" | "danger"; confirm?: string };
/** One thing waiting on the user: a line; jump scrolls the chat to the card with that ref. */
export type ChatItem = { text: string; jump?: string };

export function ChatDrawer({
  session,
  label,
  actions,
  items,
  top,
  onAction,
  onClose,
}: {
  session: string;
  /** Above the line and buttons: the board's 链路 (which conversations this task went through). */
  top?: React.ReactNode;
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
  const go = (ref: string) => setJump((j) => ({ ref, seq: (j?.seq ?? 0) + 1 }));
  return (
    <Sheet open modal={false} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-full gap-0 sm:max-w-[640px]"
        onEscapeKeyDown={(e) => {
          if ((document.activeElement as Element | null)?.closest?.("textarea, input, [contenteditable=true]")) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          // Only a click on the board itself: not the chat's own lightbox, menus or Gerdr's toasts. A click on another
          // task's card isn't a way out either: the drawer switches to that task (the card's own click) instead
          const el = e.target as Element | null;
          if (!el?.closest?.("[data-gerdr-mount]") || el.closest("[data-task-card]")) e.preventDefault();
        }}
      >
        <SheetTitle className="sr-only">{s?.title || session}</SheetTitle>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <span className={clsx("size-2 shrink-0 rounded-full", s?.status === "running" ? "bg-ok" : s?.status === "waiting" || s?.status === "error" ? "bg-warn" : "bg-muted-foreground/40")} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s?.title || session}</span>
          <Button variant="ghost" size="icon" className="size-7" title="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        {top}
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
          <SessionChat id={session} focused jump={jump} sendNow />
        </div>
      </SheetContent>
    </Sheet>
  );
}
