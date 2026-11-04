// What the code needs to know about the user's way of working, read from their skills (skills/**/*.md,
// {{name: value ; type}} variables, see _vars.ts). This file is only the mapping: which variable names the code
// looks for (Chinese and English names both, so anyone can write their own skill) and the careful default when a
// skill doesn't say: nothing merged or rebased behind anyone's back.

import { list, num, pick, str } from "./_vars";

export type Workflow = {
  /** The repositories tasks are handed out to (skills/…/repos.md): the board's list, the router's choices. */
  repos: string[];
  gitlab: { host: string };
  /** Who runs the routing conversation and the workers (skills/…/models.md); "" = Gerdr's default. */
  router: Who;
  worker: Who;
  /**
   * Work nobody asked for (events a trigger marks inferred): off, observe (judged and recorded, not done: dsh's
   * observe mode, the default) or on. The rules themselves are the prose in skills/…/proactive.md.
   */
  proactive: "off" | "observe" | "on";
  mr: {
    merge: "auto" | "manual";
    minApprovals: number;
    rebase: "auto" | "manual" | "off";
    rebaseSkipCI: boolean;
    maxRounds: number;
  };
};

export type Who = { agent: string; model: string; effort: string };

export function workflow(ctx: Ctx): Workflow {
  return {
    repos: list(ctx, ["仓库", "repos"]),
    gitlab: { host: str(ctx, ["GitLab", "gitlab"], "gitlab.com") },
    router: {
      agent: str(ctx, ["派活 agent", "router agent"], ""),
      model: str(ctx, ["派活模型", "router model"], ""),
      effort: str(ctx, ["派活思考强度", "router effort"], ""),
    },
    worker: {
      agent: str(ctx, ["干活 agent", "worker agent"], ""),
      model: str(ctx, ["干活模型", "worker model"], ""),
      effort: str(ctx, ["干活思考强度", "worker effort"], ""),
    },
    proactive: pick(ctx, ["主动工作", "proactive"], { off: ["关", "off"], observe: ["只记录", "observe"], on: ["照做", "on"] }, "observe"),
    mr: {
      merge: pick(ctx, ["合并", "merge"], { auto: ["自动", "auto"], manual: ["手动", "manual"] }, "manual"),
      minApprovals: num(ctx, ["批准人数", "approvals"], 1),
      rebase: pick(ctx, ["变基", "rebase"], { auto: ["自动", "auto"], manual: ["手动", "manual"], off: ["不做", "off", "no"] }, "manual"),
      rebaseSkipCI: pick(ctx, ["变基跑流水线", "rebase pipeline"], { run: ["跑", "run", "yes"], skip: ["跳过", "skip", "no"] }, "run") === "skip",
      maxRounds: num(ctx, ["最多轮数", "max rounds"], 3),
    },
  };
}
