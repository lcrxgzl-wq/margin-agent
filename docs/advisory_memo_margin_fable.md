# Margin 顾问备忘录（Fable 5 · 架构 / 产品深度评审）

**日期：** 2026-07-19
**角色：** 独立架构 / 产品顾问，只读评审（本轮不写代码）
**依据：** 仓库现状代码（`packages/domain`、`packages/agent`、`packages/storage-local`、`apps/cli`、`apps/web`）+ `docs/FABLE_ADVISORY_BRIEF.md` + `MARGIN_PLAN.md` / `ROADMAP.md` / `docs/AGENT_ARCHITECTURE.md` / `docs/EXECUTION_PLAN.md`
**读者：** 项目 owner → 转交开发团队作为下一阶段实现规格参考

> **勘误声明**：本稿早前口头讨论中出现过"真实院校模板语料库"的提法，owner 已指出监管/合规风险（易被解读为对具体机构模板背书或论文代写工具认证）——**本文档不再包含该项，全文以"用户自带 `reference.docx` + 自造通用测试模板"替代**。任何 DOCX 保真度验证都应使用自造的、不带机构标识的合成样本。

---

## 0. 产品一句话（本轮定稿，作为全文判词）

> **用户是领导/导师，Agent 是员工。** 领导可以指挥员工写具体一段，也可以指挥员工通读改全篇；员工写完的东西领导可以退回（Undo）、可以自己动手改（Edit）、也可以在对话框里说一句"感觉不对，往这个方向改"（vibe 指令），员工据此重写。形态像 IDE——但审阅权/签字权 100% 在领导手里，员工没有 apply 权限。

这句话直接回应 brief 里的张力 #1（"产品宪法 vs 代码形态"）：`MARGIN_PLAN.md` 写"不要做学术版 Cursor"，代码却在做左画布右聊的工作台——**这不是矛盾，是宪法表述本身需要修正**。正确读法不是"不要工作台"，而是**"要工作台，但工作台里的'员工'（Agent）永远没有签字权，只有领导的 Y/N/E 才落盘"**。这个判词应该写进 `MARGIN_PLAN.md` §0 替换掉容易引起误读的"不做 Cursor"表述。

后文所有架构建议都以这个模型为准：Agent = 可指挥、可撤回、可被接管的员工；Host = 领导签字机；Domain 契约 = 员工和领导之间唯一算数的"工作记录"。

---

## 1. Executive Verdict

**Go with changes.**

最硬的一条理由：**你现在还不是一个"可插拔壳"，是一个已经把学术特化写死在最底层工具面里的单体 Agent**——`packages/agent/src/pi-tools.ts` 第 5 行 `import { citeCheck, styleLint } from "./academic.js"`，把 `cite_check`/`style_lint` 和通用的 `list_blocks`/`propose_block_edit` 塞进同一个 `createPaperTools()` 返回数组，每个 session 都会挂载。`session-runner.ts` 的 `systemPrompt()` 也直接 `getHarness()` 拼学术文案。**"办公 pack"目前不是"还没做"，是"现在的写法决定了它没有地方插"。**

这件事之所以是全篇最硬的判断依据：如果不先把这道缝挖开，后面无论是"模块化蓝图""办公 pack 最小形态""平台叙事"，都会在某个时间点撞上"发现 core 里全是学术假设，只能推倒重写工具面"这堵墙——而且现在代码量还小（`packages/agent` 2200 行出头），是成本最低、风险最小的窗口期。晚做一个季度，成本会随 session-runner/pi-tools 的调用点增多而非线性上升。

其余判断：
- Domain 契约（`Proposal/Decision/ApplyEvent` + CAS）本身**足够硬**，不需要为办公场景重新设计，见 §3.1。
- Host/Agent 分权（Agent 不 apply，Host 才 apply）**已经落地且执行得不错**，这是这套系统区别于"AI 直接改文件"的核心资产，不要在任何重构里松动。
- 前端 `App.tsx`（612 行 useState 群）和 `storage-local/index.ts`（817 行单体）是可控债务，不是设计错误，是"MVP 期间图快"的自然产物，值得在架构收口前专门处理一轮，见 §4.2 / §3.2。

---

## 2. 产品定位裁决

### 2.1 学术主攻 / 办公叙事怎么分层

用"领导-员工"模型说清楚分层逻辑：**学术 pack 的价值在于把"员工能不能被信任"这件事的验收标准定得极其苛刻**（不得编造引文、不得编造访谈引语、cite_check 必须自证"未验证真伪"）。这套苛刻的验收标准一旦作为 core 的默认假设，天然适配到办公场景的门槛反而更低（企业公文没有"编造田野访谈"这种致命失分项）。所以**正确的技术叙事是"学术是最难的客户，先在最难的客户身上把协议做到可信，办公只是把苛刻度调低的下位替换"**，而不是"学术和办公是两个平行赛道，各自开发"。这决定了模块化方向：**pack-academic 应该是"更严格的 pack-office"，不是"平行的另一套东西"**——即两者共享同一个"约束层"接口（禁止编造 / 证据要求 / 风险分级），只是约束的松紧参数不同。

### 2.2 反对"学术版 Cursor"的具体校正

不要在对外话术或内部文档里继续用"不做学术版 Cursor"这句话，它已经造成了文档和代码的认知错位。改成：

> Margin 不是"AI 帮你把论文写完"，而是"AI 员工可以被领导指挥到任意粒度（一段/全篇），但交出的每一处改动都要过 Y/N/E 才算数，且过程留痕可审计"。

区别于 Cursor 的关键不是"有没有工作台"，是：
1. Cursor 里 Agent 可以直接改文件（有 apply 权），Margin 里 Agent 永远只能提案；
2. Cursor 面向代码（无"编造引用"这类领域禁令），Margin 面向学术文本时有一套硬性内容约束；
3. Cursor 没有"领导审阅×员工汇报"的仪式感（diff 直接进文件），Margin 的产品叙事是把这套仪式感做成可以拿给导师/主编看的**审阅记录**。

### 2.3 信息架构如何体现分层

- **Landing / 首屏**：保持"对话优先，打开稿件后出画布"（`apps/cli` 第12轮已经做了这个纠偏），但登陆时应显式展示"当前 Harness = 中文社科论文修订"这一行状态条，而不是隐藏在设置里——领导需要知道"我雇的这个员工今天带的是哪套规矩"。
- **Pack 开关**：`packages/harness/src/index.ts` 现在的 `getHarness(id?)` 已经是个可扩展注册表（`social-science-zh` / `minimal`），这是好的起点，但注册表里应该新增一个字段 `toolProfile: string[]`，显式声明"这个 harness 允许挂载哪些工具"，而不是像现在这样工具面写死在 `pi-tools.ts` 里、harness 只提供 system prompt 文案。
- **默认 harness**：默认永远是学术（`social-science-zh`），office 相关 harness（哪怕只是 `minimal` 的变体）**必须是用户主动选的**，不能因为要"扩大叙事"就把默认值改成通用写作助手——一旦默认值变了，"主攻学术"这句话就名存实亡。

