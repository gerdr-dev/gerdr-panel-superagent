// Where the chat cards stand (local/_cardstate.ts), as the board's last tasks.list had them: the board files them here,
// ui/src/cards.tsx reads them. Kept on window, not in this module, because the cards file and the board's pages are
// loaded as separate modules (Gerdr loads src/cards.tsx at start, lib/mounts.ts) and a hot update makes new copies of
// either: a module-level map would be a different one on each side.

type Store = { states: Map<string, unknown>; subs: Set<() => void>; at: Map<string, number> };

function store(): Store {
  const w = window as unknown as { __superagentCardStates?: Store };
  return (w.__superagentCardStates ??= { states: new Map(), subs: new Set(), at: new Map() });
}

/** The project a card carries (ctx.workspace.project) + its key (out:t5~o1, step:a5#2, wait:t5:<since>). */
const full = (project: string, key: string) => `${project}\n${key}`;

/** What the board knows about one card; undefined when it doesn't (an archived task, the board not loaded yet). */
export function cardState<T>(project: string, key: string): T | undefined {
  return store().states.get(full(project, key)) as T | undefined;
}

/** The board got its tasks: their cards' states, each task's replacing what was known before. */
export function fileCardStates(project: string | undefined, tasks: { cards?: Record<string, unknown> }[]) {
  if (!project) return;
  const s = store();
  for (const t of tasks) for (const [k, v] of Object.entries(t.cards ?? {})) s.states.set(full(project, k), v);
  s.at.set(project, Date.now());
  for (const f of s.subs) f();
}

/** Whether the board of `project` filed its states in the last `ms`: it is loaded and keeping them fresh. */
export function boardFresh(project: string, ms: number) {
  return Date.now() - (store().at.get(project) ?? 0) < ms;
}

/** Called after every fileCardStates; returns the unsubscribe. */
export function onCardStates(f: () => void) {
  const s = store();
  s.subs.add(f);
  return () => void s.subs.delete(f);
}
