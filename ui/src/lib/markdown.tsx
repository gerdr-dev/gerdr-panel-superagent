import * as core from "@gerdr/core";

// What agents write (a step, a question, a summary), drawn the way the chat draws it: Gerdr's own Markdown, so a
// sample video written as ![](path) plays right where the user decides, and a path opens in Gerdr. Only ![](…) is
// media: a bare path stays a path — agents are told to write ![](…) (board.ts, human.md), not guessed after them. Through the namespace, so a Gerdr from
// before core exported Markdown still runs this panel (plain text, as then).
const GerdrMarkdown = (core as unknown as { Markdown?: React.ComponentType<{ children: string }> }).Markdown;

// chat: at the chat's own text size (Gerdr's 字号 setting, --gerdr-font) instead of the cards' smaller 13px, for words
// read as a message, like a reply waiting to be sent
export function Md({ children, className, chat }: { children: string; className?: string; chat?: boolean }) {
  const size = chat ? "text-[length:var(--gerdr-font,14px)]" : "text-[13px]";
  if (!GerdrMarkdown) return <p className={`whitespace-pre-wrap ${chat ? size : ""} ${className ?? ""}`}>{children}</p>;
  // gerdr-md: the chat's Markdown rules (Gerdr's style.css), as every Markdown in Gerdr has them around it. Without
  // it inline code kept its own fixed 14px, bigger than the 13px text around it, and lists lost their spacing
  return <div className={`gerdr-md min-w-0 ${size} ${className ?? ""}`}><GerdrMarkdown>{children}</GerdrMarkdown></div>;
}
