// What the code needs to know about the user's way of working, read from their skills (skills/**/*.md,
// {{name: value ; type}} variables, see _vars.ts). This file is only the mapping: which variable names the code
// looks for (Chinese and English names both, so anyone can write their own skill) and the careful default when a
// skill doesn't say: nothing merged or rebased behind anyone's back.

import { list, num, pick, str } from "./_vars";

export type Workflow = {
  /** The repositories tasks are handed out to (skills/…/repos.md): the board's list, the router's choices. */
  repos: string[];
  gitlab: { host: string };
  mr: {
    merge: "auto" | "manual";
    minApprovals: number;
    rebase: "auto" | "manual" | "off";
    rebaseSkipCI: boolean;
    maxRounds: number;
  };
};

export function workflow(ctx: Ctx): Workflow {
  return {
    repos: list(ctx, ["仓库", "repos"]),
    gitlab: { host: str(ctx, ["GitLab", "gitlab"], "gitlab.com") },
    mr: {
      merge: pick(ctx, ["合并", "merge"], { auto: ["自动", "auto"], manual: ["手动", "manual"] }, "manual"),
      minApprovals: num(ctx, ["批准人数", "approvals"], 1),
      rebase: pick(ctx, ["变基", "rebase"], { auto: ["自动", "auto"], manual: ["手动", "manual"], off: ["不做", "off", "no"] }, "manual"),
      rebaseSkipCI: pick(ctx, ["变基跑流水线", "rebase pipeline"], { run: ["跑", "run", "yes"], skip: ["跳过", "skip", "no"] }, "run") === "skip",
      maxRounds: num(ctx, ["最多轮数", "max rounds"], 3),
    },
  };
}
