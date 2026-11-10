import { ChevronRight, Hand, Inbox, Settings } from "lucide-react";
import clsx from "clsx";
import * as core from "@gerdr/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../components/Button";
import { ChatDrawer } from "../components/ChatDrawer";
import { SettingsSheet, TABS, type SettingsTab } from "../components/SettingsSheet";
import { Views } from "../components/Views";
import { project, run } from "../lib/gerdr";
import { Linger } from "../lib/linger";
import { phoneMenu, usePhoneMenu } from "../lib/phoneMenu";
import { useTasks, waitedSince, type Task } from "../lib/tasks";
import { askedAt, LineRow, NeedRow, setOpenChat, WorkingRow, type FeedItem as NeedItem } from "./board";
import { sessionsKey, usePanelChange, useRefresh, useSessions } from "../lib/visible";

// The secretary (DESIGN.md「秘书」): one conversation in the middle of the page, where the user hands everything over
// and asks how things stand. It is a feed like a requirement's (DESIGN.md「一个架构」): the same lines (local/_log.ts,
// the secretary's messages by "secretary") drawn by the same rows (board.tsx LineRow, NeedRow, WorkingRow), across
// every session the secretary has been, with what waits on the user from every task among them. Less than a
// requirement's: no lines between members; more: the outside messages it handled, folded to a line.

type File = { path: string; name?: string; mime?: string };
/** A line of the secretary's page: a feed line (Activity) with an id and the session it was said in. */
type Entry = { id: string; at: number; kind: "user" | "message" | "brief"; by?: string; text: string; files?: File[]; session?: string };
type Note = { id: string; at: number; who: "note"; text: string; state: string; tasks?: string[] };
type Main = { id: string; status: string; waiting?: string; waitingKind?: string; error?: string; turnStartedAt?: number };
type Feed = { entries: (Entry | Note)[]; main: Main | null; busy: boolean };

type FeedEntry = { key: string; at: number; user?: { text: string; files?: File[] } };
type Need = Exclude<NeedItem, { type: "act" }>;
type Row = FeedEntry & ({ type: "need"; x: Need } | { type: "line"; e: Entry } | { type: "notes"; notes: Note[] } | { type: "busy"; m: Main } | { type: "waiting"; m: Main } | { type: "hello" });

// Gerdr's FeedChat, through the namespace: a Gerdr from before it says so instead of breaking
const FeedChat = (core as unknown as {
  FeedChat?: <E extends FeedEntry>(p: { id: string; entries: E[]; render: (e: E) => React.ReactNode; onSend: (m: { text: string; files: File[] }) => Promise<void>; placeholder?: string; jump?: { key: string; seq: number }; className?: string }) => React.ReactNode;
}).FeedChat;

function time(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? "" : `${d.getMonth() + 1}月${d.getDate()}日 `}${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The conversation, kept current: the log changes through functions (pushed), the secretary's state live. */
function useFeed() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(
    () =>
      run<Feed>("secretary.feed", {}).then(
        (r) => (setFeed(r), setError("")),
        (e: any) => setError(String(e?.message ?? e)),
      ),
    [],
  );
  const data = usePanelChange("user/data");
  const id = feed?.main?.id;
  const main = useSessions((s) => !!id && s.id === id);
  useRefresh(reload, [data, sessionsKey(main)], { fallback: 30_000, poll: 3000 });
  // Its status as Gerdr pushes it now, over what the last feed said
  const live = main[0];
  const m: Main | null = feed?.main && live ? { ...feed.main, status: live.status, waiting: live.waiting, waitingKind: live.waitingKind, turnStartedAt: live.turnStartedAt as number | undefined } : (feed?.main ?? null);
  return { feed, main: m, error, reload };
}

