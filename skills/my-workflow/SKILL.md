---
name: my-workflow
description: 用户本人的工作方式：派活怎么挑仓库和模型、代码改完怎么交付（开 MR 还是直推）、开了 MR 之后怎么跟到底（review、流水线、谁来合、合并后）、主动工作接哪些事、有一步得用户亲手做时怎么交给他（不在对话里问）。做看板派的任务、改完代码要交付、收到 MR 的新情况、需要用户动手时先读这里。
---

# 我的工作方式

这是用户自己写的规则。任务里另外交代了的，以任务为准；仓库自己的 AGENTS.md / CLAUDE.md 里有约定的，也照着做。

下面每份参考都按需读，用不上的不用看。用哪个模型、有哪些仓库这类值是看板的「设置」，
不在这里：要用到时，派活的消息里会写给你。

| 参考 | 什么时候看 |
|---|---|
| [references/board.md](references/board.md) | 你是看板派出去的 worker 时：每次停下怎么汇报、等别人（同事回话、job 跑完）怎么等、你开的会话来问问题时怎么办 |
| [references/activity.md](references/activity.md) | 和队友一起做一个需求时：需求的活动里记什么、记多细（`post_progress`、`tell` 的 `summary`） |
| [references/dispatch.md](references/dispatch.md) | 你是 Superagent 的调度会话时：外面来的消息接不接、怎么派 |
| [references/routing.md](references/routing.md) | 派活的时候：怎么挑仓库，什么时候换更强或更便宜的模型 |
| [references/deliver.md](references/deliver.md) | 改完代码、要交付的时候：开 MR 还是直推，做完怎么汇报 |
| [references/mr.md](references/mr.md) | 开了 MR 之后：怎么盯着它、review 意见 / 流水线 / 冲突怎么处理、谁来合、合并之后做什么 |
| [references/proactive.md](references/proactive.md) | Superagent 判断「不是找我的」事要不要主动接的时候 |
| [references/human.md](references/human.md) | 有一步得我亲手做的时候（点授权、建账号、在后台开开关、交密码） |
