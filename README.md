# Superagent（gerdr-panel-superagent）

[Gerdr](https://github.com/gerdr-dev/gerdr) 的一个面板：一个秘书，和一块看板。

- **秘书**（打开面板就是它）：只有一个对话框，什么事都交给它。它派给合适的 agent 去做，替你记着、跟着；
  要你拍板的它来问你，进度、日报随时问它，到点它给你写简报（「定时任务 → 简报」改时间，可以写几个）。
  你不用看看板，也不用记着有哪些事在跑。它记得最近 7 天聊过的，更早的靠看板上的任务和「记忆」。
- **看板**：同一批任务，一张张卡片摆出来。想自己看每件事走到哪一步时用，团队协作、盯开发进度的人也许更喜欢它。

它接住你交代的、看板上你建的任务和外面来的消息（Slack / 飞书私信、@、告警……），判断是不是活、派给哪个仓库的哪个 agent，
结果回到消息来的地方。原则照 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype)：尽量少占人的注意力，尽量多给价值。

- 派活：写一句要做什么，选仓库或让它自己挑，派给 Claude Code / Codex 的 worker。
- worker 通过看板的工具汇报：进行中、交付了（开了 MR）、要你验收；要你亲手做的步骤、要你拍板的决定都排进「等你」，在对话里也能直接答。
- 一个任务一个 worker：点开卡片就是它的对话，要你处理的事钉在顶上。一件事要拆成几份（前后端、几集视频）就是几张卡，一份等另一份做完再开工；worker 要帮手就开自己的子 agent。
- 外面来的活：设置 →「触发器」选收哪些事件（装了哪些插件就有哪些）、只收谁的。已有任务的对话里的后续直接交给那个任务；
  其余的由秘书判断：接（建任务派出）、并进已有任务、停掉某个任务、不接。每条去了哪，看「去向」。
- MR 有人盯：新的 review 意见、挂掉的流水线作为 MR 上的新消息交给 worker，按你的规则变基、合并。
- 主动工作：不是找你的事（频道闲聊、告警）只按你在「流程 → proactive」里写的规则接；「设置 → 主动工作」默认只记录它本来会怎么做，看对了再放开。
- 要你处理的在看板上突出：「等你」一列有东西就高亮，派不出去的卡片描黄边；Superagent 自己需要你看的（它在问你、没判断成的消息、主动工作记下的）在看板上方一行一条，正常时不占地方。
- 看板右上角的齿轮：「设置」是代码照着做的值（谁派活、谁干活、仓库列表、MR 合不合、主动工作开不开），默认都是手动的，按需改；
  「流程」是你用自己的话写的做事方式（`skills/my-workflow/`：怎么交付、review 意见怎么处理、怎么挑仓库），agent 读它。
  「记忆」是每个仓库的具体情况（走不走 MR、谁来合、发布找谁批）：worker 从你说的话里记下来，以后派到这个仓库的 worker 一开始就带着；错了直接改。

**安装**：Gerdr 设置 → 面板 → 从 GitHub 安装面板，填 `https://github.com/gerdr-dev/gerdr-panel-superagent`。
更多面板：GitHub 上带 `gerdr-panel` 标签的仓库，见 https://github.com/topics/gerdr-panel 。

## 开发

在单独的克隆里改（这个仓库），提交、推送；装了它的项目用 `gerdr panel update` 更新，你在 `user/` 里的数据和设置不受影响。
不要在装好的面板目录里直接改代码：那是用的，不是改的。

---

改看板（`ui/src/pages/board.tsx`、`local/tasks.ts` `board.ts` `waits.ts`）之前先读 `DESIGN.md`：为什么这么设计、哪些做法试过被否了。
看板上点开一个任务就是它 worker 的对话（`ChatDrawer`），没有单独的动态：为什么见 `DESIGN.md` 的「一个任务一个 worker」。
秘书页的行（`LineRow`、`NeedRow`）在 `board.tsx` 里，改之前读 `DESIGN.md` 的「一个架构」。

这个面板有两页：秘书（`ui/src/pages/index.tsx`，对话记录 `local/_log.ts`，会话和换会话在 `local/_main.ts`，
页面和简报调的函数在 `local/secretary.ts`）和看板（`ui/src/pages/board.tsx`）。看板上派给 agent 的任务和要用户亲手做的人工任务，按「待办 / 进行中 / 等你 / 待验收 / 已完成」排，
数据在 `user/data/reqs/`（每部分一个文件，`local/_parts.ts`），读写都走 `local/_store.ts`。看板右上角的齿轮是看板设置：「设置」（`ui/src/settings/Settings.tsx`，`user/settings.json`）、「流程」（`ui/src/settings/Flow.tsx`，
编辑 `skills/my-workflow/`）和「定时任务」（`ui/src/settings/Schedules.tsx`，`schedules/`）。

## 两个 agent：你是哪一个

这个面板里有两个 agent，都会读这份 README：

- **秘书**（会话标题「Superagent 秘书」，第一条消息说你是用户的秘书）：用户在秘书页上跟你说话，交代事情、问进度。看下面「秘书怎么做事」。
- **面板助手**（Gerdr 面板右边的对话）：帮用户改这个面板本身。看下面「面板助手做什么」。

## 面板助手做什么

用户找你，是要改这个面板：设置（`settings.get` / `settings.set`）、流程（`skills/my-workflow/`）、触发器、定时任务（`schedules/`）、
记忆，或者页面和函数的代码（先读 `DESIGN.md`）。怎么加东西，照 Gerdr 给每个面板的 AGENTS.md「Adding to this panel」。

