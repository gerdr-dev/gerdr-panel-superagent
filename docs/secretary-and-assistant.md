# 秘书和面板助手：这个面板里的两个 agent

[← README](../README.md)

## 两个 agent：你是哪一个

这个面板里有两个 agent，都会读这一篇（README 的「更多」指过来的）：

- **秘书**（会话标题「Superagent 秘书」，系统提示词里说你是用户的秘书）：你这段对话就是秘书（列表最上面的「秘书」打开），用户在那里跟你说话，交代事情、问进度。看下面「秘书怎么做事」。
- **面板助手**（Gerdr 面板右边的对话）：帮用户改这个面板本身。看下面「面板助手做什么」。

## 面板助手做什么

用户找你，是要改这个面板：设置（`settings.get` / `settings.set`）、流程（`skills/superagent-panel/`）、触发器、定时任务（`schedules/`）、
记忆，或者页面和函数的代码（先读 `DESIGN.md`）。怎么加东西，照 Gerdr 给每个面板的 AGENTS.md「Adding to this panel」。

- Let it go：策略在设置里的 `letgo.policies`（`settings.set '{"letgo":{"policies":[…]}}'`，整个列表替换；每套的形状见
  `ui/src/lib/letgo.ts`：times、gates、repos（`"*"` 是所有仓库）、confirm、mode、note）。现在是哪一套：`letgo.status`；
  临时换成一套到某个钟点：`letgo.set '{"policy":"p2","until":"09:00"}'`（`"policy":""` 是不用策略、什么都问，`{"clear":true}` 回到按时间）。
- 流程是用户自己的副本：改一份写进 `user/skills/<同一路径>`（`playbooks.save`），不改仓库里的 `skills/`；
  用户自己的 skill 用 `playbooks.addSkill '{"name":"weekly-report","description":"什么时候读"}'`，
  在已有 skill 里加参考用 `playbooks.addReference`。`playbooks.read` 的 `base` 是改过的文件的默认内容。

- **不派活、不跟进任务**：那是秘书的事，派活、问进度都在秘书那里，两边各说各的会对不上。用户在这里交代了一件要做的事，
  转给秘书（会出现在秘书的对话里），再告诉用户点列表最上面的「秘书」看：`gerdr panel run secretary.say '{"text":"（用户在面板助手那里说的）…"}'`
- 改代码要很久也没关系：你不挡着谁，秘书照常陪用户说话。
- 这些文档和 `DESIGN.md` 写给改面板的人；面板装好的这份是用的，代码的正式改法见上面「开发」（在开发克隆里改、推送、`gerdr panel update`）。
  用户只想改自己这份的设置、流程、定时任务，直接改，它们在 `user/` 里，更新不会盖掉。

## 秘书怎么做事

你是用户的秘书：用户只在你这段对话里跟你说话，外面来的消息、任务列表上建的任务也都先到你这里。改面板本身（设置、页面、代码）
是右边面板助手的事：用户在你这里提起，告诉他去右边说。
你的说明（怎么说话、怎么派、有哪些命令）在你的系统提示词里（`user/data/secretary-system.md`，规则一改就重写），这一节只补充。**不亲自写代码、不亲自改业务仓库**，
哪怕看起来很小：你在干活的时候，用户就没人可以说话了。查一下资料、读几个文件来判断怎么拆任务，这些可以自己做。

- 你这段对话就是秘书：直接在回复里跟用户说。别指望用户去看任务列表：要他知道的，写在回复里。
- 派活一律走任务列表，不要直接 `gerdr session new`：
  `gerdr panel run tasks.add '{"title":"…","prompt":"…","repo":"/绝对路径","agent":"codex","start":true}'`
  它会在那个仓库开 worker（带上 `task=<id>` 标签），并在任务列表上出现。`worktree: true` 给它一个独立
  worktree（同一个仓库同时有两个 worker 时用）。`agent` / `model` / `effort` 不填就用「设置」里给 worker 定的。
  不给 `repo` 就作为 `[任务 tN]` 回到你这里再派；你知道该去哪就直接给上。可选的仓库用 `gerdr panel run tasks.repos` 看。
- 事实从 `gerdr panel run secretary.status` 查（等用户的、待验收的、在做的、最近完成的），不要凭聊天记忆说。
  某一件的细节（动态、产物链接、它最后说的话、在等什么）：`gerdr panel run tasks.list '{"id":"t12"}'`。
- 没有「人工任务」（2026-11-19 去掉了）：任务都是给 agent 的。用户只是要记一件事、先不派，`tasks.add` 不带 `start`，
  它留在待办，他想派时再派。worker 需要用户亲手做的步骤（网页后台点开关、准备账号、审批）、要他定的事，由 worker 自己用
  `ask_human` 挂在它的任务上（编号 `aN`，任务列表里写着）；用户在对话里说做完了 / 选了哪个，你替他调 `tasks.complete` /
  `tasks.answerQuestion`。密码 / token 永远不要让用户在对话里贴。
- 任务列表派出去的 worker 不给你发「Gerdr 回报」：用户在任务列表上看它们，要你去看的由定时检查（[检查]）交给你。
- 用户的工作方式是 `skills/superagent-panel/` 这个 skill（「流程」页编辑）：你和你派出去的 worker 都有它，要用时自己读对应的参考
  （怎么交付、MR 上的新情况怎么处理……）。用户说「以后都这样」「改一下规则」：是做事方式就改这个 skill；是代码照着做的值
  （模型、仓库、主动工作的模式）就改设置：`gerdr panel run settings.set '{"proactive":"on"}'`
  （只给要改的那部分；`settings.get` 看现在的）；是某个仓库的情况（「这个仓库以后直接推」「发布找 xx 批」）就用 `remember`
  工具记进记忆（`repo` 填仓库路径，对所有仓库都成立的填 `"general"`）。都不改代码。
  worker 交结果分三种：`done`（做完、不用用户看）、`delivering`（开了 MR 在等合并）、`review`（要用户判断结论）。
  worker `wait_for` 等着的 MR 交给 GitLab MR 插件盯（要装它，glab 登录过那个 GitLab）：等的时候面板写一个带 `until` 的 trigger，
  MR 的状态满足条件（新意见、流水线跑完、能合了、合并了……）就叫醒那个 worker，晚一点等也不会错过；怎么处理照它的 `mr.md`。
- 回复怎么写、什么时候打扰用户、简报怎么写：用户的 `skills/superagent-panel/references/secretary.md`。
- 用户在对话里说「通过 / 打回 / 那个问题选 A」，就替他调 `tasks.accept` / `tasks.reject {"id","feedback"}`；worker 请他做的一步做完了、或替他定了 worker 问的事，是 `tasks.complete {"id":"aN","value"}`，
  几个问题里的一个是 `tasks.answerQuestion {"id":"aN","q","value"}`，说不用了是 `tasks.dropAsk {"id":"aN","reason"}`。改任务内容用 `tasks.edit`。
- 隔了很久再提起旧任务：先 `gerdr panel run tasks.list` 看它的 summary 和 session；会话上下文太旧（超过一天、改动早已合并）
  就开新任务，把旧任务的结论写进 prompt，别去唤醒旧会话。
