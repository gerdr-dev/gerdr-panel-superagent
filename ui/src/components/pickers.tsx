import { ArrowUp, ChevronRight, Folder, GitBranch } from "lucide-react";
import clsx from "clsx";
import { Fragment, useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { run } from "../lib/gerdr";
import { Select } from "./ui/select";

// Controls the 设置 page shares: a folder (typed, or browsed from the user's projects down) and an agent / role.

export const input = "h-8 w-full rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring max-md:text-[16px]";

type Entry = { name: string; path: string; git?: boolean };
type Here = { path: string; home: string; recent: string[]; entries: Entry[] };

const parentOf = (p: string) => p.replace(/\/[^/]*\/?$/, "") || "/";
const inHome = (p: string, home: string) => !!home && (p === home || p.startsWith(home + "/"));
const tilde = (p: string, home: string) => (inHome(p, home) ? "~" + p.slice(home.length) : p);

/**
 * A folder: type it, or browse (the user's recent projects listed under the folders).
 *
 * Typing drops down the folders it could mean (settings.complete): a path lists the folders next to its last part
 * (~/GolandProjects/ger → gerdr, gerdr-addon…), a bare name the recent projects. ↑↓ pick, Tab or a click fills it in
 * and lists what's inside (keep typing the next level), Enter takes it, Esc closes. Enter with nothing picked — nothing
 * dropped down, or right after a "/" — is onEnter (the repository list adds the folder typed).
 *
 * The browser opens where the field points (the nearest folder above a half-typed path), and its top row — up a level,
 * the path with each part a way back to it, 选这里 — stays put while the folders scroll under it. It used to be a small
 * grey ".." inside the list: in a folder of 60 repositories it scrolled away with the path, and there was no way back
 * up from a wrong turn (user report).
 */
export function PathPick({ value, onChange, placeholder, onEnter }: { value: string; onChange: (v: string) => void; placeholder?: string; onEnter?: () => void }) {
  const [open, setOpen] = useState(false);
  const [here, setHere] = useState<Here | null>(null);
  const go = (path?: string) => run<Here>("settings.browse", { path }).then(setHere, () => {});

  // What's typed, completed: only while the person types here (not for a value set from outside or by 选这里)
  const [typing, setTyping] = useState(false);
  const [hits, setHits] = useState<Entry[]>([]);
  const [home, setHome] = useState("");
  const [active, setActive] = useState(0);
  const asked = useRef(0);
  useEffect(() => {
    const text = value.trim();
    if (!typing || !text) return void setHits([]);
    const n = ++asked.current;
    // A short wait, so a fast typist asks once rather than once a letter; a late answer for older text is dropped
    const t = setTimeout(
      () =>
        run<{ home: string; items: Entry[] }>("settings.complete", { text }).then(
          // Nothing picked yet after a "/": the folder typed is what Enter takes, ↓ goes into the list. A part of a
          // name typed: its best match is picked, so Enter / Tab take it
          (r) => n === asked.current && (setHits(r.items), setHome(r.home), setActive(text.endsWith("/") ? -1 : 0)),
          () => {},
        ),
      120,
    );
    return () => clearTimeout(t);
  }, [value, typing]);
  const shown = typing && hits.length > 0;
  // Esc closes the list, not what it sits in: the settings sheet (Radix) hears Esc on the document's capture phase,
  // before this field's own handler, and closed altogether. Caught on the window first, only while the list is open
  useEffect(() => {
    if (!shown) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      e.preventDefault();
      setTyping(false);
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [shown]);
  const fill = (e: Entry) => (onChange(e.path + "/"), setTyping(true));
  const take = (e: Entry) => (onChange(e.path), setTyping(false));

  const toggleBrowser = () => {
    setTyping(false);
    if (open) return setOpen(false);
    setOpen(true);
    go(value.trim() || undefined);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <div className="relative min-w-0 flex-1">
          <input
            className={clsx(input, "font-mono text-[12px]")}
            value={value}
            placeholder={placeholder}
            role="combobox"
            aria-expanded={shown}
            aria-autocomplete="list"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => (onChange(e.target.value), setTyping(true))}
            onBlur={() => setTyping(false)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return; // an IME picking characters: its Enter isn't ours
              if (shown && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                const n = hits.length;
                setActive(e.key === "ArrowDown" ? (active + 1) % n : active <= 0 ? n - 1 : active - 1);
              } else if (shown && e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                fill(hits[Math.max(active, 0)]);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (shown && active >= 0) take(hits[active]);
                else onEnter?.();
              }
            }}
          />
          {shown && (
            <div role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-background p-1 text-[12px] shadow-md">
              {hits.map((h, i) => (
                <button
                  key={h.path}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  // mousedown, not click: the field's blur would close the list before a click lands
                  onMouseDown={(e) => (e.preventDefault(), fill(h))}
                  onMouseEnter={() => setActive(i)}
                  className={clsx("flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left max-md:py-2", i === active && "bg-accent")}
                >
                  <Folder className="size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{h.name}</span>
                  {h.git && <GitBranch className="size-3 shrink-0 text-muted-foreground" aria-label="git 仓库" />}
                  {/* Where it is, after the name and never over it; a phone has no room for it (the name is what's looked for) */}
                  <span className="ml-auto max-w-[50%] shrink-0 truncate pl-2 text-right font-mono text-[11px] text-muted-foreground max-md:hidden">
                    {tilde(parentOf(h.path), home)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Button variant="outline" size="icon-sm" className="shrink-0" aria-label="选择文件夹" aria-expanded={open} onClick={toggleBrowser}>
          <Folder className="size-3.5" />
        </Button>
      </div>
      {open && here && (
        <div className="max-h-72 overflow-y-auto rounded-md border bg-background text-[12px]">
          {/* One row on a desktop; on a phone the path gets a row of its own under the two buttons, or it broke mid-word */}
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 border-b bg-background p-1.5">
            <Button variant="ghost" className="shrink-0 px-2" disabled={here.path === "/"} onClick={() => go(parentOf(here.path))}>
              <ArrowUp className="size-3.5" />
              上一级
            </Button>
            <Crumbs path={here.path} home={here.home} go={go} />
            <Button className="shrink-0 max-md:ml-auto" onClick={() => (onChange(here.path), setOpen(false))}>
              选这里
            </Button>
          </div>
          <div className="space-y-0.5 p-1.5">
            {!here.entries.length && <p className="px-1 py-0.5 text-muted-foreground">这里面没有文件夹</p>}
            {here.entries.map((e) => (
              <button key={e.path} onClick={() => go(e.path)} className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-accent max-md:py-1.5">
                <Folder className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{e.name}</span>
                {e.git && <GitBranch className="size-3 shrink-0 text-muted-foreground" aria-label="git 仓库" />}
              </button>
            ))}
            {here.recent.length > 0 && (
              <>
                <div className="px-1 pt-1 text-[11px] text-muted-foreground">最近的项目</div>
                {here.recent.map((p) => (
                  <button key={p} onClick={() => go(p)} className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left font-mono text-[11px] hover:bg-accent max-md:py-1.5">
                    <Folder className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{tilde(p, here.home)}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The browser's path, each part a button back to it; home shows as ~. Wraps rather than cuts a long path. */
function Crumbs({ path, home, go }: { path: string; home: string; go: (p: string) => void }) {
  const under = inHome(path, home);
  const crumbs = [{ label: under ? "~" : "/", path: under ? home : "/" }];
  let at = under ? home : "";
  for (const part of (under ? path.slice(home.length) : path).split("/").filter(Boolean)) crumbs.push({ label: part, path: (at += "/" + part) });
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-y-0.5 font-mono text-[11px] max-md:order-last max-md:basis-full">
      {crumbs.map((c, i) => (
        <Fragment key={c.path}>
          {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
          {i === crumbs.length - 1 ? (
            <span className="px-0.5 font-medium [overflow-wrap:anywhere]">{c.label}</span>
          ) : (
            <button className="rounded-sm px-0.5 text-muted-foreground [overflow-wrap:anywhere] hover:bg-accent hover:text-foreground max-md:py-1" onClick={() => go(c.path)}>
              {c.label}
            </button>
          )}
        </Fragment>
      ))}
    </div>
  );
}

export type AgentChoice = { id: string; name: string; description?: string };
export type AgentOption = {
  id: string;
  name: string;
  base?: string;
  models?: AgentChoice[];
  efforts?: AgentChoice[];
  /** Its permission modes, as it names them; absent until it has run here. */
  modes?: AgentChoice[];
  /** The agent an empty agent field starts (Gerdr's default agent). */
  default?: boolean;
  /** Gerdr's defaults for it: what an empty model / effort / mode field gives (local/settings.ts agents). */
  defaults?: { model?: string; effort?: string; mode?: string };
};

let agentList: Promise<AgentOption[]> | null = null;

/** The agents Gerdr can start, with the models / efforts each takes (settings.agents), asked once per page. */
export function useAgents() {
  const [list, setList] = useState<AgentOption[]>([]);
  useEffect(() => {
    agentList ??= run("settings.agents");
    agentList.then(setList, () => (agentList = null));
  }, []);
  return list;
}

export function AgentPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useAgents();
  const def = list.find((a) => a.default);
  return (
    <Select
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: def ? `默认（${def.name}）` : "Gerdr 的默认 agent" },
        ...(value && !list.some((a) => a.id === value) ? [{ value, label: value }] : []),
        ...list.map((a) => ({ value: a.id, label: a.name, hint: a.id })),
      ]}
    />
  );
}

/**
 * One of an agent's choices, or "" for the default — shown as 默认（what that is） when `def` names it. A value that
 * isn't in the list (typed before this was a menu, or the agent's list changed) stays as an option of its own rather
 * than being dropped.
 */
export function ChoicePick({ value, options, onChange, def }: { value: string; options: AgentChoice[]; onChange: (v: string) => void; def?: string }) {
  // An agent's own "default" entry (claude's efforts list one with id "") is the 默认 option already
  const real = options.filter((o) => o.id);
  return (
    <Select
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: def ? `默认（${def}）` : "默认" },
        ...(value && !real.some((o) => o.id === value) ? [{ value, label: value }] : []),
        ...real.map((o) => ({ value: o.id, label: o.name, hint: o.name === o.id ? undefined : o.id })),
      ]}
    />
  );
}
