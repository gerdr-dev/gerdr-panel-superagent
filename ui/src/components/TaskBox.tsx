import { X } from "lucide-react";
import clsx from "clsx";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { AttachmentBar, useAttach, type Attachment } from "./Attachments";
import { isSubmitEnter } from "../lib/utils";

// The 新任务 box, shared by every task panel that copies it (the team panel syncs this file as it is): the dialog's
// frame, and the text with its images and files (paste, drop, pick) and @ agents. What a panel asks besides (who it
// is for, which repository) and its buttons are its own, passed as children.

/** Still uploading: the task can't go yet (each file's path is only known once it's up). */
export const uploading = (files: Attachment[]) => files.some((x) => !x.path && !x.error);

/** The 新任务 dialog's frame: title, ✕, then the panel's own fields and buttons; err under them. */
export function TaskDialog({ title, onClose, busy, err, children }: { title: string; onClose: () => void; busy?: boolean; err?: string; children: ReactNode }) {
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // Esc with the @ list open closes the list (MentionArea), not the dialog
        onEscapeKeyDown={(e) => document.querySelector("[data-mention-list]") && e.preventDefault()}
        className="flex max-h-[90dvh] w-full flex-col gap-3 overflow-y-auto p-4 sm:max-w-xl"
      >
        <div className="flex items-center justify-between">
          <DialogTitle className="text-[15px] font-medium">{title}</DialogTitle>
          <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        {children}
        {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the task is: the text (Enter sends, Shift+Enter a new line; @ offers `agents`), images and files pasted into
 * it, dropped on it or picked. `files` hold each one's path on Gerdr's machine once uploaded (lib/upload).
 * below: under the text, above the files (a line saying who was @-ed).
 */
export function TaskBox({
  value,
  onChange,
  onSubmit,
  files,
  onFiles,
  placeholder,
  agents = [],
  className,
  below,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  files: Attachment[];
  onFiles: (f: (cur: Attachment[]) => Attachment[]) => void;
  placeholder?: string;
  agents?: AgentInfo[];
  className?: string;
  below?: ReactNode;
}) {
  const attach = useAttach(files, onFiles);
  return (
    <div className="space-y-2" onDrop={attach.onDrop} onDragOver={attach.onDragOver}>
      <MentionArea agents={agents} value={value} onChange={onChange} onPaste={attach.onPaste} onSubmit={onSubmit} className={className} placeholder={placeholder} />
      {below}
      <AttachmentBar items={files} onChange={onFiles} onPick={attach.add} />
    </div>
  );
}

export type AgentInfo = { id: string; name: string; base?: string; prompt?: string };

/** The agents @-mentioned in the text (by id or name), each once. Same reading as local/_agents.ts. */
export function mentionsOf(text: string, agents: AgentInfo[]): AgentInfo[] {
  const out: AgentInfo[] = [];
  for (const m of text.matchAll(/@([^\s@，。,.;；:：!?！？)）]+)/g)) {
    const w = m[1].toLowerCase();
    const a = agents.find((x) => x.id.toLowerCase() === w || x.name.toLowerCase() === w);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/** A textarea where typing @ offers the agents: ↑ ↓ to move, Enter / Tab to pick, Esc to dismiss. */
export function MentionArea({
  agents,
  value,
  onChange,
  onPaste,
  onSubmit,
  className,
  placeholder,
  up = false,
  autoFocus = true,
  byName = false,
}: {
  /** Picking inserts @name (a member's repository: what people call it), not @id. */
  byName?: boolean;
  agents: AgentInfo[];
  /** The @ list opens above the box (a box at the bottom of the screen). */
  up?: boolean;
  autoFocus?: boolean;
  value: string;
  onChange: (v: string) => void;
  /** Enter (not Shift+Enter, not an input method's): send. With the @ list open, Enter picks from it instead. */
  onSubmit?: () => void;
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>;
  className?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [q, setQ] = useState<{ word: string; at: number } | null>(null);
  const [hi, setHi] = useState(0);
  const found = q ? agents.filter((a) => (a.id + " " + a.name).toLowerCase().includes(q.word.toLowerCase())).slice(0, 6) : [];
  const look = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    setQ(m ? { word: m[2], at: before.length - m[2].length - 1 } : null);
    setHi(0);
  };
  const pick = (a: AgentInfo) => {
    if (!q) return;
    const end = q.at + 1 + q.word.length;
    const word = byName ? a.name : a.id;
    onChange(value.slice(0, q.at) + "@" + word + " " + value.slice(end));
    setQ(null);
    const caret = q.at + word.length + 2;
    requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret));
  };
  return (
    <div className="relative">
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        className={className}
        placeholder={placeholder}
        value={value}
        onPaste={onPaste}
        onChange={(e) => {
          onChange(e.target.value);
          look(e.target);
        }}
        onClick={(e) => look(e.currentTarget)}
        onBlur={() => setTimeout(() => setQ(null), 150)}
        onKeyDown={(e) => {
          if (!found.length) {
            if (onSubmit && isSubmitEnter(e)) {
              e.preventDefault();
              onSubmit();
            }
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => (h + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length);
          } else if ((e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) || e.key === "Tab") {
            e.preventDefault();
            pick(found[hi]);
          } else if (e.key === "Escape") {
            // only the list closes, not the dialog
            e.stopPropagation();
            setQ(null);
          }
        }}
      />
      {found.length > 0 && (
        <div data-mention-list className={clsx("absolute inset-x-2 z-50 overflow-hidden", up ? "bottom-full mb-1" : "top-full mt-1", "rounded-md border bg-popover text-[13px] text-popover-foreground shadow-md")}>
          {found.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className={clsx("flex w-full items-baseline gap-2 px-3 py-1.5 text-left", i === hi && "bg-accent")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(a);
              }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="shrink-0 font-medium">{a.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">@{a.id}</span>
              {a.prompt && <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{a.prompt}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
