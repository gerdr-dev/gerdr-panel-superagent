import * as core from "@gerdr/core";

// What agents write (a step, a question, a summary), drawn the way the chat draws it: Gerdr's own Markdown, so a
// sample video written as ![](path) plays right where the user decides, and a path opens in Gerdr. Only ![](…) is
// media: a bare path stays a path — agents are told to write ![](…) (board.ts, human.md), not guessed after them. Through the namespace, so a Gerdr from
// before core exported Markdown still runs this panel (plain text, as then).
const GerdrMarkdown = (core as unknown as { Markdown?: React.ComponentType<{ children: string }> }).Markdown;

export function Md({ children, className }: { children: string; className?: string }) {
  if (!GerdrMarkdown) return <p className={`whitespace-pre-wrap ${className ?? ""}`}>{children}</p>;
  return <div className={`min-w-0 text-[13px] leading-relaxed ${className ?? ""}`}><GerdrMarkdown>{children}</GerdrMarkdown></div>;
}
