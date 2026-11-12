import { useCallback, useMemo, useRef, useState } from "react";
import { run } from "./gerdr";
import * as core from "@gerdr/core";
import { sessionsKey, usePanelChange, useRefresh, useSessions } from "./visible";

// Gerdr's toast (sonner), through the namespace so an older Gerdr without it still runs the board
const toast = (core as unknown as { toast?: ((m: string, o?: Record<string, unknown>) => unknown) & { error?: (m: string) => unknown } }).toast;

/** An artifact (产物): something a step produced, with when it came (older ones have no time). */
export type Link = { label: string; url: string; at?: number };
export type Live = { status: string; waiting?: string; waitingSince?: number; turnStartedAt?: number; updatedAt: number; error?: string; title?: string } | null;
/** A line in a requirement's activity feed (local/_store.ts). */
export type Activity = { at: number; by?: string; to?: string; kind: "progress" | "tell" | "join" | "done" | "review" | "user" | "stuck" | "wait" | "got" | "message" | "brief"; text: string; files?: { path: string; name?: string }[]; /** The step / question item whose answer this line records (local/_store.ts) */ of?: string };
export type Task = {
  id: string;
  title: string;
  owner: "agent" | "human";
  /** Work someone asked of the user (local/assign.ts): agree to it, reply to them, deliver. */
  assigned?: { state: "ask" | "agreed" | "delivered" | "done"; by?: string; how?: "agent" | "self"; agent?: string; repos?: string[]; share?: "" | "view" | "talk" };
  origin?: { source: string; key?: string; title?: string; url?: string };
  status: "todo" | "running" | "review" | "done" | "dropped";
  /** Images and files the user gave with it (local paths on Gerdr's machine). */
  attachments?: { path: string; name: string; mime?: string }[];
  routing?: number;
  /** The user asked the router to rearrange this card; set until it decides. */
  reroute?: { feedback: string; at: number; router?: string };
  router?: string;
  routerClosed?: boolean;
  prompt?: string;
  repo?: string;
  agent?: string;
  model?: string;
  effort?: string;
  mentions?: string[];
  origin?: { id: string; source: string; kind: string; key?: string; title?: string; url?: string; reply?: unknown };
  from?: string;
  worktree?: boolean;
  session?: string;
  sessions?: string[];
  blockedBy?: string[];
  question?: string;
  summary?: string;
  links?: Link[];
  steps?: string;
  handBack?: { kind: "none" | "value" | "secret" | "choice" | "questions"; name?: string; label?: string; options?: string[]; multi?: boolean };
  /** handBack "questions": several decisions / values asked at once, each answered on its own (local/_store.ts). */
  /** Everything it waits on now, of every kind (local/_waits.ts): where it stands follows from these; the 在等 view. */
  waits?: Wait[];
  /** Its worker stopped with nothing to wait on (tasks.ts list): under 等你, with what it last said. */
  stopped?: boolean;
  /** Why it stopped, in words (tasks.ts stopWhy): the user's stop, a restart, an error, or nothing said. */
  stopWhy?: string;
  /** Sessions its worker handed work to, still going: it waits on them. */
  helpers?: { id: string; title: string; status: string; waiting?: string; waitingKind?: "permission" | "ask"; /** waits on the user (an approval, or a question its worker left) */ left?: boolean }[];
  said?: string;
  nudges?: number;
  questions?: { id: string; title: string; kind: "choice" | "value"; options?: string[]; multi?: boolean; label?: string; steps?: string; answer?: string; dropped?: string; at?: number; skipped?: boolean; sent?: boolean }[];
  /** When the user asked its worker to bring this ask up to date (tasks.refreshAsk). */
  refreshing?: number;
  handedBack?: string;
  verify?: string;
  minutes?: number;
  urgent?: boolean;
  expiresAt?: number;
  askedBy?: string;
  notes?: { at: number; text: string }[];
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
  live: Live;
  column: "you" | "review" | "active" | "done";
  /** A member of a requirement, or a step its member asked the user for: folded into requirement `in`'s card. */
  in?: string;
  team?: string;
  /** A requirement with members: their ids (itself, the lead, first), its feed, and the column of the most pressing. */
  members?: string[];
  /** A requirement's words as first put (its lead's prompt may have been narrowed to its part since). */
  request?: string;
  activity?: Activity[];
  teamColumn?: "you" | "review" | "active" | "done";
  ready: boolean;
};

