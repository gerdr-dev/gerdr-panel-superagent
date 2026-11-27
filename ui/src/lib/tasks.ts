import { useEffect, useMemo, useRef, useState } from "react";
import { project, run } from "./gerdr";
import * as core from "@gerdr/core";
import { usePanelVisible, useSessions, type CoreSession } from "./visible";
import { fileCardStates } from "./cardstates";

// Gerdr's toast (sonner), through the namespace so an older Gerdr without it still runs the board
const toast = (core as unknown as { toast?: ((m: string, o?: Record<string, unknown>) => unknown) & { error?: (m: string) => unknown } }).toast;

/** An artifact (产物): something a step produced, with when it came (older ones have no time). */
export type Link = { label: string; url: string; at?: number };
export type Live = { status: string; waiting?: string; waitingSince?: number; turnStartedAt?: number; updatedAt: number; error?: string; title?: string } | null;
/** A line in a requirement's activity feed (local/_store.ts). */
export type Activity = { at: number; by?: string; to?: string; kind: "progress" | "tell" | "join" | "done" | "review" | "user" | "stuck" | "wait" | "got" | "message" | "brief"; text: string; files?: { path: string; name?: string }[]; /** The ask (or one of its questions) whose answer this line records (local/_store.ts) */ of?: string };
/** One of several questions in an ask (handBack "questions"), each answered on its own (local/_store.ts). */
export type Question = { id: string; title: string; kind: "choice" | "value"; options?: string[]; multi?: boolean; label?: string; steps?: string; answer?: string; dropped?: string; at?: number; skipped?: boolean; sent?: boolean };

/**
 * Something a task's worker needs from the user (ask_human): a step only they can do, a decision, a value, several
 * questions. Kept on the task that asked (local/_store.ts Ask): there are no tasks for people (2026-11-19).
 */
export type Ask = {
  id: string;
  /** The human task it was before 2026-11-19 (t206). */
  was?: string;
  title: string;
  status: "open" | "done" | "dropped";
  steps?: string;
  handBack: { kind: "none" | "value" | "secret" | "choice" | "questions"; name?: string; label?: string; options?: string[]; multi?: boolean };
  questions?: Question[];
  verify?: string;
  minutes?: number;
  urgent?: boolean;
  expiresAt?: number;
  handedBack?: string;
  dropReason?: string;
  /** When the user asked its worker to bring it up to date (tasks.refreshAsk). */
  refreshing?: number;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
};

/** What t still asks the user. */
export function openAsks(t: Task): Ask[] {
  return (t.asks ?? []).filter((a) => a.status === "open");
}

/** An ask by its id (or a human task's old id) and the task that asked it. */
export function findAsk(tasks: Task[] | undefined, id: string): { t: Task; a: Ask } | undefined {
  for (const t of tasks ?? []) for (const a of t.asks ?? []) if (a.id === id || a.was === id) return { t, a };
  return undefined;
}

