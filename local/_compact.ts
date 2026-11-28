import { textOf } from "./playbooks";

export function compactCommand(ctx: Ctx, session: Session, playbook: string): string {
  const agent = ctx.sessions.agents().find((a) => a.id === session.agent);
  const engine = agent?.base ?? session.agent;
  // Codex app-server takes only a thread ID for compaction. Gerdr's Codex adapter
  // sends a command with trailing text to the model as a regular message.
  if (engine === "codex") return "/compact";
  const instructions = textOf(ctx, playbook).replace(/^#.*\n+/, "").trim();
  return `/compact ${instructions}`.trim();
}
