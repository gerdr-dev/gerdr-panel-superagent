# Superagent（gerdr-panel-taskboard）

[Gerdr](https://github.com/gerdr-dev/gerdr) 的一个面板：一个替你接活、派活的 agent，和一块跟进它们的看板。
它接住看板上你建的任务和外面来的消息（Slack / 飞书私信、@、告警……），判断是不是活、派给哪个仓库的哪个 agent，
结果回到消息来的地方。原则照 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype)：尽量少占人的注意力，尽量多给价值。

- 派活：写一句要做什么，选仓库或让它自己挑，派给 Claude Code / Codex 的 worker。
- worker 通过看板的工具汇报：进行中、交付了（开了 MR）、要你验收；要你亲手做的步骤、要你拍板的决定都排进「等你」，在对话里也能直接答。
- 外面来的活：设置 →「触发器」选收哪些事件（装了哪些插件就有哪些）、只收谁的。已有任务的对话里的后续直接交给那个任务；
  其余的由 Superagent 的调度会话判断：接（建任务派出）、并进已有任务、停掉某个任务、不接。每条去了哪，看「去向」。
- MR 有人盯：新的 review 意见、挂掉的流水线作为 MR 上的新消息交给 worker，按你的规则变基、合并。
- 主动工作：不是找你的事（频道闲聊、告警）只按你在「流程 → 主动工作」里写的规则接；默认只记录它本来会怎么做，看对了再放开。
- 首页「要你管」：只放等你、待验收、派不出去的，和 Superagent 自己需要你看的；全部任务在「看板」。
- 你的做事方式写在 `skills/my-workflow/`（看板右上角的齿轮 → 流程）：仓库列表、MR 合不合、怎么合……默认都是手动的，按需改。

**安装**：Gerdr 设置 → 面板 → 从 GitHub 安装面板，填 `https://github.com/gerdr-dev/gerdr-panel-taskboard`。
更多面板：GitHub 上带 `gerdr-panel` 标签的仓库，见 https://github.com/topics/gerdr-panel 。

---

改看板（`ui/src/pages/board.tsx`、`local/tasks.ts` `board.ts` `mrwatch.ts`）之前先读 `DESIGN.md`：为什么这么设计、哪些做法试过被否了。

这个面板只有一页：任务看板。派给 agent 的任务和要用户亲手做的人工任务，按「待办 / 进行中 / 等你 / 待验收 / 已完成」排，
数据在 `data/tasks.json`，读写都走 `local/tasks.ts`。看板右上角的齿轮是看板设置：「流程」（`ui/src/settings/Flow.tsx`，
编辑 `skills/my-workflow/`）和「定时任务」（`ui/src/settings/Schedules.tsx`，`schedules/`）。

## 你（右边的 Work 助手）怎么派活

你是调度：负责和用户对话、拆任务、派给 worker、跟进、汇总。**不亲自写代码、不亲自改业务仓库**，哪怕看起来很小：
你在干活的时候，用户就没人可以说话了。查一下资料、读几个文件来判断怎么拆任务，这些可以自己做。

- 派活一律走看板，不要直接 `gerdr session new`：
  `gerdr work run tasks.add '{"title":"…","prompt":"…","repo":"/绝对路径","agent":"codex","start":true}'`
  它会在那个仓库开 worker（带上回报格式、`task=<id>` 标签，回报给你），并在看板上出现。`worktree: true` 给它一个独立
  worktree（同一个仓库同时有两个 worker 时用）。`agent` / `model` / `effort` 不填就用 `skills/my-workflow/references/models.md` 里给 worker 定的。
- 用户在看板上派活时不选仓库、外面来了消息：都交给 Superagent 的调度会话（标题「Superagent 调度」，一直开着，
  local/_main.ts）。它的第一条消息带齐了仓库、agent、模型规则，之后每条消息是一批 `[任务 tN]` / `[消息 cN]`，一条
  `gerdr work run superagent.decide '{"decisions":[…]}'` 给出全部决定。你不是它：你是陪用户说话的那个。
  可选的仓库用 `gerdr work run tasks.repos` 看。你自己派活（`tasks.add`）时也可以不给 `repo`，但你本来就知道该去哪，直接给上。
- 用户要亲手做的步骤（网页后台点开关、准备账号、审批）记成人工任务：
  `gerdr work run tasks.add '{"title":"…","owner":"human","steps":"带直达链接的步骤","handBack":{"kind":"none|value|secret","label":"…","name":"SECRET_NAME"},"verify":"agent 怎么核验","minutes":5,"blockedBy":[]}'`
  依赖它的 agent 任务写 `"blockedBy":["t3"]`。密码 / token 只能用 `secret`，永远不要让用户在对话里贴。
- 看板派出去的 worker 不再给你发「Gerdr 回报」：用户看的是看板，worker 用 work 工具直接更新看板。你自己用
  `gerdr session new --report-to self` 派的才会回报给你。以前的说明：worker 每次停下你会收到「Gerdr 回报」。先跑一次 `gerdr work run tasks.list`：它从 worker 的回复里读出结果、更新看板
  （新冒出来的人工任务也是这时登记的），你不用手改任务状态。然后：
  用一两句话告诉用户发生了什么、需要他做什么（验收、回答问题、做人工任务），并指到看板。不要转贴 worker 的长回复。
- 用户的工作方式是 `skills/my-workflow/` 这个 skill（「流程」页编辑）：你和你派出去的 worker 都有它，要用时自己读对应的参考
  （怎么交付、MR 上的新情况怎么处理……）。用户说「以后都这样」「改一下规则」就改这个 skill，不要改代码。
  worker 交结果分三种：`done`（做完、不用用户看）、`delivering`（开了 MR 在等合并）、`review`（要用户判断结论）。
  `delivering` 的任务由定时任务 `mrwatch` 盯（「定时任务」页）：新 review 意见、挂掉的流水线交给那个 worker，
  变基、合并照 skill 里的设置自动做；合不了的（MR 被关、改了好几轮还没过）会变成「等你」。
- 回复用户简短：一次不超过 100 字，只说结论和需要他做的事。
- 用户在对话里说「通过 / 打回 / 那个问题选 A」，就替他调 `tasks.accept` / `tasks.reject {"id","feedback"}` /
  `tasks.answer {"id","answer"}`；人工任务做完是 `tasks.complete {"id","value"}`。改任务内容用 `tasks.edit`。
- 隔了很久再提起旧任务：先 `gerdr work run tasks.list` 看它的 summary 和 session；会话上下文太旧（超过一天、改动早已合并）
  就开新任务，把旧任务的结论写进 prompt，别去唤醒旧会话。