---

## 3. 后端架构建议（深度）

### 3.1 domain 契约评估：够不够硬，能不能扛住办公文档

`packages/domain/src/index.ts`（130 行）目前的核心类型：

```
Proposal { blockId, baseRevision, baseHash, before, after, rationale, risk, evidence, status }
Decision { proposalId, kind: Y|N|E, editedText?, reason? }
ApplyEvent { ok, reason: ok|stale|missing|rejected, beforeRevision, afterRevision, beforeHash, afterHash }
```

**结论：这套契约本身是通用的，不需要为办公场景改一个字段。** `risk` 的四个取值（language/structure/argument/fact）里，`argument`/`fact` 对公文/邮件场景没有太大意义，但保留它们不构成负担——一个"内部通知"pack 完全可以只用 `language`/`structure` 两个值，不需要 schema 层面区分。CAS 语义（`baseRevision + baseHash`）对任何"块级文本 + 需要防止并发覆盖"的场景都成立。**唯一需要现在就补的字段**是：

- `evidence` 目前是 `string[]`（自由文本），对学术场景够用（引用 key/文献片段），但办公场景（比如"这句话是不是有制度依据"）用同一个字段也说得通——不需要新增字段，但应该在类型旁边加注释明确"evidence 是'为什么这么改'的佐证指针，不是文献专属字段"，避免开发者以为这是学术专属字段而在办公 pack 里另起一个。
- 建议新增（§4.4 详述）：**`SelectionCommandSchema`**——把"重写/按指令重写/讨论"这三个目前只存在于前端字符串判断里的动作，提升为 domain 层的协议类型。这是"领导指挥员工到具体段落"这件事在协议层唯一还没有名字的动作，值得补上。

### 3.2 包边界重划：storage-local 和 agent 都该拆

**`packages/storage-local/src/index.ts`（817 行）**现在一个文件里混了五件事：workspace 生命周期（`openWorkspace`/锁）、文档/块 CRUD（`openDocument`/`listBlocks`）、审阅存储（`saveProposal`/`saveDecision`/`applyApproved`）、DOCX 适配（`importDocxDocument`/`exportDocumentDocx`，另有独立的 `docx.ts`/`docx-loss.ts`）、导出打包（`exportPacket`）。加上同目录下的 `llm-settings.ts`（405 行）、`cc-switch-import.ts`（193 行）、`provider-presets.ts`，这个包实际上承担了"文件系统 + 审阅数据库 + LLM 配置中心"三种完全不同职责的持久化。

建议拆成三个内聚模块（先在同一个包内拆文件，验证边界后再考虑拆包）：

| 模块 | 职责 | 现有代码来源 |
|------|------|--------------|
| `workspace-fs.ts` | 路径安全（`resolveWorkspacePath`）、workspace 锁、文件读写、DOCX 导入导出 | index.ts 前段 + docx.ts |
| `review-store.ts` | Proposal/Decision/ApplyEvent/AgentComment 的 SQLite CRUD、CAS apply | index.ts 中后段 |
| `llm-config/` | llm-settings.ts + cc-switch-import.ts + provider-presets.ts（这三个文件其实已经内聚得不错，只是和前两者挤在一个包里） | 现状 |

**为什么现在拆、不是"以后有空再拆"**：办公 pack 未来大概率需要复用 `workspace-fs`（文件系统语义不分学科）和 `review-store`（Proposal 协议不分学科），但**不需要**继承任何 DOCX 逻辑里可能存在的学术假设（目前看 `docx.ts`/`docx-loss.ts` 是干净的，没有学术耦合，这点是好消息）。`llm-config` 更是彻头彻尾与文档类型无关。现在拆的成本是"移动 + 改 import"，等到有第二个 pack 在用这个包时再拆，成本是"一边用一边拆，还要保证两个调用方都不炸"。

**`packages/agent`（2263 行）**是本轮最需要动刀的包，具体拆法见 §6 模块化蓝图，这里先给判断依据：`academic.ts`（162行，纯启发式规则，无 LLM 依赖）、`pi-tools.ts`（340行，工具 schema 定义）、`session-runner.ts`（506行，运行时编排）三者目前是"横向耦合"——runner 直接依赖 tools，tools 直接依赖 academic。正确方向应该是"纵向注册"——runner 只认识"工具面从哪个 pack 装配"这一个接口，academic 相关的一切通过 pack 注册表注入，runner 本身不 import 任何 `academic.ts` 符号。

### 3.3 Agent Runtime 设计：对标 Pi，缺什么

Brief 要求"对标 Pi：工具 schema、timeout、abort、transcript 持久化，Margin 缺什么"。逐项对照现状代码：

| 维度 | Pi 的做法（惯例） | Margin 现状 | 缺口 |
|------|---|---|---|
| 工具 schema | 每个工具独立文件/命名空间，权限声明显式 | `pi-tools.ts` 单文件塞 9 个工具，权限靠命名约定（"propose_*"没有 apply 权）隐式表达 | 应显式加 `AgentTool` 的 `sideEffect: "none"|"draft"|"persist"` 元数据字段，而不是靠注释和命名约定让开发者自己记住"这个工具不能碰文件" |
| timeout | 每轮/每工具可配置超时 | `session-runner.ts` 里 `timeoutMs()` 是**整个 turn** 级别的超时（`MARGIN_PI_TIMEOUT_MS`，默认 120s），没有单工具超时 | 如果未来某个工具（比如真的接 Zotero 网络调用）单次卡住，会拖满整轮预算而不会被单独中断。建议给 `AgentTool` 增加可选 `timeoutMs`，工具执行套一层 race |
| abort | 支持外部信号中断 | 有：`agent.abort()` 在超时和 turn 上限时被调用（`session-runner.ts` 第147-155行左右），机制是对的 | 目前 abort 原因只写进 `notes` 数组，前端没有区分"正常结束"和"被打断"的视觉状态——建议在 `SessionTurnResult` 里加 `aborted: boolean` 显式字段，而不是让前端去猜 notes 里有没有"aborted"字符串 |
| transcript 持久化 | 会话记录落盘可重放 | **没有**：`agentMessages`（pi 的 `AgentMessage[]`）只存在 `ChatAgentState`（`apps/cli/src/chat-agent.ts`）的内存里，进程重启即丢；落盘的只有 `ChatMemory`（12轮的问答文本摘要，`chat-memory.ts`） | 这是当前**最大的可观测性缺口**：出了质量问题（比如 Agent 说谎/编造），除了最近 12 轮的摘要文本，没有工具调用序列的完整记录可供复盘。建议：`agent_transcripts` 表落 SQLite（`documentId`/`turnId`/`toolCalls[]`/`timestamps`），哪怕只保留最近 N 轮，用于故障复盘和"审计可重启恢复"这条产品承诺的兑现（`ROADMAP.md` 里 M1 验收标准写了"重启日志仍在"，但目前重启后**对话上下文**是丢的，只有**审阅决策**留在数据库） |
| 工具执行模式 | 部分并行、部分串行按需声明 | 全部 `executionMode: "sequential"` | 对当前 9 个工具够用（`list_blocks`/`search_blocks`等只读工具串行执行没有实质代价，因为本来就很快），暂不建议改，除非未来引入真正慢的网络工具（比如实时文献检索） |

