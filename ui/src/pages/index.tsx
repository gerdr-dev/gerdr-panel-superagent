import { Inbox, Settings } from "lucide-react";
import clsx from "clsx";
import { SessionChat } from "@gerdr/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../components/Button";
import { ChatDrawer } from "../components/ChatDrawer";
import { SettingsSheet, TABS, type SettingsTab } from "../components/SettingsSheet";
import { Views } from "../components/Views";
import { run } from "../lib/gerdr";
import { Linger } from "../lib/linger";
import { phoneMenu, usePhoneMenu } from "../lib/phoneMenu";
import { useTasks } from "../lib/tasks";
import { isRecord, needsIn, setOpenChat, type Need } from "./board";
import { usePanelChange } from "../lib/visible";

// The secretary (DESIGN.md「秘书」): its own conversation, the whole page. The user types to it here, reads its
// replies, and sees what the board sent it (tasks to route, outside messages, checks, a worker's answer), marked as
// such. Until 2026-11-12 the page drew its own feed from the messages the secretary sent with a tool, and its
// session was a drawer behind a face: two places for one conversation. Above the chat: what waits on the user, a
// chip each, opening the task on the board.

export default function SecretaryPage() {
  const { tasks } = useTasks();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  // Rows shared with the board open conversations through this
  useEffect(() => setOpenChat((session) => setPeek(session)), []);
  usePhoneMenu(TABS.map((x) => ({ id: x.id, label: x.label, icon: <x.icon className="size-4" />, onSelect: () => setSettings(x.id) })));
  const { main, error } = useMain();
  const needs = useMemo(() => needsIn(tasks ?? [], 0).filter((x) => !isRecord(x)), [tasks]);
  const toTask = useCallback((id: string) => navigate(`/board?open=${id}`), [navigate]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-2.5 max-md:px-3">
        <Views />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className={clsx(phoneMenu && "max-md:hidden")} title="外面来的每条消息去了哪：交给了哪个任务、为什么没接" onClick={() => setSettings("log")}>
            <Inbox className="size-4" />
            <span className="max-md:hidden">去向</span>
          </Button>
          <Button variant="ghost" size="icon" className={clsx(phoneMenu && "max-md:hidden")} aria-label="设置" title="设置、流程、触发器、定时任务（简报的时间在这里改）" onClick={() => setSettings("settings")}>
            <Settings className="size-4" />
          </Button>
        </div>
      </header>
      <Waiting needs={needs} onTask={toTask} />
      {error && <p role="alert" className="px-4 pt-3 text-[13px] text-bad">秘书没开起来：{error}</p>}
      <div className="min-h-0 flex-1">
        {main ? <SessionChat id={main} focused /> : !error && <p className="p-8 text-center text-[13px] text-muted-foreground">正在打开秘书…</p>}
      </div>
      <Linger>{peek && <ChatDrawer session={peek} onClose={() => setPeek(null)} />}</Linger>
      <Linger>{settings && <SettingsSheet tab={settings} onTab={setSettings} onClose={() => setSettings(null)} onTask={(id) => (setSettings(null), toTask(id))} />}</Linger>
    </div>
  );
}

/**
 * The secretary's session id: opened if there's none yet, and looked up again when the panel's data changes (a new
 * one replaced it: 设置 changed who runs it, or it broke; the new one carries the conversation on).
 */
function useMain() {
  const [main, setMain] = useState<string>();
  const [error, setError] = useState("");
  const data = usePanelChange("user/data");
  useEffect(() => {
    run<{ main: string }>("secretary.open", {}).then(
      (r) => (setMain(r.main), setError("")),
      (e: any) => setError(String(e?.message ?? e)),
    );
  }, [data]);
  return { main, error };
}

/** What waits on the user, one chip each: opens that task on the board, where it's answered. Nothing when nothing waits. */
function Waiting({ needs, onTask }: { needs: Need[]; onTask: (id: string) => void }) {
  if (!needs.length) return null;
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b bg-warn/5 px-4 py-2 text-[12px]">
      <span className="shrink-0 font-medium text-warn">等你 {needs.length}</span>
      {needs.map((x) => {
        const t = x.type === "ask" ? x.h : x.m;
        return (
          <button key={x.key} className="max-w-64 shrink-0 truncate rounded-full border bg-background px-2.5 py-0.5 hover:border-brand" title={t.title} onClick={() => onTask(t.id)}>
            {t.id} {t.title}
          </button>
        );
      })}
    </div>
  );
}
