import { get, send, text } from "./_glab";
import { find, load, note, update, type Delivery, type Task } from "./_store";
import { workflow } from "./_config";
import { mrThread } from "./_apply";

// Follows the MRs that board tasks went out in (status "delivering", see tasks.ts) until they're merged. Run on a
// schedule (schedules/mrwatch.json), all deterministic: it reads GitLab and decides by its fields. What needs
// judgement (new review comments, a failed pipeline, conflicts) it doesn't hand to anyone itself: it's a source, and
// emits it as an event (gitlab/mr.review, gitlab/pipeline.failed, gitlab/mr.conflict, key group/repo!34). The task
// follows its MR's conversation (threads, set when it reported delivering: _apply.ts), so triggers/mr.json →
// inbox.onEvent delivers it to the worker like any follow-up — logged in 去向, given back with hand_back if it isn't
// that task's. dsh-superagent's GitHub source works the same way for pull requests. The handling rules are in the
// user's skill (the worker has it; this only says what happened). Rebasing and merging follow
// the values in that skill (_config.ts): automatic, or waiting for the user's button (rebase / mergeNow below). Merged → the task is done and
// its worker parked. A closed MR, or more review rounds than mr.maxRounds, goes to the user (the task's question:
// the board's "needs you").
//
// It never hands the same thing twice: notes already handed, the pipeline and the sha already acted on are kept on
// the task (delivery.seen / pipeline / conflict / rebased).

const NOTE_MAX = 1500;

type Change = Partial<Delivery> & { question?: string; done?: boolean; summary?: string };

/** One pass over every delivering task. Returns what it did, per task (the run log shows it). */
export async function tick(input: { dry?: boolean } | undefined, ctx: Ctx) {
  dry = !!input?.dry;
  const tasks = load(ctx).store.tasks.filter((t) => t.status === "delivering" && t.delivery?.kind === "mr");
  if (!tasks.length) return { watched: 0 };
  if (!dry) follow(tasks, ctx);
  const me = (await get("user", ctx)).username as string;
  const out: Record<string, string> = {};
  for (const t of tasks) {
    try {
      out[t.id] = await one(t, me, ctx);
    } catch (e: any) {
      out[t.id] = `error: ${e.message || e}`;
      ctx.log.warn(`${t.id}: ${e.message || e}`);
    }
  }
  return { watched: tasks.length, did: out };
}

/**
 * The same for one task now: { id }. With { url, dry: true } it reads any MR and says what it would do, changing
 * nothing (no rebase, merge, message or write): for trying the rules on a real MR.
 */
export async function check(input: { id?: string; url?: string; dry?: boolean }, ctx: Ctx) {
  dry = !!input.dry;
  let t: Task;
  if (input.url) {
    const m = /^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(input.url);
    if (!m || !dry) throw new Error("url 要是 MR 地址，而且只能和 dry: true 一起用");
    t = { id: "dry", title: "dry", owner: "agent", status: "delivering", session: undefined, createdAt: 0, updatedAt: 0, delivery: { kind: "mr", url: m[0], project: m[2], iid: Number(m[3]), since: 0, seen: [] } } as Task;
  } else {
    t = find(load(ctx).store, input.id ?? "");
    if (t.status !== "delivering" || !t.delivery) throw new Error(`${t.id} 没有在等合并的 MR`);
  }
  return one(t, (await get("user", ctx)).username, ctx);
}

// dry: say what would be done instead of doing it (check({ dry: true }))
let dry = false;
const would: string[] = [];
async function act<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (dry) {
    would.push(what);
    return undefined;
  }
  return fn();
}