/**
 * The board, while the panel is on screen. tasks.list reads the tasks and reconciles them with their sessions, so it
 * runs again when either moves: the data files (written by functions: pushed) or one of the conversations the board
 * shows — workers and the helpers they handed work to (pushed too). A slow fallback catches what isn't pushed (a
 * file an agent edited directly); an older Gerdr pushes nothing, and the board polls every 5 s as it used to.
 */
export function useTasks() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState("");
  // One tasks.list at a time; a reload asked for meanwhile runs once more right after, and its caller waits for that
  // one. It used to be dropped: on a phone (each call a round trip through the relay) the reload after sending a
  // message hit the one still in flight and the message showed up only with the next 5 s poll (2026-11-06).
  const inflight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const reload = useCallback(() => {
    if (inflight.current) {
      again.current = true;
      return inflight.current;
    }
    const go = async () => {
      do {
        again.current = false;
        try {
          const r = await run<{ tasks: Task[] }>("tasks.list");
          setTasks(r.tasks);
          setError("");
        } catch (e: any) {
          setError(String(e.message || e));
        }
      } while (again.current);
    };
    inflight.current = go().finally(() => {
      inflight.current = null;
    });
    return inflight.current;
  }, []);
  const data = usePanelChange("user/data");
  const watched = useMemo(() => {
    const ids = new Set<string>();
    const taskIds = new Set<string>();
    for (const t of tasks ?? []) {
      if (t.status === "done" || t.status === "dropped") continue;
      taskIds.add(t.id);
      for (const id of [t.session, ...(t.sessions ?? []), ...(t.helpers ?? []).map((h) => h.id)]) if (id) ids.add(id);
    }
    return { ids, taskIds };
  }, [tasks]);
  // The board's workers and anyone working for them (as tasks.ts helpers() finds them): what they're doing now
  const sessions = useSessions(
    (x) =>
      watched.ids.has(x.id) ||
      (!!x.reportTo && watched.ids.has(x.reportTo)) ||
      (!!x.parent && watched.ids.has(x.parent)) ||
      (!!x.tags?.task && watched.taskIds.has(x.tags.task)),
  );
  useRefresh(reload, [data, sessionsKey(sessions)]);
  /** Runs a tasks.<fn> and refreshes the board after. 放弃 gets an undo in a toast: it's easy to click by mistake. */
  const act = useCallback(
    async (fn: string, input: unknown) => {
      const r = await run(`tasks.${fn}`, input);
      await reload();
      const id = (input as { id?: string } | null)?.id;
      if (fn === "drop" && id && toast)
        toast(`已放弃 ${id}`, {
          duration: 10000,
          action: {
            label: "撤销",
            onClick: () => void run("tasks.restore", { id }).then(reload, (e: any) => toast?.error?.(String(e?.message ?? e))),
          },
        });
      return r;
    },
    [reload],
  );
  return { tasks, error, reload, act };
}

export function since(ms?: number) {
  if (!ms) return "";
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天`;
}

/** "3 分钟前", or just "刚刚" (since() + "前" would read "刚刚前"). */
export function ago(ms?: number) {
  const s = since(ms);
  return s === "刚刚" || !s ? s : `${s}前`;
}

/**
 * Since when a card in 等你 has been waiting on the user: a human item since it was asked, an agent task since its
 * worker started waiting / stopped. The card shows this time and the column is sorted by it, so the two agree.
 */
export function waitedSince(t: Task) {
  if (t.owner === "human") return t.createdAt;
  const l = t.live;
  return (l?.status === "waiting" ? l.waitingSince : l?.updatedAt) ?? t.updatedAt;
}

export function day(ms: number) {
  return new Date(ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
}

/** One thing a task waits on (local/_waits.ts): what, whether it's the user, what wakes it (wake: in words). */
export type Wait = {
  id: string;
  kind: "reply" | "check" | "time" | "session" | "agent" | "user" | "task";
  what: string;
  since: number;
  user?: boolean;
  where?: string;
  at?: number;
  session?: string;
  /** agent: the subagent's toolCallId (its conversation) */
  sub?: string;
  item?: string;
  url?: string;
  woke?: { how: string; at: number };
  /** check: the command the worker wrote and its latest run */
  check?: { command: string; every: number; next: number; last?: { at: number; code: number; out: string } };
  wake?: string;
};
