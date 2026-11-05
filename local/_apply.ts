// A worker's report applied to its task: from a ```gerdr-task``` block at the end of a reply (older workers, tasks.ts
// list) or from its panel tools (board.ts task_update / ask_human). One set of rules for both.

import { newTask, note, type Question, type Store, type Task } from "./_store";
import { askUser, endQuestions, mrConversation, waitOn } from "./_waits";


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
      endQuestions(t, "worker 交了结论");
      break;
    case "done":
      Object.assign(t, { status: "done", doneAt: Date.now() });
      break;
    // Older workers' "delivering" (an MR out, waiting on it): the same as wait_for on the MR — no state of its own
    case "delivering": {
      const conv = mrConversation(String(b.mr ?? ""));
      if (!conv) {
        askUser(t, `worker 说在等 MR，但没给出 MR 地址（mr 字段）：${b.mr ?? "空"}。去对话里让它补上`);
        break;
      }
      if (!(t.links ?? []).some((l) => l.url === conv.url)) t.links = [...(t.links ?? []), { label: conv.where, url: conv.url, at: Date.now() }];
      waitOn(t, `${conv.where}：review、流水线、合并`, [{ type: "message", conv }]);
      endQuestions(t, "提了 MR，在等它");
      break;
    }
    case "question":
      askUser(t, String(b.question || b.summary || "需要你决定"));
      break;
    case "blocked": {
      const h = b.human ?? {};
      // A decision or a value asked through the tools is a question: the ones a worker asks while earlier ones are still
      // open go in the same board item, since it can't go on until the user answered them all (the user's ask:
      // "反正都要我一次性做完了才继续"). Steps to do (sign in, a secret) stay items of their own.
      const asks = b.replace === false && (h.handBack?.kind === "choice" || h.handBack?.kind === "value");
      if (asks) {
        const q: Omit<Question, "id"> = {
          title: String(h.title || "要你决定"),
          kind: h.handBack.kind,
          options: h.handBack.kind === "choice" ? h.handBack.options : undefined,
          multi: h.handBack.kind === "choice" ? h.handBack.multi : undefined,
          label: h.handBack.kind === "value" ? h.handBack.label : undefined,
          steps: h.steps ? String(h.steps) : undefined,
        };
        const open = s.tasks.find((x) => x.owner === "human" && x.askedBy === t.id && x.status === "todo" && x.handBack?.kind === "questions");
        if (open) {
          const qs = open.questions ?? [];
          qs.push({ ...q, id: String(qs.length + 1) });
          Object.assign(open, { questions: qs, title: `${t.title}：${qs.filter((x) => !x.dropped).length} 个问题要你定`, updatedAt: Date.now() });
          return open;
        }
        const group = newTask(s, {
          askedBy: t.id,
          title: q.title,
          owner: "human",
          handBack: { kind: "questions" },
          questions: [{ ...q, id: "1" }],
          urgent: false, // a decision can wait: it sits under 等你 without a warning mark
        } as any);
        t.blockedBy = [...(t.blockedBy ?? []), group.id];
        return group;
      }
      // A block's latest ask is what counts: earlier steps it asked for and the user hasn't done are replaced. A tool call
      // (replace: false) leaves them: the worker takes back what's moot itself (cancel_human).
      const old = b.replace === false ? [] : s.tasks.filter((x) => x.owner === "human" && x.askedBy === t.id && x.status !== "done" && x.status !== "dropped");
      const human = newTask(s, {
        askedBy: t.id,
        expiresAt: Number(h.expires) > 0 ? Date.now() + Number(h.expires) * 60_000 : undefined,
        title: String(h.title || "人工步骤"),
        owner: "human",
        steps: h.steps ? String(h.steps) : undefined,
        handBack: h.handBack?.kind ? { kind: h.handBack.kind, name: h.handBack.name, label: h.handBack.label, options: h.handBack.options, multi: h.handBack.multi } : { kind: "none" },
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
