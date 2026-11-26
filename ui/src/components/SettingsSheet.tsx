import { Brain, FastForward, Inbox, Loader2, ScrollText, SlidersHorizontal, Timer, X, Zap } from "lucide-react";
import clsx from "clsx";
import { useRef, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "./ui/dialog";
import { UnsavedCtx, type Unsaved } from "./unsaved";
import Flow from "../settings/Flow";
import Memory from "../settings/Memory";
import Settings from "../settings/Settings";
import Schedules from "../settings/Schedules";
import Triggers from "../settings/Triggers";
import Log from "../settings/Log";
import LetGo from "../settings/LetGo";
import { Button } from "./Button";

// Everything behind the board, in a shadcn Sheet over it: where each outside message went (去向: the Superagent's
// log, local/superagent.ts), the values the code acts on (设置: who routes and works, repositories, merging, proactive
// work; local/settings.ts), when the agents carry on without the user (Let it go: policies, local/letgo.ts), how the user wants things done (流程: their skill, prose the agents read), what the agents learned about each
// repository (记忆: local/memory.ts), which outside
// events come in (触发器: local/inbox.ts) and what runs by itself (定时任务: tasks.sync, waits.tick and the rest). Not pages of their own: the panel
// is the board, these are what's behind it.

export type SettingsTab = "log" | "settings" | "letgo" | "flow" | "memory" | "schedules" | "triggers";

export const TABS: { id: SettingsTab; label: string; icon: typeof Timer }[] = [
  { id: "log", label: "去向", icon: Inbox },
  { id: "settings", label: "设置", icon: SlidersHorizontal },
  { id: "letgo", label: "Let it go", icon: FastForward },
  { id: "flow", label: "流程", icon: ScrollText },
  { id: "memory", label: "记忆", icon: Brain },
  { id: "triggers", label: "触发器", icon: Zap },
  { id: "schedules", label: "定时任务", icon: Timer },
];

export function SettingsSheet({ tab, onTab: switchTab, onClose: close, onTask }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; onClose: () => void; onTask: (id: string) => void }) {
  // The page on show reports unsaved changes here (unsaved.tsx); leaving it then waits for the user's answer
  const page = useRef<Unsaved | null>(null);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const leave = (go: () => void) => (page.current?.dirty ? setLeaving(() => go) : go());
  const onClose = () => leave(close);
  const onTab = (t: SettingsTab) => t !== tab && leave(() => switchTab(t));
  async function saveAndGo() {
    if (!page.current || !leaving) return;
    setSaving(true);
    const ok = await page.current.save();
    setSaving(false);
    // A failed save stays on the page, its error in the save bar
    const go = leaving;
    setLeaving(null);
    if (ok) go();
  }
  return (
    <UnsavedCtx.Provider value={page}>
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      {/* pt: it reaches the window's top (layout.tsx WholeWindow), clear of a phone's status bar / notch */}
      <SheetContent
        showCloseButton={false}
        aria-describedby={undefined}
        // ⌘S saves the page here (Settings, 流程, 记忆): Gerdr leaves keys named so to what has focus inside (its ⌘S is
        // "stash a draft", which took the key and stopped it before the page's save heard it)
        data-own-keys="meta+s ctrl+s"
        className="w-full gap-0 pt-[env(safe-area-inset-top)] sm:max-w-5xl">
        <SheetTitle className="sr-only">Superagent</SheetTitle>
      <header className="flex items-center gap-1 border-b px-3 py-2">
        {/* On a phone the tabs don't fit beside the name: the name goes and the tabs scroll sideways, each on one line */}
        <span className="mr-2 hidden shrink-0 text-[14px] font-medium sm:inline">Superagent</span>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => onTab(t.id)}
              className={clsx("flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px]", tab === t.id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60")}
            >
              <t.icon className="size-3.5" />
              {t.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" className="shrink-0" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "log" ? <Log onTask={onTask} /> : tab === "settings" ? <Settings onFlow={() => onTab("flow")} /> : tab === "letgo" ? <LetGo /> : tab === "flow" ? <Flow /> : tab === "memory" ? <Memory /> : tab === "schedules" ? <Schedules /> : <Triggers />}</div>
      </SheetContent>
    </Sheet>
    {leaving && (
      <Dialog open onOpenChange={(o) => !o && !saving && setLeaving(null)}>
        <DialogContent showCloseButton={false} aria-describedby={undefined} className="gap-3 p-5 sm:max-w-sm">
          <DialogTitle className="text-[15px] font-medium">有改动还没保存</DialogTitle>
          <p className="text-[13px] text-muted-foreground">离开前要保存吗？不保存的话，这次的改动就没了。</p>
          <DialogFooter className="mt-1">
            <Button variant="ghost" disabled={saving} onClick={() => setLeaving(null)}>
              继续改
            </Button>
            <Button variant="outline" disabled={saving} onClick={() => (setLeaving(null), leaving())}>
              不保存
            </Button>
            <Button autoFocus disabled={saving} onClick={() => void saveAndGo()}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
    </UnsavedCtx.Provider>
  );
}
