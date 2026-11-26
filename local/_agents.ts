// The agents and roles Gerdr can start a worker with: for @-mentions on the board and the router's prompt.
// ctx.sessions.agents().

/**
 * models: what `model` takes, with the picker's name (`fable` = `Fable 5.2`); efforts: what `effort` takes. Only from a
 * Gerdr that lists them, and only once that kind of agent has run here.
 */
export type AgentChoice = { id: string; name: string; description?: string };
export type AgentInfo = { id: string; name: string; base?: string; prompt?: string; models?: AgentChoice[]; efforts?: AgentChoice[]; modes?: AgentChoice[] };

export async function allAgents(ctx: Ctx): Promise<AgentInfo[]> {
  const raw: any[] = ctx.sessions.agents();
  return raw
    .filter((a) => a.available !== false)
    .map((a) => ({
      id: a.id,
      name: a.name ?? a.id,
      ...(a.base ? { base: a.base } : {}),
      ...(a.prompt ? { prompt: a.prompt } : {}),
      ...(a.models?.length ? { models: a.models.map(choice) } : {}),
      ...(a.efforts?.length ? { efforts: a.efforts.map(choice) } : {}),
      // Its permission modes, as it names them (codex's aren't claude's): `modes` from a Gerdr that lists them, else
      // the options it last reported, which every Gerdr hands along
      ...((a.modes ?? a.options?.modes?.availableModes)?.length ? { modes: (a.modes ?? a.options.modes.availableModes).map(choice) } : {}),
    }));
}

function choice(m: any): AgentChoice {
  return { id: m.id, name: m.name ?? m.id, ...(m.description ? { description: m.description } : {}) };
}

/** `@id` / `@name` in a task's text, as agent ids (each once, in order). */
export function mentionsIn(text: string, agents: AgentInfo[]): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/@([^\s@，。,.;；:：!?！？)）]+)/g)) {
    const w = m[1].toLowerCase();
    const a = agents.find((x) => x.id.toLowerCase() === w || x.name.toLowerCase() === w);
    if (a && !out.includes(a.id)) out.push(a.id);
  }
  return out;
}

/** Gerdr's default agent (Settings → its default agent: what a session started without one runs); "" when unknown. */
export async function defaultAgent(ctx: Ctx): Promise<string> {
  const r = await ctx.exec("gerdr", ["config", "get", "defaultAgent"], { timeout: 10_000 }).catch(() => null);
  try {
    const v = r?.code === 0 ? JSON.parse(r.stdout) : "";
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}
