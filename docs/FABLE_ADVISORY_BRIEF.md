# Fable 顾问任务：Margin 架构与产品深度评审

**日期：** 2026-07-19  
**角色：** 独立架构 / 产品顾问（只读评审 + 书面建议；本轮不写代码）  
**读者：** 项目 owner  
**工作区：** `E:\margin`  
**决策用途：** 决定下一阶段模块边界、前后端重构优先级、以及「学术楔子 → 办公平台」的技术路线

---

## 0. 你要输出什么

请用中文写一份顾问备忘录（建议落盘为 `docs/advisory_memo_margin_fable.md`），至少包含：

1. **Executive Verdict**（半页内）：Go / Go with changes / Pivot / Pause，并给一条最硬的理由  
2. **产品定位裁决**：学术主攻 vs 办公扩展，如何分层而不做成「又一个万能写作助手」  
3. **后端架构建议**（深度）：包边界、Agent runtime、持久化、安全、模块化对标 Pi  
4. **前端架构建议**（深度）：工作台交互、壳与插件面、状态模型、与协议的耦合点  
5. **模块化蓝图**：哪些是 core / which are packs（academic / office），依赖方向必须单向  
6. **90 天优先级**（最多 7 项，可砍）：每项写验收标准，勿堆 wishlist  
7. **必答问题**（文末 checklist，逐条作答）

约束：

- 以仓库**现状代码**为准，勿只复述旧规划文档；若文档与代码冲突，指出冲突并裁决该听谁  
- 批评要可执行（改什么边界、砍什么、先做什么），避免空泛「要加强 UX」  
- 不要建议 fork `pi-coding-agent`；可以建议薄依赖 `pi-agent-core` / 自研极简壳  
- 不要默认上云 / Desktop / 多租户；除非证明本地壳已不够

---

## 1. 一句话产品（owner 当前意图）

**Margin = 本地优先的「可审计修订 Agent 工作台」。**  
隐喻：**Git for documents** —— AI 只提案；人 Accept / Undo / Rewrite；写回走 CAS。

战略校正（相对早期「只做社科论文」）：

| 层 | 意图 |
|----|------|
| **TAM / 叙事** | 瞄准**办公文档修订**（圈子更大）；学术圈小、思维壁垒高，不宜作为唯一市场叙事 |
| **楔子 / 主攻** | 仍然**主攻学术**（社科论文、审稿返修、证据约束、Harness）——用学术把协议做硬 |
| **平台形态** | 借鉴 **Pi 的极简壳**：小 host + 工具环 + 可插拔包；**模块化**，学术是第一个 pack，办公是后续 pack |
| **不做** | 学术版 Cursor 无审计乱写；降 AI 率；一键代写；虚构文献/访谈；首发 Desktop |

对外可说：

> 先把「提案—裁决—写回」做成办公通用协议；学术 pack 证明深度；办公 pack 放大市场。

---

## 2. 仓库现状（请对照代码）

### 2.1 Monorepo

```text
apps/
  cli/     Fastify localhost + Bearer；起服务、开浏览器、serve web dist
  web/     Vite + React + TipTap；聊天优先 → 开稿后左画布右聊
packages/
  domain/         Proposal / Decision / ApplyEvent + CAS 语义
  storage-local/  node:sqlite、.margin/、DOCX、llm-settings、路径安全 IO
  harness/        学科/风格 system prompt 模板
  llm/            generateProposal / streamDiscuss（Zod + BYOK）
  agent/          session-runner + pi tools + offline planner
```

脚本：`pnpm mvp` · `pnpm smoke` · `pnpm smoke:memory` · `pnpm gate:pi` · `pnpm gate:docx`

### 2.2 运行时事实

- **Host**：CLI 持有 workspace、DB、chat 串行队列、Accept/Apply；Agent **不直接 apply**  
- **Session Agent**：`runSessionTurn` —— 有 Key 时 pi 或 offline planner；同一工具面  
  - 工作区：`list_workspace_files` / `read_workspace_file` / `write_workspace_file` / `open_document`  
  - 论文：`propose_block_edit` / `propose_block_comment` / outline·cite·style 等  
  - `finish_turn`；Accept 仍在 host  
- **可用性纠偏（近况）**：常见意图走确定性 planner + 单次 LLM（避免事事整轮 pi）；选区「按指令重写」；讨论预填 composer；真 NDJSON 流式  
- **设置**：BYOK / CC Switch 导入 / 本地代理 `127.0.0.1:15721` Bearer  
- **内部格式**：Markdown 分块；UI 不强调 MD；DOCX 导入导出有 corpus 门禁  
- **未做**：云端、Desktop、真文献库、Zotero、稳定 `PI_GATE_OK` 产品级证明、可插拔 pack 系统

### 2.3 已知张力（请重点评）

1. **产品宪法 vs 代码形态**：文档写「不要做学术版 Cursor」，实现却在做 Cursor 形工作台（左文右聊 + Agent 工具）——正确读法应是「要工作台、不要无审计乱写」；请确认边界话术  
2. **pi 全会话 vs 确定性快路径**：为了好用已大量绕开 pi；是否与「用 Pi 壳做 harness」冲突？如何模块化后两者并存？  
3. **学术特化泄漏进 core**：`cite_check` / 社科 harness / 「勿虚构访谈」是否应下沉为 `pack-academic`，core 只保留 Proposal/CAS/工具总线？  
4. **前端状态**：React 本地 state + TipTap 只读画布；协议在服务端 SQLite——是否过早耦合、缺清晰 client store？  
5. **办公扩展风险**：一旦叙事变办公，极易做成 Grammarly/Notion AI 子集；如何用「可审计提案」差异化且不稀释学术楔子？