export default function SecretaryPage() {
  const { feed, main, error, reload } = useFeed();
  const { tasks, act } = useTasks();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  // The rows shared with the board (NeedRow) open conversations through this
  useEffect(() => setOpenChat((session) => setPeek(session)), []);
  const [jump, setJump] = useState<{ key: string; seq: number }>();
  usePhoneMenu(TABS.map((x) => ({ id: x.id, label: x.label, icon: <x.icon className="size-4" />, onSelect: () => setSettings(x.id) })));

  const byId = useMemo(() => Object.fromEntries((tasks ?? []).map((t) => [t.id, t])), [tasks]);
  // Only from where the conversation shown starts: older answered steps belong to before it
  const from = feed?.entries[0]?.at ?? Infinity;
  const needs = useMemo(() => needsOf(tasks, from), [tasks, from]);
  const rows = useMemo(() => toRows(feed, main, needs), [feed, main, needs]);
  const send = useCallback(
    async (m: { text: string; files: File[] }) => {
      await run("secretary.say", { text: m.text, files: m.files });
      await reload();
    },
    [reload],
  );
  const toTask = useCallback((id: string) => navigate(`/board?open=${id}`), [navigate]);
  // Each row padded as a requirement's feed pads its rows
  const render = useCallback(
    (r: Row) => <div className="px-1 py-1.5">{rowOf(r)}</div>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toTask, byId, act],
  );
  const rowOf = (r: Row) =>
      r.type === "need" ? (
        <NeedRow x={r.x} activity={[]} byId={byId} act={act} onGo={toTask} nobody={{ name: "秘书", face: <Face onPeek={setPeek} /> }} />
      ) : r.type === "line" ? (
        <LineRow a={r.e} activity={[]} byId={byId} speaker={{ id: "secretary", name: "秘书", face: <Face session={r.e.session} onPeek={setPeek} /> }} />
      ) : r.type === "busy" ? (
        <WorkingRow items={[{ key: "secretary", face: <Face session={r.m.id} onPeek={setPeek} small />, name: "秘书", since: r.m.turnStartedAt }]} />
      ) : (
        <RowView r={r} onPeek={setPeek} onTask={toTask} />
      );

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
      <Waiting needs={needs.filter((x) => x.type !== "ask" || (x.h.status !== "done" && x.h.status !== "dropped"))} onJump={(key) => setJump((j) => ({ key, seq: (j?.seq ?? 0) + 1 }))} />
      {error && <p role="alert" className="px-4 pt-3 text-[13px] text-bad">读取失败：{error}</p>}
      {/* Full width, so the whole page scrolls the conversation and its scrollbar sits at the right edge; the chat
          itself keeps the text in a centred column (800px, like every Gerdr chat) */}
      <div className="min-h-0 flex-1">
        <div className="h-full w-full">
          {!FeedChat ? (
            <p className="p-8 text-center text-[13px] text-muted-foreground">这个 Gerdr 太旧，画不了秘书的对话：升级 Gerdr，或先用「看板」。</p>
          ) : !feed ? (
            !error && <p className="p-8 text-center text-[13px] text-muted-foreground">正在加载…</p>
          ) : (
            <FeedChat id={`${project}.secretary`} entries={rows} render={render} onSend={send} jump={jump} placeholder="什么事都可以交给秘书，也可以问它进度" />
          )}
        </div>
      </div>
      <Linger>{peek && <ChatDrawer session={peek} label="秘书的会话：它查了什么、调了哪些命令。在这里说的话它也听得到，但不会记进秘书页的对话" onClose={() => setPeek(null)} />}</Linger>
      <Linger>{settings && <SettingsSheet tab={settings} onTab={setSettings} onClose={() => setSettings(null)} onTask={(id) => (setSettings(null), toTask(id))} />}</Linger>
    </div>
  );
}

/**
 * The rows: messages as they are, runs of outside messages it handled folded into one line, and at the end what the
 * secretary is doing now (busy, or waiting for an approval). An empty conversation gets a line on what it's for.
 */
/**
 * What waits on the user across the board, as a requirement's feed has it (board.tsx teamNeeds): the steps and
 * decisions workers asked, and workers stuck on the user.
 */
function needsOf(tasks: Task[] | null, from: number): Need[] {
  const live = (tasks ?? []).filter((t) => t.status !== "done" && t.status !== "dropped");
  // What was asked here and is answered (or taken back) now: kept where it was asked, as its record (NeedRow)
  const over = (tasks ?? []).filter((t) => t.owner === "human" && (t.status === "done" || t.status === "dropped") && askedAt(t) >= from);
  return [
    ...live.filter((t) => t.owner === "human" && t.ready).map((h): Need => ({ at: askedAt(h), key: `h${h.id}`, type: "ask", h })),
    ...over.map((h): Need => ({ at: askedAt(h), key: `h${h.id}`, type: "ask", h })),
    ...live.filter((t) => t.owner === "agent" && t.column === "you").map((m): Need => ({ at: waitedSince(m), key: `s${m.id}`, type: "stuck", m })),
  ];
}