async function one(t: Task, me: string, ctx: Ctx): Promise<string> {
  const d = t.delivery!;
  const base = `projects/${encodeURIComponent(d.project)}/merge_requests/${d.iid}`;
  const mr = await get(base, ctx);
  const state: string = mr.detailed_merge_status ?? mr.merge_status ?? "";
  const pipe = mr.head_pipeline as { id: number; status: string; web_url: string } | null;
  const label = `MR !${d.iid}`;
  const save = (c: Change, what: string) => {
    if (dry) return `${what} — would: ${would.splice(0).join("; ") || "nothing"} (state ${state}, pipeline ${pipe?.status ?? "none"}, card: ${c.detail ?? c.question ?? ""})`;
    apply(t.id, { state, checked: Date.now(), ...c }, ctx);
    return what;
  };

  if (mr.state === "merged") {
    if (t.session) await act("close the worker", () => ctx.sessions.close(t.session!).catch(() => {}));
    return save({ done: true, summary: t.summary }, "merged");
  }
  if (mr.state === "closed") return save({ question: `${label} 被关掉了（没合并）。要重开、换个方案，还是放弃这个任务？`, detail: "MR 已关闭" }, "closed");

  const sess = t.session ? ctx.sessions.get(t.session) : null;
  const busy = sess?.status === "running" || sess?.status === "starting";

  // 1. New review comments, by others, since it was handed over
  const discussions: any[] = await get(`${base}/discussions?per_page=100`, ctx);
  const seen = new Set(d.seen ?? []);
  const fresh = discussions
    .flatMap((x) => (x.notes ?? []).map((n: any) => ({ ...n, thread: x.id })))
    .filter((n) => !n.system && n.author?.username !== me && !seen.has(n.id) && Date.parse(n.created_at) >= d.since - 60_000);
  if (fresh.length) {
    const ids = [...seen, ...fresh.map((n) => n.id)];
    const rounds = (d.rounds ?? 0) + 1;
    const max = workflow(ctx).mr.maxRounds;
    if (rounds > max)
      return save({ seen: ids, question: `${label} 已经改了 ${max} 轮，又来了 ${fresh.length} 条意见。还要它接着改，还是你来看看？（${d.url}）`, detail: "改了几轮还没过" }, "too many rounds");
    const lines = fresh.map((n, i) => {
      const where = n.position?.new_path ? ` 在 ${n.position.new_path}${n.position.new_line ? `:${n.position.new_line}` : ""}` : "";
      const body = String(n.body ?? "").slice(0, NOTE_MAX);
      return `${i + 1}. @${n.author?.username}${where}${n.resolvable ? (n.resolved ? "（已解决）" : "（未解决）") : ""}：\n${body}\n${d.url}#note_${n.id}`;
    });
    const first = fresh[0];
    await act(`emit ${fresh.length} notes: ${fresh.map((n) => n.id).join(",")}`, async () =>
      emit(ctx, d, {
        id: `gitlab:review:${d.project}!${d.iid}:${fresh.map((n) => n.id).join(",")}`,
        kind: "mr.review",
        actor: first.author?.username,
        title: `${label} 有 ${fresh.length} 条新意见`,
        text: `${lines.join("\n\n")}\n\n${playbook(ctx)}`,
        url: `${d.url}#note_${first.id}`,
      }),
    );
    return save({ seen: ids, rounds, detail: `${fresh.length} 条新意见已交给 worker` }, `handed ${fresh.length} notes`);
  }

  // 2. The pipeline of the current head failed
  if (pipe?.status === "failed" && d.pipeline !== pipe.id) {
    const jobs: any[] = await get(`projects/${encodeURIComponent(d.project)}/pipelines/${pipe.id}/jobs?scope[]=failed&per_page=20`, ctx);
    const logs: string[] = [];
    for (const j of jobs.slice(0, 2)) {
      const trace = await text(`projects/${encodeURIComponent(d.project)}/jobs/${j.id}/trace`, ctx).catch(() => "");
      logs.push(`### ${j.name}（job ${j.id}，${j.web_url}）\n\`\`\`\n${trace.split("\n").slice(-60).join("\n")}\n\`\`\``);
    }
    const names = jobs.map((j) => j.name).join("、") || "（没拿到 job）";
    await act(`emit failed pipeline ${pipe.id}`, async () =>
      emit(ctx, d, {
        id: `gitlab:pipeline:${d.project}:${pipe.id}`,
        kind: "pipeline.failed",
        title: `${label} 的流水线挂了`,
        text: `失败的 job：${names}。${pipe.web_url}\n\n${logs.join("\n\n")}\n\n${playbook(ctx)}`,
        url: pipe.web_url,
      }),
    );
    return save({ pipeline: pipe.id, detail: `流水线挂了（${names}），已交给 worker` }, "handed failed pipeline");
  }

  // 3. Conflicts: the worker resolves them (once per head commit)
  if (mr.has_conflicts || state === "conflict") {
    if (d.conflict === mr.sha) return save({ detail: "有冲突，worker 在处理" }, "conflict (handed)");
    await act("emit the conflict", async () =>
      emit(ctx, d, {
        id: `gitlab:conflict:${d.project}!${d.iid}:${mr.sha}`,
        kind: "mr.conflict",
        title: `${label} 和 ${mr.target_branch} 有冲突`,
        text: `把 ${mr.target_branch} 合进来或者变基，解决冲突再推。\n\n${playbook(ctx)}`,
        url: d.url,
      }),
    );
    return save({ conflict: mr.sha, detail: "有冲突，已交给 worker" }, "handed conflict");
  }

  // The worker is changing it: don't rebase or merge under it
  if (busy) return save({ detail: "worker 在改" }, "worker busy");

  const cfg = workflow(ctx).mr;

  // 4. Behind the target: rebase (GitLab does it), once per head commit, if workflow.json says so
  if (state === "need_rebase") {
    if (d.rebased === mr.sha) return save({ detail: "变基中" }, "rebasing");
    if (cfg.rebase !== "auto") return save({ detail: cfg.rebase === "manual" ? "要变基（点「变基」）" : "要变基" }, "needs a rebase");
    await act(`rebase${cfg.rebaseSkipCI ? " skip_ci" : ""} (PUT /rebase)`, () => rebaseNow(base, cfg.rebaseSkipCI, ctx));
    return save({ rebased: mr.sha, detail: cfg.rebaseSkipCI ? "变基中（跳过流水线）" : "变基中" }, "rebase requested");
  }

  // 5. Mergeable (GitLab's verdict: pipeline, discussions, its approval rules) with enough approvals: merge, if auto
  if (state === "mergeable") {
    const ap = await get(`${base}/approvals`, ctx);
    if ((ap.approved_by ?? []).length < cfg.minApprovals) return save({ detail: `等人批准（要 ${cfg.minApprovals} 个）` }, "needs approvals");
    if (cfg.merge !== "auto") return save({ detail: "可以合并（点「立即合并」）" }, "mergeable, waiting for the user");
    await act(`merge at ${mr.sha} (PUT /merge)`, () => send("PUT", `${base}/merge`, { sha: mr.sha }, ctx));
    return save({ merging: Date.now(), detail: "合并中" }, "merge requested");
  }

  return save({ detail: describe(state, pipe?.status) }, state);
}

