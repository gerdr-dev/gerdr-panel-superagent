# 开发

[← README](../README.md)

改列表和任务、页面和函数的代码之前，先读 [DESIGN.md](../DESIGN.md)。

在单独的克隆里改（这个仓库），提交、推送；装了它的项目用 `gerdr panel update` 更新，你在 `user/` 里的数据和设置不受影响。
不要在装好的面板目录里直接改代码：那是用的，不是改的。

---

改列表和任务（`ui/src/components/CodeSection.tsx`、`local/tasks.ts` `board.ts` `waits.ts`）之前先读 `DESIGN.md`：为什么这么设计、哪些做法试过被否了。
点开一个任务就是它 worker 的对话，在 Code 的分屏里，没有单独的动态：为什么见 `DESIGN.md` 的「一个任务一个 worker」。
秘书就是秘书会话本身的对话，也在 Code 的分屏里打开，为什么见 `DESIGN.md` 的「秘书」。

这个面板只有一页：Gerdr 的 Code（`ui/src/layout.tsx` 用 `CodeView list="replace"`），左边的列表是 `ui/src/components/CodeSection.tsx` 画的。
最上面「秘书」打开秘书的对话（会话、系统提示词和压缩在 `local/_main.ts`，简报这些调的函数在 `local/secretary.ts`），
你自己开的对话怎么成为任务在 `local/blank.ts`，从 Code 导入在 `local/import.ts`，「去向」看外面来的每条消息去了哪。任务都是派给 agent 的（worker 要用户做的步骤、要他定的事挂在它自己的任务上，不另成任务），按「待办 / 进行中 / 待验收 / 已完成」分组（等你的在进行中里排最前、标黄），
数据在 `user/data/reqs/`（每部分一个文件，`local/_parts.ts`；完成很久的移到 `user/data/archive/`，`local/_archive.ts`），读写都走 `local/_store.ts`。秘书那一行的齿轮是面板设置：「设置」（`ui/src/settings/Settings.tsx`，`user/settings.json`）、「流程」（`ui/src/settings/Flow.tsx`，
编辑 `skills/superagent-panel/`）和「定时任务」（`ui/src/settings/Schedules.tsx`，`schedules/`）。