function toRows(feed: Feed | null, main: Main | null, needs: Need[]): Row[] {
  const out: Row[] = [];
  for (const e of feed?.entries ?? []) {
    if (e.who === "note") {
      const last = out[out.length - 1];
      if (last?.type === "notes") last.notes.push(e);
      else out.push({ key: `n-${e.id}`, at: e.at, type: "notes", notes: [e] });
      continue;
    }
    // The user's own: FeedChat draws it as their message (`user`), as in a requirement's feed
    out.push(e.kind === "user" ? { key: e.id, at: e.at, user: { text: e.text, files: e.files }, type: "line", e } : { key: e.id, at: e.at, type: "line", e });
  }
  // What waits on the user, where it was asked among the messages (FeedChat keeps rows in the order given)
  for (const x of needs) {
    const i = out.findIndex((r) => r.at > x.at);
    const row: Row = { key: x.key, at: x.at, type: "need", x };
    if (i < 0) out.push(row);
    else out.splice(i, 0, row);
  }
  if (!out.length) out.push({ key: "hello", at: 0, type: "hello" });
  if (main?.status === "waiting") out.push({ key: "waiting", at: Date.now(), type: "waiting", m: main });
  else if (feed?.busy && main && main.status !== "error") out.push({ key: "busy", at: Date.now(), type: "busy", m: main });
  return out;
}

/**
 * The secretary's face beside what it says and while it works, like a member's in a requirement's feed: a tap opens
 * its conversation (what it looked up, the commands it ran). Without a session (an old entry) it's just a face.
 */
function Face({ session, onPeek, small }: { session?: string; onPeek: (id: string) => void; small?: boolean }) {
  const face = <span className={clsx("grid shrink-0 place-items-center rounded-full bg-brand/15 font-medium text-brand ring-1 ring-brand/40", small ? "size-6 text-[10px]" : "size-8 text-[11px]")}>秘</span>;
  if (!session) return face;
  return (
    <button title="打开秘书的对话：它查了什么、调了哪些命令" aria-label="打开秘书的对话" onClick={() => onPeek(session)} className="shrink-0 rounded-full hover:opacity-80">
      {face}
    </button>
  );
}

function RowView({ r, onPeek, onTask }: { r: Row; onPeek: (id: string) => void; onTask: (id: string) => void }) {
  if (r.type === "hello")
    return (
      <div className="py-10 text-center text-[13px] leading-relaxed text-muted-foreground">
        <p className="text-[15px] font-medium text-foreground">我是你的秘书</p>
        <p className="mt-2">什么事都可以交给我：我派给合适的 agent 去做，替你记着、跟着。</p>
        <p>要你拍板的我会来问你；进度、日报随时问我，到点我也会给你写简报。</p>
      </div>
    );
  if (r.type === "waiting")
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px]">
        <Hand className="size-4 shrink-0 text-warn" />
        <span className="min-w-0 flex-1">秘书在等你{r.m.waitingKind === "ask" ? "回答" : "批准"}：{r.m.waiting ?? ""}</span>
        <Button variant="outline" size="sm" onClick={() => onPeek(r.m.id)}>
          去处理
        </Button>
      </div>
    );
  if (r.type === "notes")
    return (
      <details className="group py-1 text-[12px] text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground">
          <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
          {r.notes.length === 1 ? r.notes[0].text : `处理了 ${r.notes.length} 条外面来的消息`}
        </summary>
        <ul className="mt-1 space-y-0.5 pl-4">
          {r.notes.map((n) => (
            <li key={n.id}>
              {time(n.at)} {r.notes.length > 1 && n.text}
              {n.tasks?.map((id) => (
                <button key={id} className="ml-1 text-brand hover:underline" onClick={() => onTask(id)}>
                  看 {id}
                </button>
              ))}
            </li>
          ))}
        </ul>
      </details>
    );
  return null;
}

/** What waits on the user, one chip each: scrolls the conversation to it (it's a card there). Nothing when nothing waits. */
function Waiting({ needs, onJump }: { needs: Need[]; onJump: (key: string) => void }) {
  if (!needs.length) return null;
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b bg-warn/5 px-4 py-2 text-[12px]">
      <span className="shrink-0 font-medium text-warn">等你 {needs.length}</span>
      {needs.map((x) => {
        const t = x.type === "ask" ? x.h : x.m;
        return (
          <button key={x.key} className="max-w-64 shrink-0 truncate rounded-full border bg-background px-2.5 py-0.5 hover:border-brand" title={t.title} onClick={() => onJump(x.key)}>
            {t.id} {t.title}
          </button>
        );
      })}
    </div>
  );
}
