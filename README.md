# Superagent

[Gerdr](https://github.com/gerdr-dev/gerdr) 的一个面板：帮你接外面的活。

<p align="center"><img src="docs/images/superagent.gif" alt="Slack 上来活，秘书接进待办，派出去，几个小时后点发送" width="100%" /></p>

飞书 / Slack 上有人找你，秘书把活接进待办；你补一句备注、点「派出去」，接着做自己的事。要找运维开权限、找负责人合代码，
worker 自己发消息、自己等；几个小时后做完了才叫你：看一眼它的汇报，点「发送」。

*A [Gerdr](https://github.com/gerdr-dev/gerdr) panel: the secretary takes in messages from outside and lines up tasks for Claude Code / Codex workers; you talk to each worker directly, and the panel waits on people for them. The UI is in Chinese for now.*

## 它做什么

- **秘书：接消息、排任务**。Slack / 飞书私信、@ 你的、告警先到它：建任务、并进已有任务，还是不接，每条去了哪在「去向」里看。你一句话交代的事，它挑仓库和 agent（Claude Code / Codex）派出去。
- **一个任务一个 worker，你直接跟它谈**。任务按「待办 / 进行中 / 待验收 / 已完成」分组，点开就是 worker 的对话。它上下文最全，具体的事不经过秘书转述；要你拍板或亲手做一步的，标黄排最前。
- **面板替 worker 等**。等审批、等 MR 的 review 和合并、等同事回话，worker 说清等什么就停下，到了面板叫醒它；Gerdr 重启、换 agent 都不丢。
- **记忆**。长期按仓库记规矩（走不走 MR、谁来合、发布找谁批），中期按人记谁在等什么；秘书靠它把没头没尾的消息交给对的任务。
- **按你的规矩来**。「流程」用你自己的话写做事方式；Let it go 按时间决定哪些事可以不问你；回同事的话先变成待发送卡片，你看过再发。

## 安装

Gerdr 设置 → 面板 → 从 GitHub 安装面板，填 `https://github.com/gerdr-dev/gerdr-panel-superagent`。
更多面板：GitHub 上带 [`gerdr-panel`](https://github.com/topics/gerdr-panel) 标签的仓库。

## 更多

- [功能细节](docs/features.md)：任务怎么分组、外面来的活怎么分、MR、Let it go、设置 / 流程 / 记忆
- [秘书](docs/secretary-and-assistant.md)：秘书做什么（包括改面板的设置、流程），面板的代码谁改。**你是这个面板里的 agent，就接着读这篇**
- [开发](docs/development.md)：在哪改、代码在哪（改之前先读 [DESIGN.md](DESIGN.md)）