**优先级判断**：transcript 持久化是唯一值得在短期内补的一项，其余（细粒度 timeout、显式 sideEffect 元数据）可以放到中期模块化时一并做，不必现在单独起一轮。

### 3.4 Offline Planner / PolicyRouter：去留裁决

`apps/cli/src/open-intent.ts`（56行）是一个纯正则的"打开意图"解析器，`docs/FABLE_ADVISORY_BRIEF.md` 里担心它会"长成第二套意图路由器"。看代码现状，它目前**没有**失控——只处理"打开 XXX"这一类语句的歧义消解（区分"打开文稿"这种泛指 vs "打开 XX 篇"这种具体指名），且只在 `runOfflineSessionTurn`（无 Key 时）路径里被使用；有 Key 时走 `runPiSessionTurn`，完全不经过它。

**裁决：正规化，不删除，不放任自然生长。** 具体做法：
1. 把它改名为 `packages/agent/src/policy/open-intent-rule.ts`，物理上放进一个新建的 `packages/agent/src/policy/` 目录；
2. 新建 `packages/agent/src/policy/router.ts`，导出一个 `PolicyRouter` 接口：`decide(input): { route: "pi_session" | "offline_planner"; matchedRule?: string }`；
3. `open-intent.ts` 的规则作为 `PolicyRouter` 里的**一条**规则（"打开类意图"），而不是独立分支；
4. **硬性约束**：以后任何"为了好用而加的确定性快路径"都必须在 `policy/` 目录下新增一条规则并注册到 `PolicyRouter`，不允许在 `session-runner.ts` 或 `apps/cli` 里散落新的 if/regex 判断——这是防止"第二套意图路由器"失控生长的唯一有效办法，不是靠自觉，是靠"只有一个地方能加规则"的物理约束。

### 3.5 安全模型：localhost Bearer / CAS / 路径 / 多 workspace

现状（`apps/cli/src/index.ts` + `packages/storage-local/src/index.ts`）：
- **Token**：`randomUUID()` 生成，进程级，通过 `#token=` hash 传给前端存 `localStorage`，`requireAuth()` 校验 `Bearer ${token}`。**够用**，没有过期机制，但因为是"进程存活期 = token 存活期"，对单机单用户场景是合理简化，不需要现在补 TTL/刷新（这条我在之前的短期计划里判断错了优先级，这里更正：**TTL 不是本阶段该做的事**，它对威胁模型没有实质提升——本地攻击者能拿到 token 的前提是已经能读本机进程/localStorage，那时候 TTL 形同虚设）。
- **路径安全**：`resolveWorkspacePath()`（`storage-local/src/index.ts` 第31-62行）做了三层校验：绝对路径拒绝、`..` 段拒绝、`realpath` 二次校验防 symlink 逃逸。**这段写得扎实**，`path.test.ts`（85行）已覆盖。唯一遗漏：**没有对 workspace root 本身是 symlink 的情况做校验**——如果用户把 `margin-agent` 指向一个本身是 symlink 的目录，`fs.realpathSync(root)` 会解析到真实路径，后续校验都基于这个真实路径，逻辑上是安全的，但建议补一条测试用例显式验证这一点，而不是"隐式安全但没有测试兜底"。
- **CAS**：`applyApproved()`（`index.ts` 第375行起）+ `canApply()`/`textToApply()`（domain 层）机制完整，`baseRevision`+`baseHash`双重校验。**这是整个系统里做得最好的一块**，任何重构都不要碰这条路径的语义，只做实现层面的模块搬家。
- **多 workspace 并发**：目前 `AppState` 是单进程单 workspace 单例（`main()` 里 `path.resolve(process.argv[2] ?? process.cwd())` 只解析一次）。多工作区场景现状是"开多个 CLI 实例，各自不同端口"，这个模式本身没问题（每个实例锁自己的 `.margin/workspace.lock`），但**没有文档说明**用户应该怎么做（比如两个终端窗口分别 `pnpm start -- 路径A` 和 `pnpm start -- 路径B`）。这是文档缺口，不是代码缺口，成本很低，值得在短期内补一段到 `README.md`。

### 3.6 LLM 配置：resolve-model.ts 的生产级缺口

`packages/agent/src/resolve-model.ts`（151行）做了大量"猜测式"兼容逻辑：`apiFormat()` 从三个环境变量里猜、`authStyle()` 又根据 `apiFormat()` 和是否设了 `MARGIN_BASE_URL` 二次猜测、`resolveRuntimeApiKey()` 对 openai/anthropic 两种格式各自从三个可能的环境变量里按优先级取值。这套"猜测优先级链"目前工作是因为组合数量还少（CC Switch 预设 + 手动 BYOK + Ollama），但**这是一处典型的"隐式状态机"**——没有一个地方能一眼看出"给定这组环境变量，最终会解析成什么 provider/authStyle"。

建议（中期做，不阻塞短期）：把这套猜测逻辑改写成一个显式的**优先级表 + 单元测试矩阵**：输入是"当前设置了哪些环境变量/llm-settings.json 字段"的一个有限组合枚举，输出是确定的 `ResolvedRuntimeModel`，每一种组合都有一条测试用例断言结果，而不是靠阅读三层 if/优先级链去理解行为。这对"支持更多 pack/更多用户"的生产化很关键——BYOK 配置出错是目前最容易让新用户第一印象很差的地方（不是学术还是办公 pack 都会踩这个坑）。

