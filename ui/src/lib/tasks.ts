import { useCallback, useEffect, useRef, useState } from "react";
import { run } from "./gerdr";

/** An artifact (产物): something a step produced, with when it came (older ones have no time). */
export type Link = { label: string; url: string; at?: number };
export type Live = { status: string; waiting?: string; waitingSince?: number; turnStartedAt?: number; updatedAt: number; error?: string; title?: string } | null;
export type Task = {
  id: string;
  title: string;
  owner: "agent" | "human";
  status: "todo" | "running" | "review" | "delivering" | "done" | "dropped";
  /** While delivering: the MR and what the watcher last saw (local/_store.ts Delivery). */
  delivery?: { kind: "mr"; url: string; iid: number; state?: string; detail?: string; checked?: number; rounds?: number };
  routing?: number;
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
  handBack?: { kind: "none" | "value" | "secret" | "choice" | "questions"; name?: string; label?: string; options?: string[] };
  /** handBack "questions": several decisions / values asked at once, each answered on its own (local/_store.ts). */
  questions?: { id: string; title: string; kind: "choice" | "value"; options?: string[]; label?: string; steps?: string; answer?: string; dropped?: string }[];
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
  ready: boolean;
};

const POLL = 5000;

/** The board, refreshed every few seconds while the page is visible (the run is a file read plus session lookups). */
export function useTasks() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const reload = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await run<{ tasks: Task[] }>("tasks.list");
      setTasks(r.tasks);
      setError("");
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      busy.current = false;
    }
  }, []);
  useEffect(() => {
    void reload();
    const t = setInterval(() => document.visibilityState === "visible" && void reload(), POLL);
    const vis = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [reload]);
  /** Runs a tasks.<fn> and refreshes the board after. */
  const act = useCallback(
    async (fn: string, input: unknown) => {
      const r = await run(`tasks.${fn}`, input);
      await reload();
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

export function day(ms: number) {
  return new Date(ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
}
