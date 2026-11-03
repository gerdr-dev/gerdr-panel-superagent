import { ScrollText, Timer, X } from "lucide-react";
import clsx from "clsx";
import { useEffect } from "react";
import Flow from "../settings/Flow";
import Schedules from "../settings/Schedules";
import { Button } from "./Button";

// The board's settings, over the board: how the user works (流程: their skill, with its variables) and what runs by
// itself (定时任务: mrwatch and the rest). Not pages of their own: the panel is the board, these are its settings.

export type SettingsTab = "flow" | "schedules";

const TABS: { id: SettingsTab; label: string; icon: typeof Timer }[] = [
  { id: "flow", label: "流程", icon: ScrollText },
  { id: "schedules", label: "定时任务", icon: Timer },
];

export function SettingsSheet({ tab, onTab, onClose }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; onClose: () => void }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[role=dialog]")) onClose();
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-background">
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
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "flow" ? <Flow /> : <Schedules />}</div>
    </div>
  );
}