---

## 4. 前端架构建议（深度）

### 4.1 交互模型评估：聊天优先 + 双栏，是不是通用正确壳

结合 §0 的"领导-员工"框架看现状 UI（`apps/web/src/App.tsx` + `Canvas.tsx` + `Chat.tsx`）：**这个壳形状是对的，不需要推翻**。

- 左画布右聊天，对应"员工的工作成果摊在桌上，领导可以边看边说话"——这个空间隐喻本身是通用的（不分学科/办公）；
- 首屏对话优先、开稿后才出画布（第11轮已做的纠偏）对应"领导先说清楚要干什么，员工才把材料铺开"，这个顺序也是对的；
- 选区右键"重写 / 按指令重写 / 讨论"三个动作，正是"指挥员工到具体段落"的三种粒度（分别对应"照你的判断改""照我这句话改""先别动手，聊聊看"）——这三个动作**应该被当成产品的核心语法**，比"聊天"或"画布"本身更值得在文档里强调。

**唯一需要指出的错位**：现在的"讨论"走的是 `generateDiscuss`（纯聊天，`packages/llm/src/agent-reply.ts`），而"重写"走的是 `runSessionTurn`（工具环，`packages/agent`）——这是两条完全不同的代码路径，对用户来说却是"同一个员工的两种反应模式"。这个分裂现在没造成明显 bug，但会在未来"整篇通读式指挥"（比如"把全文按新大纲重排"）这类需要"先讨论式思考、再动手写"的复合指令上露馅——因为两条路径之间没有共享状态转移的机制。中期应该让"讨论"也走同一个 `runSessionTurn` 工具环（只是不调用 `propose_*` 工具），而不是两条平行实现。

### 4.2 状态模型：client store 该不该引入

**该引入，触发条件已经成立。** `App.tsx` 现在有 12 个 `useState`（doc/blocks/proposals/comments/messages/busy/statusLine/selection/menu/bootError/settingsOpen/llm/composerPrefill/rewritePrompt）+ 一个 `busyGen` ref 做"串行操作里过期回调不生效"的手写乐观并发控制（`beginBusy`/`endBusy` 那对函数）。这套手写并发控制本身思路正确（用一个自增代和闭包比较来丢弃过期回调，是常见且有效的模式），但**它应该是 store 的一部分，不应该是组件局部变量**——一旦 `Settings`/`RewritePrompt`/`SelectionMenu`/`SelectionBubble` 四个子组件里任何一个将来需要感知"当前是否 busy、busy 的是哪个操作"，就必须继续往 `App.tsx` 加 prop，形成现在已经能看到苗头的"prop 炸弹"（`onRewriteDirected`/`onAcceptAll`/`onExportWord` 等一串回调层层下传）。

建议：新增 `apps/web/src/store.ts`，用一个显式 reducer（不必引入 Zustand/Redux 这类依赖，一个 `useReducer` + context 就够，团队目前规模不需要外部状态库）承载：`doc/blocks/proposals/comments`（服务端镜像数据）、`selection/menu/rewritePrompt/composerPrefill`（交互态）、`busy/statusLine`（异步态，替换掉手写的 `busyGen` 模式，reducer 天然能处理"后来的 action 覆盖先来的"）。三个视图（画布/聊天/设置）通过 `useContext` 各取所需 slice，`App.tsx` 收缩成"挂载三个视图 + 处理顶层副作用（API 调用）"的组合层，目标行数 <200（现状612行）。

### 4.3 TipTap 只读 vs 真编辑：下一刀砍在哪

现状 `Canvas.tsx` 用 TipTap 但 `editable: false`——**这是对的选择，先别改**。真正意义上的"可编辑画布"（用户直接在正文里敲字，而不是通过 E 决策提交编辑稿）会带来一个协议层难题：**用户直接编辑的内容要不要经过 CAS？要不要留痕？**——目前 `E` 决策（`editedText`）已经优雅地解决了"用户想改 Agent 的提案"这个需求，不需要真编辑器。

**唯一值得做的下一刀**：`E` 决策目前在前端走的是什么组件？看代码，`RewritePrompt.tsx`（72行）目前只用于"提交前的指令输入"，**没有找到"用户对已生成的 after 文本做二次编辑再提交"的 UI 路径**——也就是说"领导拿到员工写的稿子，自己顺手改两个字再签字"这个在 §0 判词里明确提到的动作，目前前端可能没有对应入口（Decision 的 `E` 分支在 domain/storage 层是支持的，但 UI 层需要确认/补一个"编辑提案文本"的文本框）。这是一个值得立刻核实的**功能缺口候选**，如果确实没有，应该是短期内优先级很高的一项——因为它是"领导亲自动手改"这个核心比喻在 UI 上的落地点，缺了它，"E"这个字母在实际使用中可能从未被走到过。

### 4.4 选区命令协议化

现状 `onSend`（`App.tsx`）里"接受全部/撤回全部/导出 Word/清空对话"这几个全局命令，是靠**正则匹配用户输入的自然语言文本**实现的（比如 `/接受全部|全部接受|accept\s*all/i`）。这是一种"命令行为寄生在聊天文本上"的设计，短期内能用，但有两个问题：
1. 用户如果打字习惯不同（比如"都接受了吧"），会命中不到正则，员工"听不懂"；
2. 这类正则判断和 §3.4 提到的 `open-intent.ts` 是同一类风险——**又一处散落在前端的确定性路由**，且和后端的 `PolicyRouter` 完全不对齐（一个在前端用正则判断，一个在后端用 policy 规则判断，两边概念上是同一件事却是两套实现）。

建议：把"接受全部/撤回全部/导出 Word/清空对话"这几个动作做成**聊天输入框旁边的显式按钮**（现状其实已经有 `onAcceptAll`/`onExportWord` 作为 Chat 组件的 props，说明已经有一半这么做了），**聊天文本里的自然语言判断逐步收窄成"兜底"而不是"主路径"**——主路径永远是按钮/右键菜单这类**协议级命令**，聊天框留给真正需要 Agent 理解意图的自由文本（"讨论""按指令重写"这类没法穷举成按钮的开放式指令）。同时把"重写/按指令重写/讨论"三个选区动作提升为 domain 层的 `SelectionCommandSchema`（§3.1 已提），前后端共享这个类型，而不是像现在这样分别用字符串常量拼装。

### 4.5 设计系统：敢给导师/领导看的审阅感

现状（`main.tsx`/CSS，第11轮提到"现代视觉 cool slate + teal；Fraunces/Outfit"）方向正确——**学术审阅场景的设计基调应该偏"信纸/审稿意见"而不是"聊天 App"**，衬线字体（Fraunces）用在正文、无衬线（Outfit）用在 UI chrome 的搭配是合适的选择，不建议推翻重做。

