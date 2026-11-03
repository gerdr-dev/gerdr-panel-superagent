// The 定时任务 page's edits: schedules/<id>.json is the user's file (when things run is their choice), this only
// rewrites its timing, keeping everything else in it. How the runs went comes from Gerdr (/api/work/schedules).

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** { id, every? , at? } — exactly one of every ("30s", "5m", "6h", "1d"; at least 10s) and at ("09:00,16:00"). */
export function setTiming(input: { id: string; every?: string; at?: string }, ctx: Ctx) {
  if (!NAME.test(input.id)) throw new Error("定时任务的 id 不对");
  const p = `schedules/${input.id}.json`;
  const st = ctx.fs.stat(p);
  if (!st) throw new Error(`没有 ${p}`);
  const s = JSON.parse(ctx.fs.read(p));
  delete s.every;
  delete s.at;
  if (input.at?.trim()) s.at = input.at.trim();
  else if (input.every?.trim()) s.every = input.every.trim();
  else throw new Error("要写 every（比如 5m）或 at（比如 09:00）");
  // Gerdr checks the timing when it reads the folder; a bad one stops the whole folder, so check here first
  if (s.every && !/^\d+(s|m|h|d)$/.test(s.every)) throw new Error("间隔写成 30s、5m、6h、1d（最短 10s）");
  if (s.every && /^\d+s$/.test(s.every) && Number(s.every.slice(0, -1)) < 10) throw new Error("最短 10s");
  if (s.every && /^0+[mhd]$/.test(s.every)) throw new Error("间隔不能是 0");
  if (s.at && !s.at.split(",").every((x: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(x.trim()))) throw new Error("时间写成 09:00，几个用逗号隔开");
  return ctx.fs.write(p, JSON.stringify(s, null, 2) + "\n", { etag: st.etag });
}
