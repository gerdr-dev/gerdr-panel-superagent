import * as core from "@gerdr/core";

// What agents write (a step, a question, a summary), drawn the way the chat draws it: Gerdr's own Markdown, so a
// sample video plays right where the user decides and a path opens in Gerdr. Through the namespace, so a Gerdr from
// before core exported Markdown still runs this panel (plain text, as then).
const GerdrMarkdown = (core as unknown as { Markdown?: React.ComponentType<{ children: string }> }).Markdown;

// A local image / video / audio path written bare (agents often list sample files that way, not as ![](…)): shown as
// the media itself after its line, as the chat would show ![](path). The path stays in the text, clickable.
// What may follow the path: an end of line, a space, or punctuation — Chinese too (t18's "EP01-music.mp4（低清，带配乐）"
// wasn't shown as a video: "（" wasn't on the list)
const MEDIA = /(?:^|[\s(（:：「『"'`、，；])(\/[^\s()（）「」『』，。、；：！？`'"]+\.(?:mp4|mov|webm|m4v|png|jpe?g|gif|webp|svg|mp3|wav|m4a))(?=$|[\s()（）「」『』，。、；：！？,.;:!?`'"])/gim;

export function withMedia(text: string) {
  return text
    .split("\n")
    .map((line) => {
      if (/!\[[^\]]*\]\(/.test(line) || /^\s*(```|    )/.test(line)) return line;
      const found = [...line.matchAll(MEDIA)].map((m) => m[1]);
      return found.length ? `${line}\n\n${found.map((p) => `![](${encodeURI(p)})`).join("\n")}\n` : line;
    })
    .join("\n");
}

export function Md({ children, className }: { children: string; className?: string }) {
  if (!GerdrMarkdown) return <p className={`whitespace-pre-wrap ${className ?? ""}`}>{children}</p>;
  return <div className={`min-w-0 text-[13px] leading-relaxed ${className ?? ""}`}><GerdrMarkdown>{withMedia(children)}</GerdrMarkdown></div>;
}
