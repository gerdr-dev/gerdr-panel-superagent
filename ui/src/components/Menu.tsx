import { MoreHorizontal } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";

/** An item of the ⋯ menu. confirm: the first click asks (the label becomes this), the second does it. */
export type ChatAction = { id: string; label: string; kind?: "primary" | "danger"; confirm?: string; /** Drawn before the label in the ⋯ menu. */ icon?: ReactNode };

/**
 * The ⋯ menu. Drawn in place, not portaled: a portaled menu lands in the panel's mount outside the sheet, and a click
 * there counts as one outside the drawer, closing it. A confirm item asks in place (its label becomes the question).
 */
export function Menu({ actions, armed, onPick, onClose }: { actions: ChatAction[]; armed: string; onPick: (a: ChatAction) => void; onClose: () => void }) {
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
              className={clsx("flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-accent", (a.kind === "danger" || armed === a.id) && "text-bad")}
              onClick={() => {
                if (a.confirm && armed !== a.id) return onPick(a);
                setOpen(false);
                onPick(a);
              }}
            >
              {a.icon}
              {armed === a.id ? a.confirm : a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
