import { Loader2, Save, Undo2 } from "lucide-react";
import { Button } from "./Button";

/**
 * The one save bar of a settings page (dsh-superagent's rule): stuck to the bottom of the scrolling sheet, so it's
 * there however far down the change was made, and shown only while there is something to save, a save runs or one
 * failed. A button at the top of a long page was out of reach once scrolled (the user's report).
 */
export function SaveBar({ dirty, busy, error, onSave, onRevert }: { dirty: boolean; busy: boolean; error?: string; onSave: () => void; onRevert?: () => void }) {
  if (!dirty && !busy && !error) return null;
  return (
    <div className="sticky bottom-0 z-10 -mx-6 mt-4 flex items-center gap-2 border-t bg-background/95 px-6 py-2.5 backdrop-blur max-md:-mx-3 max-md:px-3">
      <span className={error ? "min-w-0 flex-1 truncate text-[12px] text-bad" : "min-w-0 flex-1 text-[12px] text-warn"} title={error}>
        {error || (busy ? "保存中…" : "有改动没保存（⌘S）")}
      </span>
      {onRevert && dirty && !busy && (
        <Button variant="ghost" onClick={onRevert}>
          <Undo2 className="size-3.5" />
          不改了
        </Button>
      )}
      <Button disabled={!dirty || busy} onClick={onSave}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
        保存
      </Button>
    </div>
  );
}