权威文档（可能滞后）：`MARGIN_PLAN.md` · `ROADMAP.md` · `docs/AGENT_ARCHITECTURE.md` · `docs/EXECUTION_PLAN.md` · `docs/USAGE.md`

---

## 3. Owner 想借鉴的 Pi 模型（请据此给模块化建议）

Pi（coding agent）可抽象为：

```text
极简 Host（会话 / 权限 / 工具调度）
  → Tool surface（窄、可测）
  → Model loop（可替换）
  → 工作区副作用受控
```

Owner 期望 Margin 类似：

```text
Margin Shell（本地服务 + 会话 + 鉴权 + CAS apply）
  → Document Runtime（分块、打开、hash、备份）
  → Agent Runtime（薄包 pi-agent-core 或不绑死）
  → Packs：
        pack-academic   （cite/style/harness/审稿话术）
        pack-office     （邮件/纪要/制度稿/商务语气… 未来）
  → Surfaces：
        surface-web     （TipTap 工作台）
        surface-cli     （无头 / 启动器）
```

请评审：**这样拆是否过度设计？** 若过度，给最小模块切分（≤5 个边界）。若不足，指出缺哪一层（例如 Policy、Disclosure、Export adapters）。

---

## 4. 请重点给建议的问题域

### 4.1 后端

- domain 契约是否够硬？`Proposal/Decision/ApplyEvent` 能否无痛支撑办公文档类型？  
- `storage-local` 与 agent 是否应再拆「Workspace FS」与「Review Store」？  
- Session offline planner（启发式路由）会不会长成第二套意图路由器？应删、收束，还是正式变成 `PolicyRouter`？  
- LLM 配置 / process.env 可变性 / 多 workspace：生产级缺口是什么？  
- 安全：localhost Bearer、路径穿越、写工具与「只提案」原则如何在办公场景防误伤？  
- 对标 Pi：工具 schema、timeout、abort、transcript 持久化，Margin 缺什么？

### 4.2 前端

- 聊天优先 + 开稿后双栏，是否是办公/学术共用的正确壳？  
- TipTap 只读 + 段旁提案 vs 真编辑：下一刀砍在哪？  
- 选区「重写 / 按指令 / 讨论」是否应升为**协议级 command**（而不只是 UI 糖）？  
- 流式、busy、串行 chat：客户端状态机该怎么画？  
- 设计系统：极简到什么程度仍保「敢给导师/领导看」的审阅感？  
- 模块化 UI：academic chrome（侧注、风险级）如何在 office 模式隐藏而不 fork 两套 App？

### 4.3 产品 / GTM 架构含义

- 「主攻学术、叙事办公」在信息架构上如何体现（landing、pack 开关、默认 harness）？  
- 哪些功能必须永远留在 academic pack，以免办公版被指责「AI 代写论文」？  
- 双轨云端阉割版是否还值得保留在路线图，还是与模块化壳冲突应降级？

---

## 5. 必答 checklist（请逐条回答）

1. Core 最小集合是什么？（用包名或文件夹级列表）  
2. Academic pack 与 Office pack 的**硬边界**各 5 条  
3. 是否继续以 `pi-agent-core` 为默认循环？替代方案与切换成本？  
4. Offline planner：保留 / 删除 / 重命名正规化——选一并说明  
5. 前端是否应引入显式 client store（或保持现状）——选一并说明触发条件  
6. 未来 90 天**唯一**最重要交付是什么？验收命令或用户可感路径是什么？  
7. 什么信号出现时，应暂停办公扩展、先把学术楔子打透？  
8. 对 owner「圈子小、思维壁垒」判断：同意 / 部分同意 / 反对，证据是什么？  
9. 最大架构债 Top 3（按爆炸半径排序）  
10. 若只能改**一个**公共抽象让模块化成立，改哪一个？

---

## 6. 阅读顺序（建议）

1. 本 brief  
2. `packages/domain/src/index.ts`（契约）  
3. `packages/agent/src/session-runner.ts` + `session-tools.ts` + `pi-tools.ts`  
4. `apps/cli/src/index.ts` + `chat-agent.ts`（host）  
5. `apps/web/src/App.tsx` + `components/Canvas.tsx` + `Chat.tsx`  
6. `packages/storage-local/src/index.ts`（CAS / DB）  
7. `MARGIN_PLAN.md` §0（宪法，注意可能滞后）  
8. `docs/EXECUTION_PLAN.md`（已完成轮次，对照现实进度）

---

## 7. Owner 附言（语气）

我们承认：早期做成了「批处理红笔后台」，后来纠偏成「论文 Agent 工作台」。  
现在要再升一层：**可插拔修订壳**——学术是尖刀，办公是版图；壳要极简如 Pi，包要可换。  
请狠一点评架构，少捧场；建议要能直接指导下一刀切哪里。
