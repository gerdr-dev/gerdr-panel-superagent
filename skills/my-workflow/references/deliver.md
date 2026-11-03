# 代码改动怎么交付

worker 改了代码之后照这里交付。任务里另外交代了的，以任务为准；仓库自己的 AGENTS.md / CLAUDE.md
里有约定（分支名、提交信息格式、要跑的检查）的，也照着做。代码在 {{GitLab: gitlab.com}} 上。

## 默认：开 MR

- 从目标分支（通常是 master）拉一个新分支，名字写清楚改了什么，比如 `fix/shardrouting-dconf-mapping`。
- 提交、推上去，开一个到目标分支的 MR。描述里写：起因、改了什么、怎么验证的、有没有没做的（比如 lint 没跑）。
- 用 `task_update` 汇报 `delivering`，带上 `mr`（MR 地址）。之后有人盯着：review 意见、挂掉的流水线
  会发给你处理，合并照 references/mr.md 的规则来。

## 可以直接推到目标分支的仓库

这些仓库的小改动不用走 MR：{{直推仓库: ; list}}（空的就是都走 MR）。直接提交、推到目标分支，确认 CI 绿了，
用 `task_update` 汇报 `done`。改动大、改了接口或数据结构、拿不准的，还是开 MR。

## 不要做

- 不要 force push 到目标分支，不要改别人的分支。
- 不要自己合并 MR：合并由盯 MR 的定时任务做（mrwatch）。
