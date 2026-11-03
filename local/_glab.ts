import { workflow } from "./_config";

/** The GitLab glab talks to: workflow.json gitlab.host (each user their own). */
export function host(ctx: any) {
  return workflow(ctx).gitlab.host;
}

export async function get(endpoint: string, ctx: any) {
  let result: any;
  try {
    result = await ctx.exec("glab", ["api", "--hostname", host(ctx), "--method", "GET", endpoint], { timeout: 60_000 });
  } catch (error: any) {
    throw new Error(`无法运行 glab：${error.message || error}。请确认已安装 glab，且当前网络可访问 GitLab。`);
  }
  if (result.code !== 0) {
    if (/401|unauthorized|authentication|auth login|not logged|token.*expired/i.test(result.stderr)) {
      throw new Error(`GitLab 登录已失效，请运行 glab auth login --hostname ${host(ctx)} 后重试。`);
    }
    throw new Error(`glab 查询失败（退出码 ${result.code}）：${result.stderr.trim().slice(0, 600) || "请检查网络或 GitLab 权限"}`);
  }
  if (result.truncated) throw new Error("glab 输出超过运行时上限，请缩小查询范围后重试。");
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("GitLab 返回的内容不是有效 JSON，请检查 glab 登录和网络状态。"); }
}

async function call(args: string[], ctx: any) {
  let result: any;
  try {
    result = await ctx.exec("glab", ["api", "--hostname", host(ctx), ...args], { timeout: 60_000 });
  } catch (error: any) {
    throw new Error(`无法运行 glab：${error.message || error}`);
  }
  if (result.code !== 0) throw new Error(`glab ${args.slice(0, 3).join(" ")} 失败（退出码 ${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 600)}`);
  return result.stdout as string;
}

/** A write: PUT / POST with form fields (rebase, merge). Returns the parsed reply, or the text when it isn't JSON. */
export async function send(method: "PUT" | "POST", endpoint: string, fields: Record<string, string>, ctx: any) {
  const args = ["--method", method, endpoint];
  for (const [k, v] of Object.entries(fields)) args.push("-f", `${k}=${v}`);
  const out = await call(args, ctx);
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/** A GET whose answer is text, not JSON (a job's log). */
export async function text(endpoint: string, ctx: any) {
  return call(["--method", "GET", endpoint], ctx);
}
