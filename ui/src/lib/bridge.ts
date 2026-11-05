// Bridge calls this site's lib/gerdr.ts doesn't have (it was edited, so Gerdr no longer upgrades it). Same messages
// as the built-in bridge.

/** Shows a coding-agent conversation in Code (switches mode, focuses its pane). */
export function openSession(session: string) {
  window.parent.postMessage({ type: "gerdr:openSession", session }, location.origin);
}

/** jump: Gerdr scrolls the chat to the card with that ref (a panel tool's gerdrCard) instead of telling the page. */
export type SessionAction = { id: string; label: string; kind?: "primary" | "danger"; confirm?: string; jump?: string };

/**
 * Shows a conversation in a panel over this page: its whole chat and Gerdr's own input box (images, files, paste,
 * drop), with our line and buttons above it. Called again for the shown one, it updates them. A Gerdr too old for it
 * ignores the message: then use openSession.
 */
/** A thing waiting on the user, one line under the bar: jump scrolls the chat to that card, action tells the page. */
export type SessionItem = { text: string; jump?: string; action?: string };

export function showSession(session: string, opts: { label?: string; actions?: SessionAction[]; items?: SessionItem[] } = {}) {
  window.parent.postMessage({ type: "gerdr:showSession", session, ...opts }, location.origin);
}

export function hideSession() {
  window.parent.postMessage({ type: "gerdr:hideSession" }, location.origin);
}

/** A button on the panel pressed (`action`), or the panel closed (no `action`). */
export function onSessionPanel(fn: (e: { session: string; action?: string }) => void) {
  const f = (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const m = e.data ?? {};
    if (m.type === "gerdr:sessionAction" && typeof m.action === "string") fn({ session: m.session, action: m.action });
    else if (m.type === "gerdr:sessionHidden") fn({ session: m.session });
  };
  window.addEventListener("message", f);
  return () => window.removeEventListener("message", f);
}

let seq = 0;
const pending = new Map<number, { resolve: (saved: boolean) => void; reject: (e: Error) => void }>();

/**
 * Asks for a secret in Gerdr's own dialog and saves it for ctx.secrets.get(name); true when saved, false when
 * cancelled. The page never sees the value. A Gerdr too old for this shows nothing and the promise never settles:
 * the page offers `gerdr panel secret set` next to the button for that case.
 */
export function askSecret(name: string, opts: { label?: string; note?: string } = {}): Promise<boolean> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ type: "gerdr:secret", id, name, label: opts.label, note: opts.note }, location.origin);
  });
}

/** Names of the saved secrets (never the values). */
export async function secretNames(): Promise<string[]> {
  const res = await fetch("/api/work/secrets", { credentials: "same-origin", headers: { "X-Gerdr": "1" } });
  const data = await res.json().catch(() => ({}));
  return res.ok ? (data.list ?? []) : [];
}

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.data?.type !== "gerdr:secretDone") return;
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  if (e.data.error) p.reject(new Error(e.data.error));
  else p.resolve(!!e.data.saved);
});

// An Esc nothing on the page used goes to Gerdr, which closes the conversation panel (showSession) like a drawer.
// Same as the built-in bridge, which this site's edited gerdr.ts no longer gets.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.defaultPrevented) window.parent.postMessage({ type: "gerdr:escape" }, location.origin);
});