/** What happened on an MR, as an event of its conversation (gitlab, group/repo!34): the task following it gets it. */
function emit(ctx: Ctx, d: Delivery, e: { id: string; kind: string; actor?: string; title: string; text: string; url?: string }) {
  const { key } = mrThread(d.project, d.iid);
  return ctx.events.emit({ ...e, source: "gitlab", key, data: { project: d.project, iid: d.iid, mr: d.url } });
}

/**
 * Tasks that went delivering before tasks followed their MR (threads): made to follow it now, so what this emits
 * reaches them.
 */
function follow(tasks: Task[], ctx: Ctx) {
  const missing = (t: Task) => {
    const th = mrThread(t.delivery!.project, t.delivery!.iid);
    return !(t.threads ?? []).some((x) => x.source === th.source && x.key === th.key);
  };
  if (!tasks.some(missing)) return;
  update(ctx, (s) => {
    for (const x of s.tasks) {
      if (x.status !== "delivering" || x.delivery?.kind !== "mr" || !missing(x)) continue;
      const cur = x.threads ?? (x.origin?.key ? [{ source: x.origin.source, key: x.origin.key }] : []);
      x.threads = [...cur, mrThread(x.delivery.project, x.delivery.iid)];
    }
  });
}

function rebaseNow(base: string, skipCI: boolean, ctx: Ctx) {
  return send("PUT", `${base}/rebase`, skipCI ? { skip_ci: "true" } : {}, ctx);
}

