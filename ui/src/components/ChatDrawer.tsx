import { ArrowDownRight, ArrowLeft, MoreHorizontal, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { SessionChat, useSession } from "@gerdr/core";
import { Button } from "./Button";
import { Trail, type TrailProps } from "./Trail";

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
  sub,
  onSub,
  label,
  actions,
  items,
  trail,
  onAction,
  onClose,
  back,
}: {
  /** Where it was opened from (a requirement's drawer, by a member's avatar): a way back there in the title row. */
  back?: { label: string; onBack: () => void };
  session: string;
  /** One of its subagents' conversation instead (a toolCallId), and where 查看对话 / the way back go (null = main). */
  sub?: string;
  onSub?: (toolCallId: string | null) => void;
  /** The board's 链路 (which conversations this task went through): a toggle in the title row, the list under it. */
  trail?: TrailProps;
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
  const [full, setFull] = useState(false);
  useEffect(() => setFull(false), [label]);
  const go = (ref: string) => setJump((j) => ({ ref, seq: (j?.seq ?? 0) + 1 }));
  const act = (a: ChatAction) => {
    if (a.confirm && armed !== a.id) return setArmed(a.id);
    setArmed("");
    onAction?.(a.id);
  };
  // The main step (通过) stays in sight; the rarely used ones (放弃, 标为完成) are in the ⋯ menu of the title row
  const shown = (actions ?? []).filter((a) => a.kind === "primary");
  const tucked = (actions ?? []).filter((a) => a.kind !== "primary");
  const button = (a: ChatAction) => (
    <Button
      key={a.id}
      variant={a.kind === "primary" ? "default" : "ghost"}
      title={a.label}
      className={clsx("h-7 max-w-[20rem] min-w-0 text-[12px]", (a.kind === "danger" || armed === a.id) && "text-bad hover:text-bad")}
      onClick={() => act(a)}
    >
      <span className="min-w-0 truncate">{armed === a.id ? a.confirm : a.label}</span>
    </Button>
  );
  const header = (toggle: ReactNode) => (
    <div className="relative z-30 flex h-10 shrink-0 items-center gap-1 border-b px-3">
      {back && (
        <Button variant="ghost" className="-ml-1.5 h-7 shrink-0 gap-1 px-1.5 text-[12px] text-muted-foreground" title={back.label} onClick={back.onBack}>
          <ArrowLeft className="size-3.5" />
          <span className="max-w-[10rem] truncate">{back.label}</span>
        </Button>
      )}
      <span className={clsx("mr-1 size-2 shrink-0 rounded-full", s?.status === "running" ? "bg-ok" : s?.status === "waiting" || s?.status === "error" ? "bg-warn" : "bg-muted-foreground/40")} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s?.title || session}</span>
      {toggle}
      {tucked.length > 0 && <Menu actions={tucked} armed={armed} onPick={act} onClose={() => setArmed("")} />}
      <Button variant="ghost" size="icon" className="size-7" title="关闭" onClick={onClose}>
        <X className="size-4" />
      </Button>
    </div>
  );
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
        {trail ? <Trail {...trail} header={header} /> : header(null)}
        {(label || shown.length > 0 || items?.length) && (
          <div className="shrink-0 space-y-1 border-b bg-muted/40 px-3 py-1.5">
            {(label || shown.length > 0) && (
              <div className="flex items-center gap-2">
                {label && (
                  // Clamped; a tap shows all of it
                  <button
                    className={clsx("min-w-0 flex-1 text-left text-[12px] whitespace-pre-wrap text-muted-foreground", !full && "line-clamp-3")}
                    title={label}
                    onClick={() => setFull(!full)}
                  >
                    {label}
                  </button>
                )}
                {shown.length > 0 && <div className="ml-auto flex shrink-0 gap-1.5">{shown.map((a) => button(a))}</div>}
              </div>
            )}
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
          <SessionChat id={session} focused jump={jump} sendNow sub={sub} onSub={onSub} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The ⋯ menu. Drawn in place, not portaled: a portaled menu lands in the panel's mount outside the sheet, and a click
 * there counts as one on the board, closing the drawer. A confirm item asks in place (its label becomes the question).
 */
function Menu({ actions, armed, onPick, onClose }: { actions: ChatAction[]; armed: string; onPick: (a: ChatAction) => void; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return onClose();
    const out = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", out, true);
    return () => document.removeEventListener("pointerdown", out, true);
  }, [open]);
  return (
    <div ref={box} className="relative">
      <Button variant="ghost" size="icon" className="size-7" title="更多" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MoreHorizontal className="size-4" />
      </Button>
      {open && (
        <div role="menu" className="absolute top-full right-0 z-10 mt-1 min-w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {actions.map((a) => (
            <button
              key={a.id}
              role="menuitem"
              className={clsx("flex w-full rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-accent", (a.kind === "danger" || armed === a.id) && "text-bad")}
              onClick={() => {
                if (a.confirm && armed !== a.id) return onPick(a);
                setOpen(false);
                onPick(a);
              }}
            >
              {armed === a.id ? a.confirm : a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