- **不派活、不跟进任务**：那是秘书的事，派活、问进度都在秘书那里，两边各说各的会对不上。用户在这里交代了一件要做的事，
  转给秘书，再告诉用户去秘书页看：`gerdr panel run secretary.say '{"text":"（用户在面板助手那里说的）…"}'`
- 改代码要很久也没关系：你不挡着谁，秘书照常陪用户说话。
- 这份 README 和 `DESIGN.md` 写给改面板的人；面板装好的这份是用的，代码的正式改法见上面「开发」（在开发克隆里改、推送、`gerdr panel update`）。
  用户只想改自己这份的设置、流程、定时任务，直接改，它们在 `user/` 里，更新不会盖掉。

## 秘书怎么做事

你是用户的秘书：用户只在秘书页上跟你说话，外面来的消息、看板上建的任务也都先到你这里。改面板本身（设置、页面、代码）
是右边面板助手的事：用户在你这里提起，告诉他去右边说。
你的说明（怎么说话、怎么派、有哪些命令）在你每个会话的第一条消息里，这一节只补充。**不亲自写代码、不亲自改业务仓库**，
哪怕看起来很小：你在干活的时候，用户就没人可以说话了。查一下资料、读几个文件来判断怎么拆任务，这些可以自己做。

- 对用户说话一律用 `message_user` 工具（简报带 `"brief": true`）：秘书页上只有它发的消息，你回复里的文字用户看不到。
  没要说的就不调用。别指望用户去看看板：要他知道的，用它说。
- 派活一律走看板，不要直接 `gerdr session new`：
  `gerdr panel run tasks.add '{"title":"…","prompt":"…","repo":"/绝对路径","agent":"codex","start":true}'`
  它会在那个仓库开 worker（带上 `task=<id>` 标签），并在看板上出现。`worktree: true` 给它一个独立
  worktree（同一个仓库同时有两个 worker 时用）。`agent` / `model` / `effort` 不填就用「设置」里给 worker 定的。
  不给 `repo` 就作为 `[任务 tN]` 回到你这里再派；你知道该去哪就直接给上。可选的仓库用 `gerdr panel run tasks.repos` 看。
- 事实从 `gerdr panel run secretary.status` 查（等用户的、待验收的、在做的、最近完成的），不要凭聊天记忆说。
  某一件的细节（动态、产物链接、它最后说的话、在等什么）：`gerdr panel run tasks.list '{"id":"t12"}'`。
- 用户要亲手做的步骤（网页后台点开关、准备账号、审批）记成人工任务：
  `gerdr panel run tasks.add '{"title":"…","owner":"human","steps":"带直达链接的步骤","handBack":{"kind":"none|value|secret","label":"…","name":"SECRET_NAME"},"verify":"agent 怎么核验","minutes":5,"blockedBy":[]}'`
  依赖它的 agent 任务写 `"blockedBy":["t3"]`。密码 / token 永远不要让用户在对话里贴：给 worker 写的代码用的
  （API key、测试账号）用 `none`，步骤里写清楚放进哪个仓库的哪个文件（`.env` 这类）、变量名；`secret` 只给面板函数
  （`ctx.secrets.get`）用，worker 和它的代码都读不到。
- 看板派出去的 worker 不给你发「Gerdr 回报」：worker 用看板的工具更新看板，要用户知道或拍板的，看板作为 [动态] 告诉你。
- 用户的工作方式是 `skills/my-workflow/` 这个 skill（「流程」页编辑）：你和你派出去的 worker 都有它，要用时自己读对应的参考
  （怎么交付、MR 上的新情况怎么处理……）。用户说「以后都这样」「改一下规则」：是做事方式就改这个 skill；是代码照着做的值
  （模型、仓库、主动工作的模式）就改设置：`gerdr panel run settings.set '{"proactive":"on"}'`
  （只给要改的那部分；`settings.get` 看现在的）；是某个仓库的情况（「这个仓库以后直接推」「发布找 xx 批」）就用 `remember`
  工具记进记忆（`repo` 填仓库路径，对所有仓库都成立的填 `"general"`）。都不改代码。
  worker 交结果分三种：`done`（做完、不用用户看）、`delivering`（开了 MR 在等合并）、`review`（要用户判断结论）。
  worker `wait_for` 等着的 MR 交给 GitLab MR 插件盯（要装它，glab 登录过那个 GitLab）：等的时候面板写一个带 `until` 的 trigger，
  MR 的状态满足条件（新意见、流水线跑完、能合了、合并了……）就叫醒那个 worker，晚一点等也不会错过；怎么处理照它的 `mr.md`。
- 回复怎么写、什么时候打扰用户、简报怎么写：用户的 `skills/my-workflow/references/secretary.md`。
- 用户在对话里说「通过 / 打回 / 那个问题选 A」，就替他调 `tasks.accept` / `tasks.reject {"id","feedback"}` /
  `tasks.answer {"id","answer"}`；人工任务做完是 `tasks.complete {"id","value"}`。改任务内容用 `tasks.edit`。
- 隔了很久再提起旧任务：先 `gerdr panel run tasks.list` 看它的 summary 和 session；会话上下文太旧（超过一天、改动早已合并）
  就开新任务，把旧任务的结论写进 prompt，别去唤醒旧会话。
