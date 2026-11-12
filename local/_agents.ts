// The agents and roles Gerdr can start a worker with: for @-mentions on the board and the router's prompt.
// ctx.sessions.agents() where Gerdr has it; an older Gerdr only has the CLI.

/** models: what `model` takes, with the picker's name (`fable` = `Fable 5.2`); only from a Gerdr that lists them. */
export type AgentInfo = { id: string; name: string; base?: string; prompt?: string; models?: { id: string; name: string }[] };

export async function allAgents(ctx: Ctx): Promise<AgentInfo[]> {
  let raw: any[] = [];
  if (typeof (ctx.sessions as any).agents === "function") raw = (ctx.sessions as any).agents();
  else {
    const r = await ctx.exec("gerdr", ["session", "agents"], { timeout: 15_000 });
    try {
      raw = r.code === 0 ? JSON.parse(r.stdout) : [];
    } catch {
      raw = [];
    }
  }
  return raw
    .filter((a) => a.available !== false)
    .map((a) => ({
      id: a.id,
      name: a.name ?? a.id,
      ...(a.base ? { base: a.base } : {}),
      ...(a.prompt ? { prompt: a.prompt } : {}),
      ...(a.models?.length ? { models: a.models.map((m: any) => ({ id: m.id, name: m.name ?? m.id })) } : {}),
    }));
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