值得补的两点，都属于"让领导觉得这是正经审阅工具而不是聊天玩具"的细节：
1. **待裁决改动的视觉密度**：`batch-bar` 现在只显示"共 N 处待确认"这一句话，没有"本次改动风险分布"的视觉概览（比如几处是 language、几处是 structure/argument）。领导在签字前，天然想先扫一眼"今天员工交的这批活儿风险等级怎么分布"——这是一个低成本、高感知价值的信息展示，不需要新组件，只是在现有 `proposals` 数组上做一次 `groupBy(risk)` 统计。
2. **AI 使用披露草稿**：`MARGIN_PLAN.md` §3 里"Revision Packet"明确写了"可导出到 AI 披露草稿"，但现状 `exportPacket()`（`App.tsx`）导出的是原始 JSON（`revision-packet.json`），不是给导师/审稿人看的可读披露文本。这是产品宪法里承诺了、但代码里还没兑现的一处——值得列入短期任务（把 JSON 导出旁边加一个"生成披露文本"按钮，模板化地把 proposals 转成一段"本文修订过程中，作者使用 AI 辅助工具对以下 N 处提出修改建议，均经作者本人逐条审阅采纳/拒绝/修改后定稿"这类披露文案 + 逐条列表）。

### 4.6 模块化 UI：pack chrome 怎么在不 fork 两套 App 的前提下切换

现状 `Canvas.tsx`/`Chat.tsx` 里没有任何"学术专属 UI"硬编码（cite/style 侧注是数据驱动的 `Comment[]`，不是写死的组件），这是好消息——**前端目前反而比后端更接近"pack 无关"**。真正需要做的模块化 UI 工作只有一件事：`comments` 数组里 `source: "heuristic" | "agent"` 已经能区分来源，但**没有字段区分"这条侧注是不是学术专属工具产生的"**（比如 cite_check 的结果 vs 未来 office pack 可能有的"格式合规检查"结果）。建议给 `AgentComment`/`Comment` 类型加一个 `origin: "cite_check" | "style_lint" | "agent_note" | ...`（工具名本身），前端可以按需过滤展示——这样当 harness 切到非学术 pack 时，`commentsByBlock` 天然不会出现 cite/style 类批注，不需要为每个 pack 写一套条件渲染。

---

## 5. 功能建议（有依据，非 wishlist）

以下按"学术打透 / 通用协议增强 / 办公预留"三组分类，每条给依据和验收标准，供开发团队按优先级挑选，**不是要求全部做**。

### 5.1 学术打透组

1. **本地文献库核对**（cite_check 升级）：允许用户在 workspace 放一个 `.bib` 文件，`cite_check` 命中时标 `verification: "library_match"`（仍不联网核实真实性，只核实"用户自己声明库里有这个 key"）。依据：现状 `cite_check` 100% 是形态启发（正则），"未验证真伪"的免责声明虽然诚实，但用户会很快问"那你这工具到底验证了什么"——库内匹配是成本最低、风险最小的可信度提升。验收：`fixtures/` 下放一个测试用 `.bib`，命中/未命中两种情况各有单测。
2. **DOCX 往返回归**（用合成模板，不用真实机构模板）：自造 2-3 份包含标题层级/列表/引用块/脚注的通用测试 `.docx`（不带任何机构 logo/页眉），扩充 `fixtures/corpus/`，把往返门禁从"字符≥65%/标题≥80%"提到更高阈值。依据：这是产品承诺"DOCX 门禁"的兑现，且合成模板完全规避了机构背书风险。
3. **AI 披露文本生成器**（见 §4.5 第2点）：把 Revision Packet 转成可读披露文案。依据：这是 `MARGIN_PLAN.md` 明确写了但代码里缺失的承诺项。

### 5.2 通用协议增强组（学术/办公都受益）

4. **审阅时间线视图**：现在 `apply_events` 表已经把每次 Accept/Undo/Reapply 的历史存下来了，但前端没有任何地方把这条历史展示出来（只能看到"当前待裁决队列"）。领导视角天然需要"这篇稿子这几周经历了几轮返修、每轮改了什么"——这正是"Git for documents"这个比喻里最值钱的一层可视化，目前完全没做。建议：新增 `/api/v1/documents/:id/timeline` 只读接口，前端一个简单的折叠列表即可，不需要复杂可视化。
5. **`E` 决策的编辑入口补齐**（见 §4.3）：核实并补上"用户编辑 Agent 提案文本后再提交"的 UI 组件。
6. **提案风险分布概览**（见 §4.5 第1点）。
7. **多提案冲突提示**：`Canvas.tsx` 里已经处理了"同段多提案"（第16轮），但当用户对某段先后发起两次"重写"、旧提案还没决策时，UI 目前展示成什么样需要核实——如果是简单的"该段落多条待选"，应该明确提示"选一条采纳，其余会被 superseded"，否则用户可能误以为两条都会生效。

### 5.3 办公预留组（只做接口层准备，不做完整功能）

8. **`SelectionCommandSchema` 落地**（见 §3.1/§4.4）：这是唯一一项建议现在就做接口层准备的办公预留项，因为它是协议层的公共资产，不做会持续累积前后端字符串判断的技术债；其余办公具体功能（邮件模板、公文语气）严格按 §8 的"90天优先级"节奏推进，不在本节展开。

---

## 6. 模块化蓝图

### 6.1 依赖方向（单向，从下到上）

```
Surfaces      surface-web (TipTap 工作台)     surface-cli (无头/启动器)
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
Agent Runtime   session-runner.ts（只认识 ToolRegistry 接口，不 import 任何 pack）
                                    ▲
                    ┌───────────────┴───────────────┐
Packs         pack-academic                    pack-office（后续）
              （academic.ts / cite_check /       （空壳注册：仅 harness id +
               style_lint / 学术 harness 文案）    通用语气，无引用类工具）
                                    │
                                    ▼
Core          domain（Proposal/Decision/ApplyEvent + SelectionCommand）
              review-store（SQLite CRUD + CAS apply）
              workspace-fs（路径安全 + 文件 IO + DOCX）
              policy/（PolicyRouter，含 open-intent 规则）
```

**5 条边界规则**（对应 brief 必答清单第2问，"学术 pack 与办公 pack 的硬边界"，这里合并给出因为两者是对称约束）：

