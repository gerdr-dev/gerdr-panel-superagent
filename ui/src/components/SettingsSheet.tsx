import { ScrollText, Timer, X, Zap } from "lucide-react";
import clsx from "clsx";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import Flow from "../settings/Flow";
import Schedules from "../settings/Schedules";
import Triggers from "../settings/Triggers";
import { Button } from "./Button";

// The board's settings, in a shadcn Sheet over the board: how the user works (流程: their skill, with its variables) and what runs by
// itself (定时任务: mrwatch and the rest), and which outside events become tasks (触发器: local/inbox.ts). Not pages of their own: the panel is the board, these are its settings.

export type SettingsTab = "flow" | "schedules" | "triggers";

const TABS: { id: SettingsTab; label: string; icon: typeof Timer }[] = [
  { id: "flow", label: "流程", icon: ScrollText },
  { id: "schedules", label: "定时任务", icon: Timer },
  { id: "triggers", label: "触发器", icon: Zap },
];

export function SettingsSheet({ tab, onTab, onClose }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; onClose: () => void }) {
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent showCloseButton={false} aria-describedby={undefined} className="w-full gap-0 sm:max-w-5xl">
        <SheetTitle className="sr-only">看板设置</SheetTitle>
      <header className="flex items-center gap-1 border-b px-3 py-2">
        <span className="mr-2 text-[14px] font-medium">看板设置</span>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            className={clsx("flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px]", tab === t.id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60")}
          >
            <t.icon className="size-3.5" />
            {t.label}
          </button>
        ))}
        <Button variant="ghost" size="icon" className="ml-auto" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "flow" ? <Flow /> : tab === "schedules" ? <Schedules /> : <Triggers />}</div>
      </SheetContent>
    </Sheet>
  );
}
