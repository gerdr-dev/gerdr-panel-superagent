// Variables in playbook prose: {{name: value ; type}}. One parser for both sides: the 流程 page edits with it, and
// local functions (local/_vars.ts imports this file) read the values and render the text agents get.
//
// The value always comes right after the colon, so the file reads fine without the editor; the type after `;`:
//
//   {{GitLab: gitlab.example.com}}                text (no type)
//   {{合并: 自动 ; 自动 | 手动}}                    choice: one of the options
//   {{通知: 手机, 飞书 ; multi 手机 | 飞书 | 邮件}}   multi: several of them, comma separated
//   {{批准人数: 1 ; number 0-5}}                  number, optional range
//   {{间隔: 5m ; duration}}                       30m, 6h, 1d
//   {{时间: 09:00, 16:00 ; time}}                 times of day, comma separated
//   {{仓库: ~/dev/api ; dir}}  {{模板: ~/x.md ; file}}
//   {{直推仓库: craft/a, craft/b ; list}}         several free values
//   {{令牌: GITLAB_TOKEN ; secret}}               the name of a panel secret, never its value
//   {{worker: codex ; agent}}                     an agent / role id
//
// Rendering for an agent replaces each {{…}} with its value. A value may not contain `;` or `}}`. Written inside
// code (`…` or a ``` fence) it's an example, not a variable: that's how a skill explains the syntax to its reader.

export type VarType = "text" | "choice" | "multi" | "number" | "duration" | "time" | "dir" | "file" | "list" | "secret" | "agent";

export type Var = {
  name: string;
  value: string; // as written
  type: VarType;
  spec: string; // the part after `;`, as written ("" for text)
  options?: string[];
  min?: number;
  max?: number;
  start: number; // offsets of the whole {{…}} in the text
  end: number;
  error?: string;
};

export const TYPES: { type: VarType; label: string; hint: string }[] = [
  { type: "text", label: "文本", hint: "任意一段文字" },
  { type: "choice", label: "单选", hint: "从几个选项里选一个" },
  { type: "multi", label: "多选", hint: "从几个选项里选几个" },
  { type: "number", label: "数字", hint: "可以限定范围" },
  { type: "duration", label: "时长", hint: "30m、6h、1d" },
  { type: "time", label: "时刻", hint: "每天几点，可以几个" },
  { type: "dir", label: "目录", hint: "一个文件夹" },
  { type: "file", label: "文件", hint: "一个文件" },
  { type: "list", label: "列表", hint: "几个任意的值" },
  { type: "secret", label: "密钥", hint: "面板密钥的名字，值不进文字" },
  { type: "agent", label: "Agent", hint: "Gerdr 里的 agent / 角色" },
];

const RE = /\{\{\s*([^:{}]+?)\s*:\s*([^;{}]*?)\s*(?:;\s*([^{}]*?)\s*)?\}\}/g;
const KEYWORDS = new Set(["multi", "number", "duration", "time", "dir", "file", "list", "secret", "agent"]);

const splitList = (v: string) =>
  v
    .split(/[,，、]/)
    .map((x) => x.trim())
    .filter(Boolean);
const splitOptions = (v: string) =>
  v
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);

function typeOf(spec: string): Pick<Var, "type" | "options" | "min" | "max" | "error"> {
  const s = spec.trim();
  if (!s) return { type: "text" };
  const [word, ...rest] = s.split(/\s+/);
  const tail = rest.join(" ");
  if (!KEYWORDS.has(word)) {
    if (s.includes("|")) return { type: "choice", options: splitOptions(s) };
    return { type: "text", error: `不认识的类型「${word}」：用 ${[...KEYWORDS].join(" / ")}，或者写选项 a | b` };
  }
  if (word === "multi") {
    const options = splitOptions(tail);
    return options.length ? { type: "multi", options } : { type: "multi", error: "multi 后面要写选项：multi a | b | c" };
  }
  if (word === "number") {
    if (!tail) return { type: "number" };
    const m = /^(-?\d+(?:\.\d+)?)?\s*-\s*(-?\d+(?:\.\d+)?)?$/.exec(tail);
    if (!m) return { type: "number", error: "范围写成 number 0-5（可以只写一头：number 1-、number -10）" };
    return { type: "number", min: m[1] != null ? Number(m[1]) : undefined, max: m[2] != null ? Number(m[2]) : undefined };
  }
  return { type: word as VarType };
}