1. **Core 不 import 任何 pack**：`session-runner.ts`/`review-store.ts`/`workspace-fs.ts` 里禁止出现 `academic.ts` 或未来 `pack-office` 的任何符号引用；违反此规则的 PR 应该被 `scripts/check-pack-deps.mjs`（建议新增的一个简单静态检查脚本，扫 import 语句）挡住，不依赖 code review 记性。
2. **Pack 只能通过注册表暴露能力**：一个 pack 对外只导出 `{ harness, tools: AgentTool[], toolProfile: string[] }` 这一种形状，runtime 侧用 `getPack(id).tools` 组装工具面，不允许 runtime 侧对某个 pack 的内部函数做特殊 import（现在 `session-runner.ts` 直接 `import { heuristicComments } from "./academic.js"` 就是这条规则的反例，需要在拆分时改掉）。
3. **禁止编造类约束是 pack 的属性，不是 core 的属性**：`不得虚构文献/访谈引语`这类硬性规则写在 `pack-academic` 的 systemPrompt 里，`pack-office` 可以有自己的一套禁令（比如"不得虚构公司制度条款"），**core 不内置任何一条具体禁令文案**，只提供"pack 可以声明禁令文案，runtime 会拼进 systemPrompt"这个机制。
4. **工具命名不共享语义假设**：`propose_block_comment`这类通用工具名可以跨 pack 共享（在 core 层定义），但 `cite_check`/`style_lint` 这类工具名本身就是学术语义，必须只在 `pack-academic` 里注册，不能出现在 core 的默认工具列表里（这是本次评审最核心的一条修复）。
5. **Surface 层不感知 pack 身份，只感知数据**：`apps/web` 不应该出现 `if (harnessId === "social-science-zh")` 这类判断，一切差异通过数据驱动（§4.6 提到的 `comments[].origin` 字段就是这个原则的具体应用）——这样才能保证"不 fork 两套 App"。

### 6.2 与 Pi 模型的对照结论

Owner 设想的五层（Shell / Document Runtime / Agent Runtime / Packs / Surfaces）**基本合适，不是过度设计**，但可以合并一层：`Document Runtime`（分块/打开/hash/备份）现状就是 §3.2 提到的 `workspace-fs.ts` + 文档相关的 review-store 部分，不需要单独成一层抽象，归入 Core 即可——五层里真正需要"层"这个词的是 **Core / Agent Runtime / Packs / Surfaces** 四层，`Document Runtime` 降级为 Core 内部的一个模块，不需要对外暴露独立接口。owner 提到的"Policy / Disclosure / Export adapters"里，**Policy** 应该做（§3.4 已给方案），**Disclosure**（AI 披露）目前是 core 的一个导出能力（§5.1 第3点），**Export adapters**（DOCX 之外未来可能的其他格式）现状 `docx.ts` 已经是独立模块，等真的出现第二种导出格式时再抽象接口，现在不需要预先设计。

---

## 7. 文档内部表示：当前形态是过渡态，演进计划

Owner 提出的疑问很准确，值得单独成节：**现在这套"Markdown 按空行切块 + 5 类 kind 标签 + 内容 hash 当 blockId"的内部表示，明确是一个过渡态，不是终态**，下面给出证据、边界情况和分阶段演进路径，而不是笼统地说"以后再优化"。

### 7.1 现状精确描述

`chunkMarkdown()`（`packages/storage-local/src/index.ts`）做的事情：按 `\n{2,}` 切段落 → 用行首正则嗅探 `kind`（heading/blockquote/code_block/list_item/paragraph 五选一）→ **`blockId = "b" + sha256(\`${order}:${trimmed}\`).slice(0,12)`**。`blocksToMarkdown()` 反向拼接时只是把各 block 的 `text` 按 `order` 排序后用 `"\n\n"` 连接。DOCX 一侧（`docx.ts`）是完全独立的一次性变换：导入靠 `mammoth.convertToMarkdown`（社区库的默认有损转换），导出靠 `paragraphForBlock()` 把 5 类 kind 映射成 `docx` 库的段落（标题级别在这里被正则重新猜测一次，且封顶到 H3；列表项被打散成逐行独立段落，丢失真正的列表嵌套结构；不支持表格/图片/脚注/批注）。

### 7.2 这是过渡态的证据（不是主观判断，是可验证的具体问题）

1. **blockId 和 `order` 耦合，不是真正稳定的标识**：`MARGIN_PLAN.md` §6 曾承诺"稳定 `blockId`（UUIDv7 + alias 表处理 split/join）"，但代码现状既没有 UUIDv7，也没有 alias 表——**这是文档与代码的一处真实冲突，本文档裁决以代码现状为准，`MARGIN_PLAN.md` 该条应该更新为"当前已知限制"而不是继续挂着一条没兑现的承诺**。
2. **具体会触发问题的场景**：如果 workspace 里的 `.md` 文件被外部编辑器修改（比如用户手动在文中插入了一个新段落），下次 `openDocument()` 重新 `chunkMarkdown` 时，插入点之后所有 block 的 `order` 都会整体后移，而 `order` 是 `blockId` 哈希输入的一部分——**这意味着插入点之后的所有 block 会获得全新的 blockId，即使它们的文字内容完全没变**。任何指向这些 block 的、尚未裁决的 `Proposal`/`AgentComment` 会引用一个已经不存在的 `blockId`，既不会被 `supersedeOpenProposals` 自动清理（那套逻辑按 `blockId` 匹配，匹配不到就是静默失联），前端也无法把它们正确渲染回对应段落。**目前这条路径还没有被应用内工具触发**（因为 `propose_block_edit` 只做"替换已存在 block 的全文"，没有插入/删除/拆分/合并 block 的工具），但只要用户在外部编辑器动过文件结构，这个坑就是真实存在的，值得先补一个测试用例确认影响面，而不是假设"没人会这么做"。
3. **`contentHash` 不覆盖位置**：`contentHash()` 只对 `text` 做哈希，不含 `order`/`kind`。这意味着纯粹的"两个 block 互换顺序、文字都不变"这种编辑，CAS 校验（`baseHash` 比对）会认为"内容没变"，但实际语义已经变了——这是一个需要留意的边界情况，暂不构成紧急 bug（现状没有"调整顺序"这个用户操作入口），但设计新功能时要记住这条隐藏假设。
4. **DOCX 往返是单向近似，不是可逆变换**：标题级别封顶 H3、列表打散成逐行段落、无表格/图片/脚注/批注支持——这套映射对"纯文本、层级不深的社科论文正文"这个当前验证场景是够用的（`gate:docx` 门禁也是按这个场景设计的字符/标题保留率），但不构成一个通用的文档格式底座。