export type Task = {
  id: string;
  title: string;
  /** Work someone asked of the user (local/assign.ts): agree to it, reply to them, deliver. */
  assigned?: { state: "ask" | "agreed" | "delivered" | "done"; by?: string; how?: "agent" | "self"; agent?: string; repos?: string[]; share?: "" | "view" | "talk"; draft?: string; shareDir?: string; unattended?: boolean };
  /** 设置 → 回复对方 is 派出去时 and it's still in 待办: the card's 回复对方 box, and what it starts with (local/tasks.ts list). */
  canReply?: boolean;
  replyDraft?: string;
  /** The user's 备注 on a card from outside, sent to the worker after the message (local/_store.ts). */
  remark?: string;
  /** What its worker wrote to a chat, held for the user to send or not (local/outbox.ts). */
  outbox?: { id: string; text: string; where: string; at: number; state: "pending" | "sent" | "skipped" | "withdrawn"; doneAt?: number; edited?: boolean; reason?: string }[];
  status: "todo" | "running" | "review" | "done" | "dropped";
  droppedFrom?: Task["status"];
  /** Images and files the user gave with it (local paths on Gerdr's machine). */
  attachments?: { path: string; name: string; mime?: string }[];
  routing?: number;
  /** The user asked the router to rearrange this card; set until it decides. */
  reroute?: { feedback: string; at: number; router?: string; was?: string };
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
  summary?: string;
  links?: Link[];
  /** What its worker asks of the user (ask_human), open and answered. */
  asks?: Ask[];
  /** Everything it waits on now, of every kind (local/_waits.ts): where it stands follows from these; the 在等 view. */
  waits?: Wait[];
  /** Its worker stopped with nothing to wait on (tasks.ts list): under 等你, with what it last said. */
  stopped?: boolean;
  /** Why it stopped, in words (tasks.ts stopWhy): the user's stop, a restart, an error, or nothing said. */
  stopWhy?: string;
  /** Sessions its worker handed work to, still going: it waits on them. */
  helpers?: { id: string; title: string; status: string; waiting?: string; waitingKind?: "permission" | "ask"; /** waits on the user (an approval, or a question its worker left) */ left?: boolean }[];
  said?: string;
  /** The newest paragraph in its worker's conversation, read live (local/tasks.ts newest): the card's line. */
  latest?: string;
  nudges?: number;
  notes?: { at: number; text: string }[];
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
  live: Live;
  column: "you" | "review" | "active" | "done";
  /** A member of a requirement: folded into requirement `in`'s card. */
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

// Same data flow as Code's sessions: load a snapshot, then replace the parts changed by Gerdr's WebSocket.
const onPanelFiles = (core as unknown as { onPanelFiles?: (panel: string, fn: (path: string | null) => void) => () => void }).onPanelFiles;
const reqPath = "user/data/reqs/";
type Row = Omit<Task, "ready"> & { cards?: Record<string, unknown>; activityAt: number; userActivityAt: number; answeredAt: number };
type Parts = Record<string, Row[]>;
type Helper = Pick<CoreSession, "id" | "title" | "status" | "waiting" | "waitingKind" | "waitingSince" | "reportTo" | "parent" | "tags">;
type TaskView = { parts: Parts; project: string };
type Move = { status: Task["status"]; at: number; writtenAt?: number };
let lastParts: Parts | null = null;

function reflectsWrite(row: Row | undefined, move: Move) {
  return !!row && (row.status === move.status || (move.writtenAt !== undefined && row.updatedAt >= move.writtenAt));
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("读任务列表超时")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

// Relations are calculated over the records already in memory. Moving one blocker or teammate updates its
// neighbours too, without asking the server to read their files again.
function taskRows(parts: Parts, moves: ReadonlyMap<string, Move>): Task[] {
  const rows = Object.values(parts).flat().map((row) => {
    const move = moves.get(row.id);
    if (!move) return row;
    const status = move.status;
    const column = status === "review" ? "review" : status === "done" || status === "dropped" ? "done" : row.column === "you" ? "you" : "active";
    const doneAt = status === "done" || status === "dropped" ? move.at : undefined;
    const droppedFrom = status === "dropped" ? row.droppedFrom ?? row.status : undefined;
    return { ...row, status, column, doneAt, droppedFrom, updatedAt: move.at } as Row;
  });
  const byId = new Map(rows.map((t) => [t.id, t]));
  const teams = new Map<string, Row[]>();
  for (const t of rows) {
    if (!t.team || !byId.has(t.team)) continue;
    const team = teams.get(t.team) ?? [];
    team.push(t);
    teams.set(t.team, team);
  }
  return rows.map((t) => {
    const root = t.team ? byId.get(t.team) : undefined;
    const lead = root ?? t;
    const team = teams.get(lead.id) ?? [];
    const ready = (t.blockedBy ?? []).every((id) => {
      const other = byId.get(id);
      return !other || other.status === "done" || other.status === "dropped";
    });
    const userAt = Math.max(lead.userActivityAt, ...team.map((m) => m.userActivityAt));
    const stopWhy = t.stopWhy === "停下了" && t.answeredAt && t.answeredAt >= userAt ? "回了你的话，等你接着说" : t.stopWhy;
    if (root) return { ...t, ready, stopWhy, in: root.id };
    const teamColumn = t.column === "active" && team.some((m) => m.column === "you") ? "you" : t.column;
    const updatedAt = Math.max(t.updatedAt, t.activityAt, ...team.map((m) => Math.max(m.updatedAt, m.activityAt)));
    return { ...t, ready, stopWhy, updatedAt, teamColumn, members: [t.id, ...team.map((m) => m.id)] };
  });
}

export function useTasks() {
  const [parts, setParts] = useState<Parts | null>(lastParts);
  const [moves, setMoves] = useState(new Map<string, Move>());
  const tasks = useMemo(() => parts && taskRows(parts, moves), [parts, moves]);
  const visible = usePanelVisible();
  const currentTasks = useRef(tasks);
  currentTasks.current = tasks;
  const currentParts = useRef(parts);
  currentParts.current = parts;
  const request = useRef<(files?: string[]) => void>(() => {});
  const helpersByPart = useRef(new Map<string, Helper[]>());

  useEffect(() => {
    lastParts = parts;
  }, [parts]);

  useEffect(() => {
    if (!moves.size) return;
    const deadline = Math.min(...[...moves.values()].map((move) => move.at)) + 15_000;
    const timer = setTimeout(() => setMoves((pending) =>
      new Map([...pending].filter(([, move]) => Date.now() - move.at < 15_000))),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [moves]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let full = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dirty = new Set<string>();

    const schedule = (delay = 30) => {
      if (busy || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, delay);
    };
    const read = async () => {
      if (!full && !dirty.size) return;
      const snapshot = full;
      const files = [...dirty];
      const helpers = [...new Map(files.flatMap((file) => helpersByPart.current.get(file) ?? []).map((helper) => [helper.id, helper])).values()];
      full = false;
      dirty.clear();
      busy = true;
      try {
        const r = await withDeadline(run<TaskView>("tasks.view", snapshot ? {} : { parts: files, helpers }), 30_000);
        if (!alive) return;
        const rows = Object.values(r.parts).flat();
        fileCardStates(r.project, rows);
        setParts((previous) => {
          const next: Parts = snapshot ? {} : { ...previous };
          for (const [file, entries] of Object.entries(r.parts)) {
            if (entries.length) next[file] = entries;
            else delete next[file];
          }
          return next;
        });
        const byId = new Map(rows.map((t) => [t.id, t]));
        setMoves((pending) => {
          const next = new Map(pending);
          for (const [id, move] of pending) {
            if (reflectsWrite(byId.get(id), move) || (snapshot && !byId.has(id))) next.delete(id);
          }
          return next.size === pending.size ? pending : next;
        });
      } catch {
        if (alive) {
          // Take a fresh snapshot after a failed read: a following delta might otherwise miss a moved part.
          full = true;
          busy = false;
          schedule(3000);
        }
      } finally {
        busy = false;
        if (alive && (full || dirty.size)) schedule();
      }
    };

    const enqueue = (files?: string[]) => {
      if (files) for (const file of files) dirty.add(file);
      else full = true;
      schedule();
    };
    request.current = enqueue;
    const stop = onPanelFiles?.(project, (path) => {
      if (path === null || path === "user/settings.json" || path === reqPath.slice(0, -1)) enqueue();
      else if (path.startsWith(reqPath) && path.endsWith(".json")) enqueue([path]);
    });
    enqueue();
    const fallback = onPanelFiles ? undefined : setInterval(() => enqueue(), 5000);
    return () => {
      alive = false;
      stop?.();
      clearTimeout(timer);
      clearInterval(fallback);
      request.current = () => {};
    };
  }, [visible]);

  // Code already receives live summaries. Use them to identify only the task files whose worker or helper changed.
  const index = useMemo(() => {
    const byId = new Map<string, string>();
    const bySession = new Map<string, string>();
    for (const [file, rows] of Object.entries(parts ?? {})) for (const t of rows) {
      byId.set(t.id, file);
      for (const id of [t.session, ...(t.sessions ?? []), t.router, t.reroute?.router]) if (id) bySession.set(id, file);
    }
    return { byId, bySession };
  }, [parts]);
  const sessions = useSessions((x) => index.bySession.has(x.id) ||
    (!!x.reportTo && index.bySession.has(x.reportTo)) ||
    (!!x.parent && index.bySession.has(x.parent)) ||
    (!!x.tags?.task && (!x.tags.panel || x.tags.panel === project) && index.byId.has(x.tags.task)));

  const previousSessions = useRef(new Map<string, { key: string; files: string[] }>());
  useEffect(() => {
    const before = previousSessions.current;
    const current = new Map<string, { key: string; files: string[] }>();
    const changed = new Set<string>();
    const helpers = new Map<string, Helper[]>();
    for (const s of sessions) {
      const files = [index.bySession.get(s.id), s.reportTo && index.bySession.get(s.reportTo), s.parent && index.bySession.get(s.parent),
        s.tags?.task && (!s.tags.panel || s.tags.panel === project) && index.byId.get(s.tags.task)].filter((f): f is string => !!f);
      if (s.status === "running" || s.status === "starting" || s.status === "waiting") {
        const { id, title, status, waiting, waitingKind, waitingSince, reportTo, parent, tags } = s;
        const helper = { id, title, status, waiting, waitingKind, waitingSince, reportTo, parent, tags };
        for (const file of new Set(files)) {
          if (file === index.bySession.get(s.id)) continue;
          const list = helpers.get(file) ?? [];
          list.push(helper);
          helpers.set(file, list);
        }
      }
      const key = JSON.stringify([s.status, s.title, s.waiting, s.waitingKind, s.pending, s.reportTo, s.parent, s.tags?.task]);
      const old = before.get(s.id);
      if (!old || old.key !== key) for (const file of [...(old?.files ?? []), ...files]) changed.add(file);
      current.set(s.id, { key, files });
    }
    for (const [id, old] of before) if (!current.has(id)) for (const file of old.files) changed.add(file);
    previousSessions.current = current;
    helpersByPart.current = helpers;
    if (visible && changed.size) request.current([...changed]);
  }, [sessions, index, visible]);

  // Streaming text doesn't affect buckets. Only its last line is refreshed while the worker is writing.
  const partIndex = useRef(index.byId);
  partIndex.current = index.byId;
  const running = new Set(sessions.filter((s) => s.status === "running").map((s) => s.id));
  const runningKey = (tasks ?? []).filter((t) => t.session && running.has(t.session)).map((t) => t.id).join(",");
  useEffect(() => {
    if (!runningKey || !visible) return;
    const ids = runningKey.split(",");
    const timer = setInterval(() => {
      const parts = Object.fromEntries(ids.map((id) => [id, partIndex.current.get(id)]));
      run<Record<string, string>>("tasks.lines", { ids, parts }).then((lines) => setParts((current) => {
        if (!current) return current;
        let next = current;
        for (const [file, rows] of Object.entries(current)) {
          if (!rows.some((t) => t.id in lines && t.latest !== (lines[t.id] || undefined))) continue;
          if (next === current) next = { ...current };
          next[file] = rows.map((t) => t.id in lines ? { ...t, latest: lines[t.id] || undefined } : t);
        }
        return next;
      }), () => {});
    }, 10_000);
    return () => clearInterval(timer);
  }, [runningKey, visible]);

  const act = async (fn: string, input: unknown): Promise<unknown> => {
    const id = (input as { id?: string } | null)?.id;
    const task = id ? currentTasks.current?.find((t) => t.id === id) : undefined;
    const status = fn === "setStatus" ? (input as { status: Task["status"] }).status :
      fn === "drop" ? "dropped" : fn === "accept" ? "done" :
      fn === "restore" ? task?.droppedFrom : undefined;
    // A 待办 dispatched through setStatus acquires its worker on the server. Wait for that record to arrive.
    const move: Move | undefined = status && task && task.status !== status && !(task.status === "todo" && status === "running")
      ? { status, at: Date.now() } : undefined;
    if (id && move) setMoves((pending) => new Map(pending).set(id, move));
    let result: unknown;
    try {
      result = await run(`tasks.${fn}`, input);
    } catch (err) {
      if (id && move) setMoves((pending) => {
        if (pending.get(id) !== move) return pending;
        const next = new Map(pending);
        next.delete(id);
        return next;
      });
      throw err;
    } finally {
      if (!onPanelFiles) request.current();
    }
    const saved = result as { updatedAt?: number } | undefined;
    if (id && move && saved?.updatedAt !== undefined) {
      const ack = { ...move, writtenAt: saved.updatedAt };
      const file = partIndex.current.get(id);
      const row = file ? currentParts.current?.[file]?.find((t) => t.id === id) : undefined;
      setMoves((pending) => {
        if (pending.get(id) !== move) return pending;
        const next = new Map(pending);
        if (reflectsWrite(row, ack)) next.delete(id);
        else next.set(id, ack);
        return next;
      });
    }
    if (fn === "drop" && id && toast)
      toast(`已放弃 ${id}`, {
        duration: 10000,
        action: {
          label: "撤销",
          onClick: () => void act("restore", { id }).catch((e: any) => toast?.error?.(String(e?.message ?? e))),
        },
      });
    return result;
  };
  return { tasks, act };
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
