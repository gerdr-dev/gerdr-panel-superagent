import { FileText, Loader2, Paperclip, X } from "lucide-react";
import clsx from "clsx";
import { useRef } from "react";
import { upload } from "../lib/upload";

// Images and files for a task, like Gerdr's chat input: paste (onPaste on the text box), drop (onDrop on the area),
// or pick. Each is uploaded to Gerdr's machine at once; the task keeps the path, and the worker gets an image as the
// image and anything else as a file link (ctx.sessions.start attachments).

export type Attachment = { name: string; mime: string; path?: string; url?: string; error?: string };

export function useAttach(items: Attachment[], onChange: (f: (cur: Attachment[]) => Attachment[]) => void) {
  const add = (files: File[]) => {
    for (const f of files) {
      const key = `${f.name}-${f.size}-${Math.random()}`;
      const item: Attachment & { key?: string } = { name: f.name || "image.png", mime: f.type, url: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined, key };
      onChange((cur) => [...cur, item]);
      upload(f).then(
        (path) => onChange((cur) => cur.map((x) => ((x as any).key === key ? { ...x, path } : x))),
        (e) => onChange((cur) => cur.map((x) => ((x as any).key === key ? { ...x, error: String(e.message || e) } : x))),
      );
    }
  };
  return {
    onPaste: (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.files];
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      add([...e.dataTransfer.files]);
    },
    onDragOver: (e: React.DragEvent) => e.dataTransfer.types.includes("Files") && e.preventDefault(),
    add,
    uploading: items.some((x) => !x.path && !x.error),
  };
}

export function AttachmentBar({ items, onChange, onPick }: { items: Attachment[]; onChange: (f: (cur: Attachment[]) => Attachment[]) => void; onPick: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((a, i) => (
        <div key={i} className={clsx("relative flex h-14 items-center gap-1.5 overflow-hidden rounded-md border bg-background", a.url ? "w-14" : "max-w-48 px-2", a.error && "border-bad")} title={a.error || a.name}>
          {a.url ? <img src={a.url} alt={a.name} className="size-full object-cover" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
          {!a.url && <span className="truncate text-[12px]">{a.name}</span>}
          {!a.path && !a.error && (
            <span className="absolute inset-0 flex items-center justify-center bg-background/60">
              <Loader2 className="size-4 animate-spin" />
            </span>
          )}
          <button aria-label={`去掉 ${a.name}`} onClick={() => onChange((cur) => cur.filter((_, j) => j !== i))} className="absolute top-0.5 right-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground hover:text-foreground">
            <X className="size-3" />
          </button>
        </div>
      ))}
      <button onClick={() => input.current?.click()} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
        <Paperclip className="size-3.5" />
        {items.length ? "再加" : "图片、文件（也可以粘贴、拖进来）"}
      </button>
      <input ref={input} type="file" multiple hidden onChange={(e) => (onPick([...(e.target.files ?? [])]), (e.target.value = ""))} />
    </div>
  );
}