### 7.3 分阶段演进路径（不是现在就重写，只在信号出现时加码投入）

**近期（应纳入 §8 的候选，视 7.2 第2点测试结果决定优先级）**：
- 先补一个单测，验证"在已打开文档的 block 序列中间插入一段外部文字、重新 open，检查此前未决的 proposal/comment 是否失联"——如果测试证明这是可复现的真实数据丢失（大概率是），应该把它提到 §8 优先级第 2 位（仅次于 pack 解耦），而不是留到"中期模块化"再说，因为它是数据完整性问题，不是架构整洁度问题。
- 对应的最小修复成本很低：把 `blockId` 生成从 `hash(order:text)` 改成 `hash(text)`（丢掉 `order` 参与哈希），这样只要一个 block 的文字本身没变，无论前面插入/删除多少内容，它的 id 保持不变——**这一步不需要引入 UUIDv7 + alias 表这种重量级方案，先堵住"位置耦合"这个当前最实际的坑**。真正的"同一段文字被拆成两段"或"两段合并成一段"这种需要 alias 表才能追踪的场景，见下一阶段。

**中期（等真实需求出现再做，不预先设计）**：
- 只有当产品真的需要"Agent 建议插入新段落 / 删除段落 / 拆分或合并段落"这类**结构性编辑**时（现状完全没有这个能力，只有"替换已存在 block 的全文"一种编辑），才值得引入 `MARGIN_PLAN.md` 原计划的 UUIDv7 + alias 表——因为 alias 表存在的唯一意义就是"一个逻辑段落的历史 id 序列"，没有结构性编辑就没有这个需求。
- DOCX 往返如果要进一步保真（表格、多级列表、脚注），需要把现在 5 个 `BlockKind` 桶扩成更完整的节点类型集合，或者引入一个轻量的文档树/AST（不再是"纯文本 + kind 标签"这种扁平模型）。**这一步应该由"具体某份真实用户 Word 文档在 `gate:docx` 回归里失败"这个信号驱动**，不要在没有具体失败案例前预先设计一套大而全的 schema。

**长期（触发条件明确后再投入，现在不需要考虑）**：
- 触发条件二选一出现时，才值得把内部表示从"扁平 Markdown block"整体升级为"真正的文档树模型"（比如轻量 ProseMirror schema 或 OOXML 子集）：(a) 办公 pack 需要大量处理表格/多级列表密集的真实 Word 文档；(b) Agent 结构性编辑（增删段落）成为高频真实产品需求。这将是一次 **domain schema 的破坏性变更**（`BlockKind` 枚举和 `BlockSnapshot` 形状都要改），必须配合 `SCHEMA_VERSION` bump 和一次性的 `.margin/margin.db` 迁移脚本——现在不需要规划具体迁移方案，只需要在心理预期里承认"这一天迟早会来"，不要现在为了"面向未来"提前引入 AST，那是给一个还没被验证的需求做的过度投资。

**结论**：当前"flat block + Markdown 拼接"的组合，配合 7.3 近期提到的一个小修复（blockId 去掉 order 耦合），对"整段替换式 Y/N/E"这个当前唯一验证过的产品场景是够用的，不需要现在就动它的骨架。

---

## 8. 90 天优先级（≤7 项，含验收标准与明确不做项）

> 排序即优先级，前面的项目是后面项目的前提条件。

1. **把学术特化从 core 工具面里拆出去**（对应 §5.3 第8点、§6.1 规则2/4）：`cite_check`/`style_lint`/`heuristicComments` 从 `pi-tools.ts`/`session-runner.ts` 的硬编码 import 改成按 pack 注册表装配。**验收**：`grep -n "academic" packages/agent/src/pi-tools.ts` 为空；新增测试断言 `minimal` harness 的工具列表不含 `cite_check`/`style_lint`。**不做**：不需要现在就建第二个真实 pack-office，只需要证明"能装配、能不装配"。
2. **验证并修复 blockId/order 耦合导致的孤儿引用**（对应 §7.3 近期项，若测试证实为真会成为本轮优先级最高的正确性修复，非架构洁癖问题）：补单测确认"外部编辑插入段落后未决 proposal 是否失联"；若确认，将 `blockId` 生成方式从 `hash(order:text)` 改为 `hash(text)`。**验收**：新增测试覆盖该场景并通过；`pnpm test` 全绿。**不做**：不引入 UUIDv7 + alias 表（见 §7.3，留给结构性编辑功能出现时再做）。
3. **`SelectionCommandSchema` 落地到 domain 层**：把前端字符串判断的"重写/按指令/讨论"提升为共享协议类型。**验收**：`packages/domain` 新增 schema + 测试；`apps/web`/`apps/cli` 都引用它而非本地字符串常量。**不做**：不重构现有右键菜单 UI 的视觉样式，只换类型层。
4. **补齐 `E` 决策的编辑入口**（若核实确实缺失）：让"领导亲自改两个字再签字"这个核心比喻在 UI 上真正可用。**验收**：`docs/MVP.md` 30秒自检新增一步——对某条待裁决改动点"编辑"，改完提交后走 `Decision.kind = "E"` 落盘。**不做**：不做富文本编辑，纯文本框足够。
5. **拆 `storage-local` 为 workspace-fs / review-store / llm-config 三个内聚模块**：物理搬家，不改行为。**验收**：`pnpm test` 全绿；三个模块各自的单测覆盖不下降。**不做**：本阶段不拆成独立 pnpm 包，先拆文件验证边界。
6. **`App.tsx` 状态收口到显式 store**：解决 §4.2 提到的 prop 炸弹和手写并发控制。**验收**：`App.tsx` <250 行；`pnpm -F @margin/web build` 通过；现有手动路径回归无异常。**不做**：不引入 Zustand 等外部依赖，`useReducer` + context 足够。
7. **Agent transcript 落盘 + `PolicyRouter` 正规化**（两项都是运行时卫生工作，合并为一项）：新增 `agent_transcripts` 表保存最近 N 轮工具调用序列；`open-intent.ts` 并入 `packages/agent/src/policy/` 成为 `PolicyRouter` 的一条规则，前端"接受全部/导出 Word"类正则判断收窄为按钮兜底。**验收**：重启后能查到上一次会话的工具调用记录；新增 `policy/router.ts` 且有 ≥6 条真实话术单测。**不做**：不做完整可回放 UI；不引入 embedding/意图分类模型。

---

## 9. 必答 checklist（逐条作答）

