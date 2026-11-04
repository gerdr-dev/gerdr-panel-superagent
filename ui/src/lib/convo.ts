// Which conversation a drawer shows: a session ("abc123"), or one of its subagents ("abc123#toolu_01…": the toolCallId of
// the call that started it). One string, so the 链路 (local/tasks.ts tree), 在等 and the chat's 查看对话 all switch the
// same way.

export function convo(session: string, sub?: string | null) {
  return sub ? `${session}#${sub}` : session;
}

export function parseConvo(key: string): { session: string; sub?: string } {
  const i = key.indexOf("#");
  return i < 0 ? { session: key } : { session: key.slice(0, i), sub: key.slice(i + 1) };
}