// ---- the user's buttons (the board's chat panel), whatever workflow.json says ----

function deliveringTask(id: string, ctx: Ctx) {
  const t = find(load(ctx).store, id);
  if (t.status !== "delivering" || !t.delivery) throw new Error(`${t.id} 没有在等合并的 MR`);
  return { t, base: `projects/${encodeURIComponent(t.delivery.project)}/merge_requests/${t.delivery.iid}` };
}

/**
 * Merges it now: { id }. No waiting for this watcher's own rules (approvals, auto); GitLab's still apply, so a project
 * that requires a green pipeline refuses while one runs, and the error says so.
 */
export async function mergeNow(input: { id: string }, ctx: Ctx) {
  const { t, base } = deliveringTask(input.id, ctx);
  const mr = await get(base, ctx);
  if (mr.state !== "opened") throw new Error(`MR !${t.delivery!.iid} 已经是 ${mr.state}`);
  try {
    await send("PUT", `${base}/merge`, { sha: mr.sha }, ctx);
  } catch (e: any) {
    const why = `GitLab 不让合并（${mr.detailed_merge_status}）：${String(e.message || e).slice(0, 200)}`;
    apply(t.id, { detail: `合并失败：${why}`, checked: Date.now() }, ctx);
    throw new Error(why);
  }
  apply(t.id, { state: mr.detailed_merge_status, merging: Date.now(), detail: "合并中（你点的）", checked: Date.now() }, ctx);
  return one(find(load(ctx).store, t.id), (await get("user", ctx)).username, ctx);
}

/** Rebases it now: { id, skipCI? } (skipCI defaults to workflow.json mr.rebaseSkipCI). */
export async function rebase(input: { id: string; skipCI?: boolean }, ctx: Ctx) {
  const { t, base } = deliveringTask(input.id, ctx);
  const skip = input.skipCI ?? workflow(ctx).mr.rebaseSkipCI;
  const mr = await get(base, ctx);
  try {
    await rebaseNow(base, skip, ctx);
  } catch (e: any) {
    apply(t.id, { detail: `变基失败：${String(e.message || e).slice(0, 200)}`, checked: Date.now() }, ctx);
    throw e;
  }
  apply(t.id, { rebased: mr.sha, detail: skip ? "变基中（跳过流水线）" : "变基中", checked: Date.now() }, ctx);
  return { ok: true, skipCI: skip };
}

function describe(state: string, pipeline?: string) {
  const ci = pipeline ? `流水线 ${pipeline}` : "流水线";
  return (
    {
      not_approved: "等 review / 批准",
      discussions_not_resolved: "有讨论没解决",
      ci_still_running: `${ci}，等它跑完`,
      ci_must_pass: `${ci}，要过了才能合`,
      draft_status: "还是草稿",
      checking: "GitLab 检查中",
      unchecked: "GitLab 检查中",
      blocked_status: "被别的 MR 挡着",
      jira_association_missing: "缺 Jira 关联",
      requested_changes: "reviewer 要求修改",
    } as Record<string, string>
  )[state] ?? (state || "等待中");
}

// The handling rules are the user's skill, which the worker has: say which situation it is, not paste the rules
function playbook(ctx: Ctx) {
  return "照你的工作流程 skill 处理（MR 那份参考），处理完用 task_update 汇报（delivering，同一个 mr）。";
}

/** Writes what this pass saw onto the task (re-read under the write: the board may have changed it meanwhile). */
function apply(id: string, c: Change, ctx: Ctx) {
  update(ctx, (s) => {
    const t = find(s, id);
    if (t.status !== "delivering" || !t.delivery) return; // accepted / dropped meanwhile
    const { question, done, summary, ...d } = c;
    Object.assign(t.delivery, d);
    if (question && t.question !== question) {
      t.question = question;
      note(t, question);
    }
    if (done) {
      Object.assign(t, { status: "done", doneAt: Date.now(), question: undefined });
      note(t, `MR !${t.delivery.iid} 已合并`);
    }
    t.updatedAt = Date.now();
  });
}
