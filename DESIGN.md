# 任务看板的设计

改看板（`ui/src/pages/board.tsx`、`local/tasks.ts`、`local/board.ts`、`local/mrwatch.ts`）之前先读这份。
这里记的是**为什么这么做**，以及试过、被否掉的做法。每一条都是用户实际用的时候踩出来的。

## 出发点

用户不想跟 AI 聊天。他在看板上派活、看结果、做必须他本人做的事；对话只是偶尔点进去看一眼、顺手回一句。
所以：

- **看板是主界面，对话是附属。** 任何「要用户知道 / 要用户做」的东西，都得出现在看板上；只出现在对话里等于没说。
- **不催人。** 用户可能几天后才处理一件事。除非真的有人在等（他正在对话里），否则不挂起会话、不亮红点。
- **这套面板要给别人也能用。** 代码只放机制；用户本人的习惯（怎么交付、MR 怎么合、要不要自动合并、多久盯一次）
  写在 `skills/` 和 `schedules/` 里，用他自己的话。见 Gerdr 内置 AGENTS.md 的「Adding to this Work」。

## 概念

- **任务**（`data/tasks.json`，读写都走 `local/_store.ts`）：
  - **agent 任务**：派给一个 **worker**，也就是看板用 `ctx.sessions.start` 在某个仓库里开的会话。
  - **人工任务**：只有用户本人能做的事。分两种：
    - **步骤**：授权、建账号、交回密钥。
    - **待决定**：带选项，`handBack.kind = "choice"`。
- **worker 的身份**：工具调用时 Gerdr 给出 `ctx.caller.session`，看板按它找到对应的任务。
  不让 worker 自己报任务号，它报错了也没法发现。
- **产物**（`links`）：每一步产出的链接（MR、流水线、文档），带时间，**只加不删**。
  曾经改成「只留最新一次的」，用户不要：过时的也要留着，方便回头追溯。

## 列：从事实推出来，不能拖

待办 → 进行中 → 等你 → 待验收 → 已完成。列由 `tasks.list` 的 `column` 算出来（加上页面上 `colOf` 把「还没派出 / 被挡住」分进待办），
**不能拖卡片**：拖出来的列会和 worker 实际在做的事对不上。

- **等你**：worker 的会话在等审批 / 当场提问、出错，或者有一个轮到用户的人工任务 / 待决定。
- **待验收**：worker 汇报 `review`，意思是结论要用户来判断（排查、调研）。
  - **用户自己在对话里问出来的那一轮不算。** 汇报 `review` 时如果 `byPerson`（上一轮是人打的字），只更新摘要、不挪列：
    人就在对话里看着回答，再说「请你看」没有意义。这是 t12 被挪进待验收后改的。
  - **有 MR 的不是待验收**：没合并就不算完，见下面的「交付」。
- **用户随时能「标为完成」**：他可能自己做完了，或者觉得这样就够了。

## worker 怎么汇报：工具，不是文字

worker 拿到一组 Work 工具（`local/board.ts`，经 Gerdr 的 `gerdr work mcp` 以 MCP 提供）：

| 工具 | 用途 |
|---|---|
| `task_update` | 更新状态（working / done / delivering / review）、摘要、产物；开了 MR 就带上 `mr` |
| `ask_human` | 登记人工任务；带 `options` 就是待决定 |
| `cancel_human` | 撤回自己登记过的人工任务（用户在对话里答了 / 换了做法），要写原因 |
| `my_task` | 查自己的任务现在是什么样 |

