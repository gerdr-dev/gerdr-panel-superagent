import { Inbox, ScrollText, SlidersHorizontal, Timer, X, Zap } from "lucide-react";
import clsx from "clsx";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import Flow from "../settings/Flow";
import Settings from "../settings/Settings";
import Schedules from "../settings/Schedules";
import Triggers from "../settings/Triggers";
import Log from "../settings/Log";
import { Button } from "./Button";

// Everything behind the board, in a shadcn Sheet over it: where each outside message went (去向: the Superagent's
// log, local/superagent.ts), the values the code acts on (设置: who routes and works, repositories, merging, proactive
// work; local/settings.ts), how the user wants things done (流程: their skill, prose the agents read), which outside
// events come in (触发器: local/inbox.ts) and what runs by itself (定时任务: mrwatch and the rest). Not pages of their own: the panel
// is the board, these are what's behind it.

export type SettingsTab = "log" | "settings" | "flow" | "schedules" | "triggers";

export const TABS: { id: SettingsTab; label: string; icon: typeof Timer }[] = [
  { id: "log", label: "去向", icon: Inbox },
  { id: "settings", label: "设置", icon: SlidersHorizontal },
  { id: "flow", label: "流程", icon: ScrollText },
  { id: "triggers", label: "触发器", icon: Zap },
  { id: "schedules", label: "定时任务", icon: Timer },
];

export function SettingsSheet({ tab, onTab, onClose, onTask }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; onClose: () => void; onTask: (id: string) => void }) {
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent showCloseButton={false} aria-describedby={undefined} className="w-full gap-0 sm:max-w-5xl">
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
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "log" ? <Log onTask={onTask} /> : tab === "settings" ? <Settings onFlow={() => onTab("flow")} /> : tab === "flow" ? <Flow /> : tab === "schedules" ? <Schedules /> : <Triggers />}</div>
      </SheetContent>
    </Sheet>
  );
}