**1. Core 最小集合是什么？**
`packages/domain`（含新增 `SelectionCommandSchema`）+ `workspace-fs`/`review-store`/`llm-config`（现 `storage-local` 拆分后的三个模块）+ `packages/agent` 里去除 academic 依赖后的 `session-runner.ts`/`pi-tools.ts`（仅通用工具）+ `policy/`。不含任何 harness 具体文案、cite/style 规则。

**2. Academic pack 与 Office pack 的硬边界各 5 条？**
见 §6.1 五条通用边界规则——这五条对两个 pack 是对称约束，不需要分开写两组不同规则，"硬边界"本身就应该是同一套约束应用在不同 pack 上，而不是各自另有一套。若一定要分列举例：Academic 独有——`cite_check`/`style_lint`工具、"禁止编造引文/访谈"禁令文案、`social-science-zh` harness id、`.bib`库对接、DOCX院校级门禁阈值。Office 独有（预留，非现在实现）——不含引用类工具、语气/合规类禁令文案（如"不得虚构制度条款"）、独立 harness id、无 DOCX 学术门禁要求、可能需要的"内部/对外"语域区分。

**3. 是否继续以 `pi-agent-core` 为默认循环？替代方案与切换成本？**
继续。现状集成（`Agent` 类 + `AgentTool[]` + `subscribe` 事件流）干净，没有观察到 fork 冲动或深度侵入式修改。替代方案是自研极薄 tool-loop（不是 fork `pi-coding-agent`，是重写一个只有"发消息-收工具调用-执行-回填"的循环）。**触发条件**（达到任一即启动评估，现在不预研）：`pi-agent-core` 六个月无发布，或出现无法在一周内适配的破坏性变更。

**4. Offline planner：保留/删除/重命名正规化——选一？**
**正规化**（见 §3.4）。理由：它解决真实歧义消解问题、代码量小、目前没有失控迹象，删除是浪费已验证的价值，放任不管则会重蹈"意图路由器野蛮生长"的覆辙——正规化（划入 `policy/` + `PolicyRouter` 接口）是唯一既保留价值又控制生长的选项。

**5. 前端是否应引入显式 client store？触发条件？**
**应该引入，触发条件已经成立**（见 §4.2）：12 个 `useState` + 手写 `busyGen` 并发控制 + 层层下传的回调 prop，是"该抽 store 了"的典型信号，不需要再等更多信号出现。

**6. 未来 90 天唯一最重要交付是什么？**
把学术特化从 `packages/agent` 的通用工具面里剥离成可插拔 pack（§8 第1项）。验收命令：`grep -n "academic" packages/agent/src/pi-tools.ts` 无输出；用户可感路径：切到 `minimal` harness 后，侧边栏不再出现任何"cite_check/style_lint"字样的批注。

**7. 什么信号出现时应暂停办公扩展、先打透学术？**
北极星指标（每周完成"意见→审批→导出"的项目数）连续 4 周 ≤1；或任何一次学术场景里出现"cite_check 被用户误当作真实核实"的反馈（说明连最基本的免责边界都没传达清楚，此时去扩展办公只会把同样的信任问题复制一份）。

**8. 对 owner「圈子小、思维壁垒」判断：同意/部分同意/反对？**
**部分同意。** 学术圈子确实小、决策链长（导师影响力），这点判断没错；但"圈子小"不等于"协议价值小"——恰恰因为学术场景的验收标准最苛刻（禁止编造、审计要求高），在这个圈子里把协议做硬，反而是获得"办公场景可信度"最便宜的路径（办公客户不需要你证明"从未编造引文"，但如果你连学术这种最挑剔的场景都扛过审计，办公客户的信任成本反而更低）。所以"圈子小"不构成放弃学术优先的理由，反而是选择学术作为楔子的理由本身。

**9. 最大架构债 Top 3（按爆炸半径）？**
1. **学术特化写死进 core 工具面**（`pi-tools.ts` 硬 import `academic.ts`）——爆炸半径最大，因为它决定了"办公 pack"这个战略选项现在物理上不存在插槽，一旦要动，涉及 runtime/tools/harness 三处联动改造。
2. **Agent transcript 不落盘**——爆炸半径中等，短期内不影响功能，但一旦发生"Agent 编造了什么/为什么"这类需要复盘的信任事件，没有工具调用序列可查，只能死无对证，这对一个把"可审计"当作核心卖点的产品是致命的品牌风险。
3. **`storage-local` 单体 + `App.tsx` 状态群**——爆炸半径较小，属于正常 MVP 债务，拖着不还的成本是"新增功能越来越难改"，不是"战略选项被物理堵死"，优先级明确低于前两项。

**10. 若只能改一个公共抽象让模块化成立，改哪一个？**
**把 `AgentTool[]` 的装配点从"硬编码 import"改成"按 pack 注册表动态组装"**——即 `createSessionTools()`/`createPaperTools()` 不再直接 `import` 具体工具实现，而是接收一个 `ToolRegistry`（`{ packId: string } → AgentTool[]`）作为参数。这一个改动直接决定了 §6.1 五条边界规则里的 2、3、4 条能否成立——其余（domain 加 SelectionCommand、storage 拆分、前端 store）都是"值得做但不改变战略可行性"的工程债，唯独这一个是"改了模块化才成立，不改模块化就是一句空话"的抽象。

---

## 10. 附录：关键代码位置索引（供开发对照本文档）

| 主题 | 文件 |
|------|------|
| domain 契约 | `packages/domain/src/index.ts` |
| 学术特化耦合点（本轮核心修复对象） | `packages/agent/src/pi-tools.ts:5`, `packages/agent/src/session-runner.ts`（systemPrompt/heuristicComments 调用处） |
| 启发式规则（应下沉为 pack） | `packages/agent/src/academic.ts` |
| 确定性快路径（应正规化为 PolicyRouter） | `apps/cli/src/open-intent.ts` |
| 运行时模型解析（建议表格化） | `packages/agent/src/resolve-model.ts` |
| 存储单体（建议拆三模块） | `packages/storage-local/src/index.ts` |
| CAS / apply 语义（保持不动） | `packages/storage-local/src/index.ts:375`起 `applyApproved` |
| 路径安全 | `packages/storage-local/src/index.ts:31-62` `resolveWorkspacePath` |
| 前端状态群（建议收口 store） | `apps/web/src/App.tsx` |
| 只读画布 + 待裁决渲染 | `apps/web/src/components/Canvas.tsx`, `MarginBlockView.tsx` |
| 选区动作三态 | `apps/web/src/components/SelectionMenu.tsx`, `SelectionBubble.tsx`, `RewritePrompt.tsx` |
| harness 注册表（可作为 pack 起点） | `packages/harness/src/index.ts` |
