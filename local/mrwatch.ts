import { get, text } from "./_glab";
import { load, type Task } from "./_store";
import { open } from "./_waits";
import { DATA } from "./_user";

// A source of events for the MRs tasks follow — nothing more. An MR is a way of working (the worker's skill, mr.md:
// how to answer a review, when to rebase, when it may merge) plus what happens on it; neither is the board's to decide.
// Until 2026-11-04 this watcher was a process of its own: tasks went "delivering", it rebased and merged by settings,
// asked the user after too many rounds, and marked the task done when the MR merged — t30 still had a prod release to
// run when it did. Now it only says what happened, and the worker, woken by it, decides.
//
// Run on a schedule (schedules/mrwatch.json). Which MRs: every one a live task follows (its threads: a worker that
// opened an MR waits on it with wait_for, so the task follows gitlab / group/repo!34). What it emits, each once, as
// events of that conversation (source gitlab, key group/repo!34): mr.review (new comments by others), pipeline.failed,
// pipeline.passed, mr.conflict, mr.need_rebase, mr.mergeable (GitLab says it can be merged now), mr.merged, mr.closed.
// triggers/mr.json → inbox.onEvent delivers them to the task's worker like any follow-up (去向 logs it; hand_back if
// it isn't that task's). What it already emitted is kept in user/data/mrwatch.json.

const STATE = `${DATA}/mrwatch.json`;
const NOTE_MAX = 1500;

type Seen = {
  /** When this watcher first saw it: comments before then were the worker's to see already. */
  since: number;
  notes: number[];
  /** "<pipeline id>:<status>" already told; the head sha a conflict / rebase / mergeable was told for. */
  pipeline?: string;
  conflict?: string;
  rebase?: string;
  mergeable?: string;
  /** merged / closed told: nothing more comes from it. */
  ended?: string;
  checked?: number;
  /** GitLab's last word on it (for the dry run and the log). */
  state?: string;
};
type State = Record<string, Seen>;

function readState(ctx: Ctx): State {
  try {
    return ctx.fs.stat(STATE) ? JSON.parse(ctx.fs.read(STATE)) : {};
  } catch {
    return {};
  }
}

function writeState(ctx: Ctx, s: State) {
  ctx.fs.mkdir(DATA);
  ctx.fs.write(STATE, JSON.stringify(s, null, 2) + "\n");
}

const KEY = /^(.+)!(\d+)$/;

/** The MRs live tasks follow: gitlab conversations named group/repo!34. */
function followed(tasks: Task[]): string[] {
  const out = new Set<string>();
  for (const t of tasks) {
    if (t.status === "done" || t.status === "dropped") continue;
    for (const th of t.threads ?? []) if (th.source === "gitlab" && KEY.test(th.key)) out.add(th.key);
  }
  return [...out];
}

// dry: say what would be emitted instead of emitting (check)
let dry = false;
let waited = new Set<string>();
const would: string[] = [];

/** One pass over every MR a live task follows. Returns what it emitted, per MR (the run log shows it). */
export async function tick(input: unknown, ctx: Ctx) {
  dry = false;
  const tasks = load(ctx).store.tasks;
  const keys = followed(tasks);
  // MRs a worker is waiting on now (wait_for): news from them is told even when it's from before the first look
  waited = new Set(tasks.flatMap((t) => open(t).filter((w) => w.on?.source === "gitlab").map((w) => w.on!.key)));
  const st = readState(ctx);
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (st[key]?.ended) continue;
    try {
      out[key] = await one(key, st, ctx);
    } catch (e: any) {
      out[key] = `error: ${e.message || e}`;
      ctx.log(`${key}: ${e.message || e}`);
    }
  }
  // Forget MRs nobody follows any more
  for (const k of Object.keys(st)) if (!keys.includes(k)) delete st[k];
  writeState(ctx, st);
  return { watched: keys.length, did: out };
}

/** What it would emit for one MR now, changing nothing: { url } (any MR) — for trying it on a real one. */
export async function check(input: { url: string }, ctx: Ctx) {
  const m = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/.exec(input?.url ?? "");
  if (!m) throw new Error("url 要是 MR 地址");
  dry = true;
  const key = `${m[1]}!${m[2]}`;
  const cur = readState(ctx)[key];
  const copy: State = { [key]: cur ? { ...cur } : { since: Date.now() - 86_400_000, notes: [] } };
  try {
    return await one(key, copy, ctx);
  } finally {
    dry = false;
  }
}

type Out = { id: string; kind: string; actor?: string; title: string; text: string; url?: string };