/** Why a value doesn't fit its type, or "" when it does. */
export function check(v: Pick<Var, "type" | "value" | "options" | "min" | "max">): string {
  const val = v.value.trim();
  if (/;|\}\}/.test(v.value)) return "值里不能有 ; 或 }}";
  switch (v.type) {
    case "choice":
      return v.options?.includes(val) ? "" : `要是 ${v.options?.join(" / ")} 之一`;
    case "multi": {
      const bad = splitList(val).filter((x) => !v.options?.includes(x));
      return bad.length ? `${bad.join("、")} 不在选项里` : "";
    }
    case "number": {
      if (!/^-?\d+(\.\d+)?$/.test(val)) return "要是一个数";
      const n = Number(val);
      if (v.min != null && n < v.min) return `最小 ${v.min}`;
      if (v.max != null && n > v.max) return `最大 ${v.max}`;
      return "";
    }
    case "duration":
      return /^\d+(s|m|h|d)$/.test(val) ? "" : "写成 30m、6h、1d";
    case "time":
      return splitList(val).every((x) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(x)) && val ? "" : "写成 09:00，几个用逗号隔开";
    case "secret":
      return /^[\w.-]+$/.test(val) ? "" : "密钥名只能有字母、数字、. - _";
    case "dir":
    case "file":
    case "agent":
      return val ? "" : "不能是空的";
  }
  return "";
}

/** Offsets that are inside code (`inline` or a ``` fence): a {{…}} there is an example, not a variable. */
function codeSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/```[\s\S]*?(```|$)|`[^`\n]*`/g)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** Every variable in the text, in order. Ones written inside code (`…`, ``` fences) are examples and don't count. */
export function parse(text: string): Var[] {
  const out: Var[] = [];
  const code = codeSpans(text);
  for (const m of text.matchAll(RE)) {
    if (code.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    const t = typeOf(m[3] ?? "");
    const v: Var = { name: m[1].trim(), value: m[2], spec: (m[3] ?? "").trim(), start: m.index!, end: m.index! + m[0].length, ...t };
    v.error = t.error || check(v) || undefined;
    out.push(v);
  }
  return out;
}

/** The value as code wants it: number for number, string[] for multi / list / time, else the string. */
export function typed(v: Var): string | number | string[] {
  const val = v.value.trim();
  if (v.type === "number") return Number(val);
  if (v.type === "multi" || v.type === "list" || v.type === "time") return splitList(val);
  return val;
}

/** The text as an agent reads it: each {{…}} replaced by its value (examples in code left as written). */
export function render(text: string): string {
  const code = codeSpans(text);
  return text.replace(RE, (whole, _n, value, _t, at: number) => (code.some(([a, b]) => at >= a && at < b) ? whole : String(value).trim()));
}

/** One {{…}} written out. */
export function format(v: Pick<Var, "name" | "value" | "spec">): string {
  return `{{${v.name}: ${v.value.trim()}${v.spec ? ` ; ${v.spec}` : ""}}}`;
}

/** The text with the variable at `start` given a new value (its type kept). */
export function setValue(text: string, start: number, value: string): string {
  const v = parse(text).find((x) => x.start === start);
  if (!v) return text;
  return text.slice(0, v.start) + format({ ...v, value }) + text.slice(v.end);
}

/** The type part to write for a new variable of a type, with options / range filled in. */
export function specFor(type: VarType, extra = ""): string {
  if (type === "text") return "";
  if (type === "choice") return extra;
  return extra ? `${type} ${extra}` : type;
}

export function joinList(items: string[]) {
  return items.join(", ");
}
export { splitList };
