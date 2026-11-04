// The bridge between this panel and gerdr around it.
//
// - run(fn, input, options): stream a local function's result, progress and logs.
//   Commands, files and platform access live in local/, while the page draws.
// - ask(text): hand a task to the panel's agent on the right of the page (gerdr sends it as a message;
//   it queues if the agent is busy); resolves with the conversation's id. openChat(id) shows that conversation.
// - The page follows gerdr's light / dark theme by itself (see the listener at the bottom).

/** The panel this site is: it's served at /work/<project>/. */
export const project = decodeURIComponent(location.pathname.split("/")[2] || "default");

export type RunOptions = {
  onProgress?: (data: { message?: string; done?: number; total?: number }) => void;
  onLog?: (line: { level: string; message: string }) => void;
  onStart?: (id: string) => void;
  signal?: AbortSignal;
};

export class RunError extends Error {
  runId?: string;
  constructor(message: string, stack?: string, runId?: string) {
    super(message);
    this.name = "RunError";
    if (stack) this.stack = stack;
    this.runId = runId;
  }
}

export async function abort(id: string) {
  const res = await fetch(`/api/work/runs/${encodeURIComponent(id)}/abort`, {
    method: "POST", credentials: "same-origin", headers: { "X-Gerdr": "1" },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || res.statusText);
}

async function follow<T>(body: ReadableStream<Uint8Array>, id: string | undefined, options: RunOptions): Promise<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!chunk.startsWith("data: ")) continue;
        const event = JSON.parse(chunk.slice(6));
        if (event.type === "start") options.onStart?.(event.data.id);
        else if (event.type === "progress") options.onProgress?.(event.data);
        else if (event.type === "log") options.onLog?.(event.data);
        else if (event.type === "result") return event.data.value as T;
        else if (event.type === "error") throw new RunError(event.data.message, event.data.stack, id);
      }
    }
    throw new RunError("连接在查询完成前关闭，查询可能仍在运行。", undefined, id);
  } finally { reader.releaseLock(); }
}

async function stream<T>(res: Response, options: RunOptions, runId?: string): Promise<T> {
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({})))?.error || res.statusText);
  const id = runId || res.headers.get("X-Gerdr-Run") || undefined;
  const stop = () => { if (id) void abort(id).catch(() => {}); };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try { return await follow<T>(res.body, id, options); }
  finally { options.signal?.removeEventListener("abort", stop); }
}

export async function run<T = any>(fn: string, input?: unknown, options: RunOptions = {}): Promise<T> {
  if (options.signal?.aborted) throw new DOMException("查询已停止", "AbortError");
  const res = await fetch("/api/work/run", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Gerdr": "1" },
    body: JSON.stringify({ project, fn, input }),
  });
  return stream<T>(res, options);
}

export async function attach<T = any>(id: string, options: RunOptions = {}): Promise<T> {
  const res = await fetch(`/api/work/runs/${encodeURIComponent(id)}`, {
    credentials: "same-origin", headers: { Accept: "text/event-stream", "X-Gerdr": "1" },
  });
  return stream<T>(res, options, id);
}

export async function functions(): Promise<{ name: string; file: string }[]> {
  const res = await fetch(`/api/work/functions?project=${encodeURIComponent(project)}`, {
    credentials: "same-origin", headers: { "X-Gerdr": "1" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data.list;
}

let askSeq = 0;
const asking = new Map<number, { resolve: (session: string) => void; reject: (e: Error) => void }>();

/** Resolves with the id of the conversation the task went to, once gerdr has sent it. */
export function ask(text: string): Promise<string> {
  const id = ++askSeq;
  return new Promise((resolve, reject) => {
    asking.set(id, { resolve, reject });
    window.parent.postMessage({ type: "gerdr:ask", id, text }, location.origin);
  });
}

/** Shows a panel agent conversation (e.g. the one ask() returned): opens it on the right, and on a phone switches to the 助手 tab. */
export function openChat(session: string) {
  window.parent.postMessage({ type: "gerdr:openChat", session }, location.origin);
}

/** Opens gerdr's settings (e.g. "mcp" to sign in to an MCP server). */
export function openSettings(tab?: string) {
  window.parent.postMessage({ type: "gerdr:settings", tab }, location.origin);
}

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.data?.type !== "gerdr:asked") return;
  const p = asking.get(e.data.id);
  if (!p) return;
  asking.delete(e.data.id);
  if (e.data.error) p.reject(new Error(e.data.error));
  else p.resolve(e.data.session);
});

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.data?.type !== "gerdr:theme") return;
  document.documentElement.classList.toggle("dark", !!e.data.dark);
  document.documentElement.style.colorScheme = e.data.dark ? "dark" : "light";
});
window.parent.postMessage({ type: "gerdr:ready" }, location.origin);

window.addEventListener("message", (e) => {
  if (e.origin === location.origin && e.data?.type === "gerdr:sidebar" && typeof e.data.width === "number") {
    document.documentElement.style.setProperty("--gerdr-sidebar-w", `${e.data.width}px`);
  }
});
