// A worker's report applied to its task: from a ```gerdr-task``` block at the end of a reply (older workers, tasks.ts
// list) or from its Work tools (board.ts task_update / ask_human). One set of rules for both.

import { newTask, note, type Store, type Task } from "./_store";

/** The conversation an MR is, as mrwatch.ts emits its events: gitlab, group/repo!34. */
export function mrThread(project: string, iid: number) {
  return { source: "gitlab", key: `${project}!${iid}` };
}

/** What a worker's reply says, applied to its task. Returns the human task it asked for, if any. */
export function applyBlock(s: Store, t: Task, b: any): Task | null {
  if (typeof b.summary === "string" && b.summary.trim()) t.summary = b.summary.trim();
  // Artifacts (产物) pile up, never replaced: what each step produced (a draft MR page, a pipeline, the MR, a doc) is the
  // trail the user follows back later. Each keeps when it first came.
  if (Array.isArray(b.links)) {
    const seen = new Set((t.links ?? []).map((l) => l.url));
    for (const l of b.links)
      if (l?.url && !seen.has(l.url)) {
        seen.add(l.url);
        t.links = [...(t.links ?? []), { label: String(l.label || "链接"), url: String(l.url), at: Date.now() }];
      }
  }
  switch (b.state) {
    case "review":
      t.status = "review";
      t.question = undefined;
      break;
    case "done":
      Object.assign(t, { status: "done", question: undefined, delivery: undefined, doneAt: Date.now() });
      break;
    case "delivering": {
      const m = /^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(String(b.mr ?? ""));
      if (!m) {
        t.question = `worker 说在等交付，但没给出 MR 地址（mr 字段）：${b.mr ?? "空"}。去对话里让它补上`;
        break;
      }
      const url = m[0];
      if (!(t.links ?? []).some((l) => l.url === url)) t.links = [...(t.links ?? []), { label: `MR !${m[3]}`, url, at: Date.now() }];
      // The same MR again (after handling a round): keep what the watcher already saw
      const same = t.delivery?.url === url;
      t.delivery = same ? t.delivery : { kind: "mr", url, project: m[2], iid: Number(m[3]), since: Date.now(), seen: [], rounds: 0 };
      // The MR is a conversation of this task from now on: what happens on it (review comments, a failed pipeline,
      // conflicts; mrwatch.ts emits them) comes to this task's worker by subscription, like a follow-up in its chat
      const th = mrThread(m[2], Number(m[3]));
      const cur = t.threads ?? (t.origin?.key ? [{ source: t.origin.source, key: t.origin.key }] : []);
      if (!cur.some((x) => x.source === th.source && x.key === th.key)) t.threads = [...cur, th];
      Object.assign(t, { status: "delivering", question: undefined });
      break;
    }
    case "question":
      t.question = String(b.question || b.summary || "需要你决定");
      break;
    case "blocked": {
      const h = b.human ?? {};
      // A block's latest ask is what counts: earlier steps it asked for and the user hasn't done are replaced. A tool call
      // (replace: false) leaves them: the worker takes back what's moot itself (cancel_human).
      const old = b.replace === false ? [] : s.tasks.filter((x) => x.owner === "human" && x.askedBy === t.id && x.status !== "done" && x.status !== "dropped");
      const human = newTask(s, {
        askedBy: t.id,
        expiresAt: Number(h.expires) > 0 ? Date.now() + Number(h.expires) * 60_000 : undefined,
        title: String(h.title || "人工步骤"),
        owner: "human",
        steps: h.steps ? String(h.steps) : undefined,
        handBack: h.handBack?.kind ? { kind: h.handBack.kind, name: h.handBack.name, label: h.handBack.label, options: h.handBack.options } : { kind: "none" },
        verify: h.verify ? String(h.verify) : undefined,
        minutes: Number(h.minutes) || undefined,
        urgent: true, // it's holding up a worker
      });
      for (const o of old) {
        note(o, `被 ${human.id} 取代（worker 换了做法或重新发了一次），自动放弃`);
        Object.assign(o, { status: "dropped", doneAt: Date.now(), updatedAt: Date.now() });
      }
      t.blockedBy = [...(t.blockedBy ?? []).filter((id) => !old.some((o) => o.id === id)), human.id];
      return human;
    }
  }
  return null;
}