async function one(key: string, st: State, ctx: Ctx): Promise<string> {
  const [, project, iidS] = KEY.exec(key)!;
  const iid = Number(iidS);
  const base = `projects/${encodeURIComponent(project)}/merge_requests/${iid}`;
  const first = !st[key];
  const seen: Seen = (st[key] ??= { since: Date.now(), notes: [] });
  const mr = await get(base, ctx);
  // Merged / closed before this watcher ever looked, and nobody waits on it: old news (a task's earlier MR), not told
  if (first && (mr.state === "merged" || mr.state === "closed") && !waited.has(key) && !dry) {
    seen.ended = mr.state;
    return `${mr.state} before the first look, nobody waiting: not told`;
  }
  const label = `MR !${iid}`;
  const url: string = mr.web_url;
  const state: string = mr.detailed_merge_status ?? mr.merge_status ?? "";
  const pipe = mr.head_pipeline as { id: number; status: string; web_url: string } | null;
  seen.checked = Date.now();
  seen.state = `${mr.state} / ${state}${pipe ? ` / pipeline ${pipe.status}` : ""}`;
  const said: string[] = [];
  const say = (e: Out) => {
    said.push(e.kind);
    if (dry) return void would.push(`${e.kind}: ${e.title}`);
    ctx.events.emit({ ...e, source: "gitlab", key, data: { project, iid, mr: url, state, pipeline: pipe?.status } });
  };
  const done = () => (dry ? `would: ${would.splice(0).join("; ") || "nothing"} (${seen.state})` : said.join(", ") || "nothing new");

  if (mr.state === "merged") {
    say({
      id: `gitlab:merged:${key}`,
      kind: "mr.merged",
      actor: mr.merged_by?.username,
      title: `${label} 合并了`,
      text: `${label} 合并进 ${mr.target_branch} 了${mr.merged_by?.username ? `（${mr.merged_by.username} 合的）` : ""}${mr.merge_commit_sha ? `，merge commit ${String(mr.merge_commit_sha).slice(0, 10)}` : ""}。${url}`,
      url,
    });
    seen.ended = "merged";
    return done();
  }
  if (mr.state === "closed") {
    say({ id: `gitlab:closed:${key}`, kind: "mr.closed", actor: mr.closed_by?.username, title: `${label} 被关掉了（没合并）`, text: `${label} 被关掉了，没有合并。${url}`, url });
    seen.ended = "closed";
    return done();
  }

  // New comments by others since it was first seen
  const me = (await get("user", ctx)).username as string;
  const discussions: any[] = await get(`${base}/discussions?per_page=100`, ctx);
  const known = new Set(seen.notes);
  const fresh = discussions
    .flatMap((x) => (x.notes ?? []).map((n: any) => ({ ...n, thread: x.id })))
    .filter((n) => !n.system && n.author?.username !== me && !known.has(n.id) && Date.parse(n.created_at) >= seen.since - 60_000);
  if (fresh.length) {
    const lines = fresh.map((n, i) => {
      const where = n.position?.new_path ? ` 在 ${n.position.new_path}${n.position.new_line ? `:${n.position.new_line}` : ""}` : "";
      return `${i + 1}. @${n.author?.username}${where}${n.resolvable ? (n.resolved ? "（已解决）" : "（未解决）") : ""}：\n${String(n.body ?? "").slice(0, NOTE_MAX)}\n${url}#note_${n.id}`;
    });
    say({
      id: `gitlab:review:${key}:${fresh.map((n) => n.id).join(",")}`,
      kind: "mr.review",
      actor: fresh[0].author?.username,
      title: `${label} 有 ${fresh.length} 条新意见`,
      text: lines.join("\n\n"),
      url: `${url}#note_${fresh[0].id}`,
    });
    if (!dry) seen.notes = [...seen.notes, ...fresh.map((n) => n.id)];
  }

  // The head pipeline finished: failed (with the end of the failed jobs' logs) or passed
  const pkey = pipe ? `${pipe.id}:${pipe.status}` : "";
  if (pipe && (pipe.status === "failed" || pipe.status === "success") && seen.pipeline !== pkey) {
    if (pipe.status === "failed") {
      const jobs: any[] = await get(`projects/${encodeURIComponent(project)}/pipelines/${pipe.id}/jobs?scope[]=failed&per_page=20`, ctx);
      const logs: string[] = [];
      for (const j of jobs.slice(0, 2)) {
        const trace = await text(`projects/${encodeURIComponent(project)}/jobs/${j.id}/trace`, ctx).catch(() => "");
        logs.push(`### ${j.name}（job ${j.id}，${j.web_url}）\n\`\`\`\n${trace.split("\n").slice(-60).join("\n")}\n\`\`\``);
      }
      const names = jobs.map((j) => j.name).join("、") || "（没拿到 job）";
      say({ id: `gitlab:pipeline:${project}:${pipe.id}:failed`, kind: "pipeline.failed", title: `${label} 的流水线挂了`, text: `失败的 job：${names}。${pipe.web_url}\n\n${logs.join("\n\n")}`, url: pipe.web_url });
    } else {
      say({ id: `gitlab:pipeline:${project}:${pipe.id}:success`, kind: "pipeline.passed", title: `${label} 的流水线过了`, text: `${label} 的流水线过了。${pipe.web_url}`, url: pipe.web_url });
    }
    if (!dry) seen.pipeline = pkey;
  }

  // Once per head commit: conflicts, behind the target, mergeable
  if ((mr.has_conflicts || state === "conflict") && seen.conflict !== mr.sha) {
    say({ id: `gitlab:conflict:${key}:${mr.sha}`, kind: "mr.conflict", title: `${label} 和 ${mr.target_branch} 有冲突`, text: `${label} 和 ${mr.target_branch} 有冲突。${url}`, url });
    if (!dry) seen.conflict = mr.sha;
  } else if (state === "need_rebase" && seen.rebase !== mr.sha) {
    say({ id: `gitlab:need_rebase:${key}:${mr.sha}`, kind: "mr.need_rebase", title: `${label} 要变基`, text: `${label} 落后 ${mr.target_branch}，GitLab 要先变基才能合。${url}`, url });
    if (!dry) seen.rebase = mr.sha;
  } else if (state === "mergeable" && seen.mergeable !== mr.sha) {
    const ap = await get(`${base}/approvals`, ctx).catch(() => null);
    const by = (ap?.approved_by ?? []).map((a: any) => a.user?.username).filter(Boolean);
    say({
      id: `gitlab:mergeable:${key}:${mr.sha}`,
      kind: "mr.mergeable",
      title: `${label} 可以合并了`,
      text: `GitLab 说 ${label} 现在可以合并（流水线、讨论、它自己的批准规则都满足了）。批准的人：${by.length ? by.join("、") : "没有"}。${url}`,
      url,
    });
    if (!dry) seen.mergeable = mr.sha;
  }
  return done();
}
