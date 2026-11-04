---
name: my-workflow
description: 用户本人的工作方式：派活挑哪些仓库、用哪个 agent 和模型、代码改完怎么交付（开 MR 还是直推）、MR 上来了 review 意见 / 流水线失败 / 冲突怎么处理、什么时候自动合并、有一步得用户亲手做时怎么交给他（不在对话里问）。做看板派的任务、改完代码要交付、收到 MR 的新情况、需要用户动手时先读这里。
---

# 我的工作方式

这是用户自己写的规则。任务里另外交代了的，以任务为准；仓库自己的 AGENTS.md / CLAUDE.md 里有约定的，也照着做。

下面每份参考都按需读，用不上的不用看。参考里的 `{{名字: 值 ; 类型}}` 是可调的设置：冒号后面就是当前值，
照这个值做（比如 `{{合并: 自动 ; 自动 | 手动}}` 就是自动合并）。

| 参考 | 什么时候看 |
|---|---|
| [references/repos.md](references/repos.md) | 派活、挑仓库的时候：我有哪些仓库 |
| [references/models.md](references/models.md) | 派活、挑 agent 和模型的时候：Superagent 的调度会话和 worker 各用哪个 |
| [references/deliver.md](references/deliver.md) | 改完代码、要交付的时候：开 MR 还是直推，做完怎么汇报 |
| [references/mr.md](references/mr.md) | MR 来了新的 review 意见、流水线挂了、有冲突的时候；也写了自动合并、变基的规则 |
| [references/proactive.md](references/proactive.md) | Superagent 判断「不是找我的」事要不要主动接的时候：规则和现在的模式 |
| [references/human.md](references/human.md) | 有一步得我亲手做的时候（点授权、建账号、在后台开开关、交密码） |
