import clsx from "clsx";
import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * A title that is renamed in place: a click turns it into an input, Enter (or leaving it) saves, Esc puts it back.
 * Titles come from the first words of what was asked (a URL, "关闭 t91，新建一个来交接"), so they get renamed.
 */
export function EditableTitle({ value, onSave, className }: { value: string; onSave: (title: string) => Promise<unknown>; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  const save = async () => {
    const x = text.trim();
    if (!x || x === value) return setEditing(false);
    setBusy(true);
    setErr("");
    try {
      await onSave(x);
      setEditing(false);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  if (editing)
    return (
      <input
        ref={ref}
        autoFocus
        value={text}
        disabled={busy}
        title={err || "回车保存，Esc 取消"}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void save();
          if (e.key === "Escape") {
            e.stopPropagation();
            setText(value);
            setEditing(false);
          }
        }}
        className={clsx("h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]", err && "border-bad", className)}
      />
    );
  return (
    <button title="改名" onClick={() => setEditing(true)} className={clsx("group flex min-w-0 flex-1 items-center gap-1 text-left", className)}>
      <span className="min-w-0 truncate">{value}</span>
      <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