**被否掉的做法：在回复末尾写一段 ```` ```gerdr-task ```` JSON。** 这是最早的版本，问题有三个：
- 一轮只能报一次；
- 要从大段文字里解析；
- **只能加不能撤**：用户在对话里顺手答了，「等你」收不回来。

旧会话写的文字块 `tasks.list` 还认（`_apply.ts` 和工具共用同一套规则），但新的交接不再提它：
交接里只有两三句话，因为它会原样出现在对话的第一条消息里，长了就是一大坨。
每个工具具体怎么用，写在工具自己的说明里。

## 要用户做的事：看板上的卡片，不挂在对话里

- **步骤**：`ask_human` 带 `steps`。要写到用户不用回去看对话就能做完：直达链接、验证码、预填的值。
  有时效的写 `expires`，卡片上显示「还剩 N 分钟」，过期了有「让它重新生成」。
- **待决定**：`ask_human` 带 `options`。登记完 worker **结束这一轮**，会话变回空闲。
  用户哪天在看板上选一个，看板把决定发给 worker，它接着做。
  - **被否掉的做法：让 worker 用自带的提问工具（AskUserQuestion）问。** 它会把这一轮挂起来原地等：会话一直「等你处理」、侧栏红点，几天不答就一直催。
    现在只有「用户正在对话里跟它说话」时才用它当场问。
- **对话里也要看得到**：工具返回 `gerdrCard`，Gerdr 在对话里画成卡片（不会被折进「跑了 N 条命令」）。
  卡片的 `type` 是 `task-step`，由 `ui/src/cards.tsx` 画：还在等时就是 Gerdr 自带的卡片（能在对话里直接选、能撤回）；
  看板上处理完或撤回以后，变成一行「已处理：…」「已撤回」。以前卡片一直是可点的样子，看不出已经答过了。
  Gerdr 启动时就加载 `cards.tsx`，所以这些卡片在哪里显示都是这个样子。
  用户在对话里时，抽屉顶栏每件等他的事一行，点一下跳到对话里那张卡片。
- **能回到对话**：人工任务、待决定的详情里有「回到 tN 的对话」，打开提出它的那个 worker 的对话，方便看前因后果。
- **自动收回**：
  - 人工任务挡着的那些任务都结束了，它就自动放弃（`dropOrphans`）；
  - 同一个 worker 用文字块重新登记的，会自动取代它之前的那些；
  - 用工具登记的不自动取代：worker 自己用 `cancel_human` 撤。

## 交付：按「还差什么」，不按「有没有 MR」

用户的规则在 `skills/my-workflow/references/deliver.md`：有的仓库开 MR，有的可以直推。
所以不能拿「有没有 MR」来判断做没做完。worker 汇报的是还差什么：

- `done`：做完了，不用看（比如照规则直推了，CI 也绿了）。
- `delivering` + `mr`：交出去了，在等 MR 合并。任务留在「进行中」，卡片上写 MR 卡在哪一步。
- `review`：要用户判断结论。

**mrwatch**（`local/mrwatch.ts`，由 `schedules/mrwatch.json` 定时跑）盯着所有 `delivering` 的任务，全部是确定性的代码，只按 GitLab 的字段走。
每次按顺序只做第一件符合的事：

1. 有新的 review 意见：交给 worker。
2. 流水线挂了：交给 worker，附上失败 job 的日志末尾。
3. 有冲突：交给 worker。
4. worker 正在改：这次不动。
5. 需要变基：自己变基。
6. GitLab 说可以合并、批准数也够：自己合并。

合并后任务完成；MR 被关了、改了好几轮还没过，就交给用户。
交给 worker 的消息只说发生了什么，处理规则让 worker 自己去读 skill。最早的版本把整份规则粘进消息里，worker 收到一堆跟它无关的东西。

自动还是手动合并 / 变基、变基时跑不跑流水线、至少几个人批准、最多几轮，都是用户的选择，
写在 `skills/my-workflow/references/mr.md` 里的 `{{变量}}` 上，由 `local/_config.ts` 读出来，
代码里的默认值是保守的（都手动）。
**被否掉的做法：`workflow.json` 开关文件。** 一项项开关和理由分开了，agent 读的也不是同一份。

## 派活

- **用户只写「要做什么」**：不用填标题（取第一行），也不用选仓库。可以带图片、文件（上传后作为附件带给 worker）。
- **没选仓库的，由一个一次性对话来挑**（`route`）：它在 Work 目录里开，标题「派活：tN」。
  它读得到 README、skill 和工具，挑好仓库用 `tasks.start` 派出去，之后由 `tasks.list` 关掉。
  - **被否掉的做法：发给右边的 Work 助手。** 每派一个就把助手的对话撑长一轮，而用户根本不看。
  - 在 Work 目录里开的会话是 Work 自己的对话，Gerdr 不会把它放进 Code，不会冒出标签页。
- **派活要快**：派活对话要的东西全写在它的第一条消息里（仓库列表和用户挑仓库的说法、每个 agent / 角色是干什么的、
  模型规则、用户 @ 了谁），一条 `tasks.dispatch` 派出去，要拆成几个并行的也是这一条（第一份就是原任务，其余是
  `from` 指向它的新任务）。
  **被否掉的做法：让它自己去读 README / skill / 看板代码。** 实测一次派活 22 秒，三轮读文件占了 10 秒，读到的东西每次都一样。
- **@ agent**：新任务里输入 @ 点名 agent（`mentions`）。只点了一个就是这个任务的 agent；点了几个交给派活对话安排，
  怎么分、并不并行、谁用便宜模型都由它定。指定了仓库又只点了一个，就不经过派活对话，直接派出。
- **用哪个 agent、哪个模型**：用户写在 `skills/my-workflow/references/models.md` 的变量里，派活的对话和 worker 各一组
  （agent / 模型 / 思考强度），`local/_config.ts` 读出来。任务上指定的优先。那组模型只配那组的 agent：
  任务换了 agent 就不套（claude 的模型名对 codex 没意义），用那个 agent 自己的默认。
  值写错了，Gerdr 开会话时直接报错并列出可选值，不会悄悄换成默认模型去跑。
- **看板派出去的 worker 不回报给助手**（不设 `reportTo`）。用户看的是看板，回报只会让助手对着空气把 worker 的话复述一遍。
- **worker 是看板的，不进 Code**（`ctx.sessions.start({ workspace: "none" })`）：Gerdr 给看板开的对话打上 `panel` 标签，
  从通知、收件箱、「进行中」点到它，Gerdr 都切回这个面板，交给看板显示（`onShowSession`：打开那个任务的抽屉）。
  看板不知道有 Code，也没有「在 Code 里打开」：面板之间是平级的，Code 只是另一个面板。
- **仓库从哪来**：用户自己写在 `skills/my-workflow/references/repos.md` 的 `{{仓库: … ; list}}`，
  新任务的仓库下拉和派活的对话都只看这一份。没写的时候拿最近用过的目录当建议。
  **被否掉的做法：读 Code 的工作区。** 看板和 Code 是平级的两套界面，各管各的；而且 Code 的工作区里混着很多和这个项目无关的目录。

## 用户在对话里

点 agent 任务的卡片，打开的是 worker 的对话：看板自己的抽屉（`ui/src/components/ChatDrawer.tsx`），
里面是 Gerdr 原生的聊天（`@gerdr/core` 的 `SessionChat`，和 Code 里一模一样：图片、文件、审批、卡片），按 Esc 或点外面关闭。
抽屉顶上写什么、放什么按钮，全是看板的代码：等你先做什么、问题的全文、标为完成、等它合并、立即合并……
**正文写内容，按钮只写动作**：等你先做的几件事，每件一行（tN 待决定：……），点一下跳到对话里那张卡片。
曾经把标题塞进按钮里，用户不要。
- **被否掉的做法：在看板面板里复制 worker 的回复。** 只能看到最后一条、纯文本、不能发图片，用户要往前翻才能做决定。
- **被否掉的做法：让 Gerdr 在页面上面替看板画抽屉**（`showSession`）。那时 Work 页面是个 iframe，用不了 Gerdr 的聊天，
  看板想在抽屉里多放一样东西，就得改一次 Gerdr。现在 Work 页面直接挂在 Gerdr 的页面里，聊天是一个组件，抽屉是看板自己的。

- **消息一律立即发送**：抽屉里的输入框（`SessionChat` 的 `sendNow`）和看板函数发给 worker 的消息（`ctx.sessions.send` 的
  `now`）都是「立即发送」：worker 在跑长命令时，命令转到后台，它马上读到新消息，不用等这一步做完。
  用户在看板上补一句、改个方向，是希望它现在就知道，不是排在一个可能要跑十几分钟的步骤后面。

人工任务、已完成的任务、还没派出去的任务，才用看板自己的详情面板。

## 界面：自己的组件，只有对话用 Gerdr 的

面板的界面全是自己的：按钮、抽屉、弹窗用 shadcn/ui（`ui/src/components/ui/`，照 shadcn 的做法拷进来，依赖写在
`ui/package.json`），动画是自带的 tw-animate（`ui/src/animate.css`）。从 Gerdr 拿的只有对话本身：`@gerdr/core` 的
`SessionChat`、`useSession`、`onShowSession`、卡片注册。
**被否掉的做法：用 Gerdr 内部的组件**（`@gerdr/core/ui`）。面板就跟着 Gerdr 的组件走了，Gerdr 改一次面板变一次，
想按自己的意思改也改不了。面板是能单独发布、给别人装的东西，界面得自己说了算。

## 文件

| 文件 | 内容 |
|---|---|
| `local/_store.ts` | 任务数据和读写（带 etag 重试） |
| `local/_apply.ts` | worker 汇报怎么落到任务上（工具和旧文字块共用） |
| `local/tasks.ts` | 看板和 Work 助手调用的函数：list / add / start / accept / complete / deliver / redo / drop… |
| `local/board.ts` | 给 worker 的 Work 工具 |
| `local/mrwatch.ts` | 盯 MR |
| `local/_config.ts`、`local/_vars.ts` | 从 skill 里的 `{{变量}}` 读出代码要用的值 |
| `local/playbooks.ts`、`local/schedules.ts` | 「流程」「定时任务」的读写 |
| `ui/src/pages/board.tsx` | 看板，这个面板唯一的页面 |
| `ui/src/components/SettingsSheet.tsx`、`ui/src/settings/` | 看板设置：「流程」「定时任务」（不是单独的页面：面板就是看板，它们是看板的设置） |
| `ui/src/components/ChatDrawer.tsx` | worker 对话的抽屉（`SessionChat`） |
| `ui/src/cards.tsx` | 对话里的 `task-step` 卡片 |
| `skills/my-workflow/` | 用户本人的做事方式（给所有 agent 看） |
| `schedules/` | 定时任务 |
