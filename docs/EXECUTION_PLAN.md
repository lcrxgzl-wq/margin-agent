# Margin 执行计划（按此推进，少汇报）

> 起点：本地 MVP 已可用（`pnpm mvp` / `pnpm smoke`）  
> 原则：先功能可靠，后交互美观；不 fork Pi；云端排后

## 第 1 轮 — 本地可用增强版 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | M2 路径穿越测试与加固 | ✅ |
| 2 | Harness v0（`@margin/harness`） | ✅ |
| 3 | LLM Zod 校验 + 1 次重试 | ✅ |
| 4 | 块勾选生成 + 空 apply 错误 | ✅ |
| 5 | `pnpm test`（domain/harness/storage）+ smoke | ✅ |
| 6 | 文档 | ✅ |

## 第 2 轮 — Agent 扫描缝 ✅（未接真 pi loop）

| # | 项 | 状态 |
|---|----|------|
| 1 | `@margin/agent` + `runBlockScan` | ✅ |
| 2 | CLI 走 agent 包而非内联 LLM | ✅ |
| 3 | simple 默认；pi-core 真工具循环 | ✅ 第 3 轮 |
| 4 | test + smoke | ✅ |

## 第 3 轮 — pi 工具循环 + DOCX 门禁 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | `@earendil-works/pi-agent-core`：`list_blocks` / `get_block` / `propose_block_edit` / `finish_scan` | ✅ |
| 2 | `MARGIN_ENGINE=simple\|pi`；无 Key 时 fallback simple（`MARGIN_ENGINE_STRICT=1` 可关） | ✅ |
| 3 | DOCX 导入（mammoth→`.imported.md`）/ 导出（`docx` 包）+ API/UI | ✅ |
| 4 | `pnpm test` + `pnpm smoke` → `GOLDEN_PATH_OK` | ✅ |
| 5 | 仍不做 TipTap / 云端 / Desktop | ✅ |

## 第 4 轮 — pi 可观测 + DOCX 损失报告 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | pi：超时 / 回合上限 / fallbackReason / notes 可观测 | ✅ |
| 2 | paper tools 无 LLM 单测（list/get/propose/finish） | ✅ |
| 3 | DOCX 往返损失报告（块/标题/字数门禁）+ API/UI | ✅ |
| 4 | `pnpm test` + `pnpm smoke` → `GOLDEN_PATH_OK` | ✅ |

> 未做：真实 API Key 下的 pi 提案质量验收（本机无 Key）；cite_check 等扩展工具；Pandoc corpus。

## 第 5 轮 — Paper Agent 架构收口 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | GPT 审定 Go with changes → `docs/AGENT_ARCHITECTURE.md` v0.2 | ✅ |
| 2 | 默认 pi+fallback；STRICT；九工具面（含 propose_block_comment） | ✅ |
| 3 | cite_check `not_verified` + style_lint + outline/search | ✅ |
| 4 | comments 会话返回；capabilities preferredEngine | ✅ |
| 5 | test + smoke（smoke 显式 simple；pi 路径单测） | ✅ |

## 第 6 轮 — Agent 真可用 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | UI：engine / fallback / notes / cite 边界说明 | ✅ |
| 2 | AgentComment SQLite 落库 + API + 块旁/侧栏展示 | ✅ |
| 3 | simple/pi 扫描附带 cite/style 启发式侧注 | ✅ |
| 4 | `fixtures/agent-chapter.md` + `pnpm gate:pi`（无 Key → exit 2 skip） | ✅ |
| 5 | test + smoke 绿 | ✅ |

## 第 7 轮 — DOCX corpus + 自用收口 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | `fixtures/corpus/*` + vitest 往返门禁（chars≥65%，标题≥80%） | ✅ |
| 2 | DOCX 导出支持 list/blockquote | ✅ |
| 3 | 扫描默认勾选前 8 块、单次最多 12 块 | ✅ |
| 4 | 导出状态显示往返比率；`pnpm gate:docx` | ✅ |
| 5 | test + smoke 绿 | ✅ |

## 第 8 轮 — 论文 Agent 工作台（P0）✅

| # | 项 | 状态 |
|---|----|------|
| 1 | `apps/web` TipTap 画布 + Chat | ✅ |
| 2 | 文上 pending + Accept/Undo/Rewrite | ✅ |
| 3 | 选区右键：重写 / 讨论 | ✅ |
| 4 | 对话打开样章；`POST /api/v1/chat` | ✅ |
| 5 | CLI 默认服务 web dist；旧 UI → `/legacy` | ✅ |

## 第 8.1 — 工作台体验优化 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | pending 嵌在对应段落后，现/建议对照 | ✅ |
| 2 | 「有哪些文章」列表；重写需明确选区（修复误触发） | ✅ |
| 3 | 右键菜单贴边、快捷按钮 | ✅ |

## 第 8.2 — 侧注与批量操作 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | cite/style 侧注嵌在对应段旁 | ✅ |
| 2 | 画布状态条（生成中/写入中） | ✅ |
| 3 | 「接受全部」「撤回全部」「导出记录」 | ✅ |

## 第 8.3 — 导出与选区浮动条 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 对话「导出 Word」+ 快捷按钮 | ✅ |
| 2 | 选区浮动工具条（重写/讨论） | ✅ |
| 3 | 提案生成分步状态 | ✅ |

## 第 9 轮 — 会话流式 + 工具环进度 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | pi/simple `onProgress` → run.phase/steps → UI | ✅ |
| 2 | 讨论/闲聊走 `generateDiscuss`（无 Key mock） | ✅ |
| 3 | `POST /api/v1/chat/stream` NDJSON + 重写异步 runId | ✅ |
| 4 | test + smoke | ✅ |
| 5 | 仍不做云端 / Desktop | ✅ |

## 第 10 轮 — 短记忆 + pi 质量门禁 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 服务端 ChatMemory（12 轮）注入 discuss | ✅ |
| 2 | `GET/POST /api/v1/chat/history|clear`；UI「清空对话」 | ✅ |
| 3 | `pnpm smoke:memory`（无 Key） | ✅ |
| 4 | `gate:pi` 加强（rationale/risk/steps；无 Key → exit 2） | ✅ |
| 5 | 仍不做云端 / Desktop | ✅ |

## 第 11 轮 — 壳子纠偏（聊天优先 + 本地读写）✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 去掉选区块提示与冗余按钮；能力写进 `docs/USAGE.md` | ✅ |
| 2 | 首屏对话优先；打开文稿后再出画布 | ✅ |
| 3 | 工作区 read/write API + 对话「读取/新建/写入」 | ✅ |
| 4 | 现代视觉（cool slate + teal；Fraunces/Outfit） | ✅ |
| 5 | git init | ✅ |

## 第 12 轮 — 全套 Session Agent（去掉意图路由）✅

| # | 项 | 状态 |
|---|----|------|
| 1 | `@margin/agent`：`runSessionTurn` / offline+pi 同一工具面 | ✅ |
| 2 | CLI `/api/v1/chat` + `/stream` 全走 `runChatAgentTurn` | ✅ |
| 3 | 工具：list/read/write/open + paper propose；Accept 仍 host | ✅ |
| 4 | UI 展示工具步骤；提案经 Agent 落库后刷新 | ✅ |
| 5 | 无 Key → offline 工具环（非 regex 假 Agent） | ✅ |

## 第 13 轮 — BYOK 设置界面 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | `.margin/llm-settings.json` 持久化 + 启动 apply | ✅ |
| 2 | `GET/PUT /api/v1/settings/llm`（密钥脱敏） | ✅ |
| 3 | 打开后设置面板 + 常驻「设置」入口 | ✅ |

## 第 14 轮 — CC Switch 式接入 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 多 provider 配置 + 预设（代理/DeepSeek/Kimi/智谱…） | ✅ |
| 2 | 从本机 `~/.cc-switch` 导入 + 本地代理 `PROXY_MANAGED` | ✅ |
| 3 | pi Model 自定义 baseUrl / Bearer AUTH_TOKEN | ✅ |

## 第 15 轮 — 壳子 / 对话体验纠偏 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 去掉回复里的步骤尾巴；过滤生命周期进度 | ✅ |
| 2 | 统一 shell-bar + 活动条；现代化气泡/composer | ✅ |
| 3 | 开稿清选区；设置不硬挡首屏；离线少空转工具 | ✅ |

## 第 16 轮 — 真流式 + 可用性 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | discuss/pi/offline 增量 `onDelta`；NDJSON 真推送 | ✅ |
| 2 | 画布只读；同段多提案；设置「测试连接」 | ✅ |
| 3 | 开稿后快捷「接受全部 / 导出 Word」；chat 串行化 | ✅ |

## 第 17 轮 — 可用性快路径 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 确定性意图绕开慢 pi；中文问候 `\b` 修复 | ✅ |
| 2 | 选区「按指令重写」+ instruction 贯通 | ✅ |
| 3 | 讨论预填 composer | ✅ |

## 第 18 轮 — Fable §8 架构收口 ✅

依据 `docs/advisory_memo_margin_fable.md` §8：

| # | 项 | 状态 |
|---|----|------|
| 1 | Pack 解耦：`cite_check`/`style_lint` 出 core；`check-pack-deps` | ✅ |
| 2 | blockId 去 order 耦合 + 稳定性单测 | ✅ |
| 3 | `SelectionCommandSchema` + web 引用 | ✅ |
| 4 | `E` 决策 Edit 入口 | ✅ |
| 5 | storage-local → workspace-fs / review-store / llm-config | ✅ |
| 6 | App store（`App.tsx` &lt;250） | ✅ |
| 7 | PolicyRouter + agent_transcripts + 披露草稿 / 风险分布 / Harness 状态 | ✅ |

验收：`pnpm test` · `pnpm smoke` · `pnpm smoke:memory` · `pnpm check:packs`

## 第 19 轮 — Pi 主壳纠偏 ✅

三路审阅：`docs/review-pi-router.md` · `review-pi-prompts.md` · `review-pi-shell.md`

| # | 项 | 状态 |
|---|----|------|
| 1 | PolicyRouter Pi-first（有 Key 默认 pi；仅问候/身份/纯列表走 offline） | ✅ |
| 2 | harness 唯一人格 + `composeSystemPrompt` 工具附录 | ✅ |
| 3 | 共享 `runPiAgentLoop`；扫描去掉硬编码流程剧本 | ✅ |
| 4 | discuss 仅用 harness.systemPrompt | ✅ |

## 第 20 轮 — 全量 Pi ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | PolicyRouter：有 Key 一律 `pi_session`（仅 no-key / `MARGIN_ENGINE=simple` → offline） | ✅ |
| 2 | `runBlockScan`：有 Key 走 `runPiBlockScan`，不再因选区/指令强制 simple | ✅ |
| 3 | 选区重写 `preferSimple` 默认 false | ✅ |
| 4 | chat/stream 断线 `AbortSignal` + `sessionId` + 工具 abort 包装 | ✅ |

## 第 21 轮 — Writing Agent 提示词收口 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | harness 自称 writing agent；社科/minimal 提示词压到硬约束 | ✅ |
| 2 | tool appendix 只留能力边界（工具名交给 schema） | ✅ |
| 3 | UI/offline 文案对齐「写作 Agent」 | ✅ |

## 第 22 轮 — 下一步（归档）

1. 有 Key 时固化 `PI_GATE_OK` — 仍待  
2. 审阅时间线 UI — 仍待  
3. 原生 AgentMessage 跨重启恢复 — 仍待  
4. 仍不做云端 / Desktop

## 第 23 轮 — 写入契约清障 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | `write_workspace_file` / HTTP write 禁止覆盖已打开或已登记文稿 | ✅ |
| 2 | 新建 notes/data 仍可写；正文改动走 propose | ✅ |

## 第 24 轮 — Pi-short Core + Skills Loader ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | harness 压成身份/行为/证据/编辑契约四段 | ✅ |
| 2 | 内置 `skills/**/SKILL.md` + 摘要注入 + `load_skill` | ✅ |
| 3 | minimal / scan 不灌学术 skills 索引 | ✅ |

## 第 25 轮 — 首批技能行为门禁 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | `argument-revision-zh` / `source-grounded-writing` | ✅ |
| 2 | 无 LLM 行为门禁测试（技能正文 + load_skill + 写保护） | ✅ |

## 第 26 轮 — 文档交互轻收口 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | Chat hero / offline 身份文案对齐「定稿在你」 | ✅ |
| 2 | transcript 记录 `loadedSkills` | ✅ |

## 第 27 轮 — 会话恢复 + 审阅时间线 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | `agent_sessions` 落盘 Pi `AgentMessage[]`；启动 `restoreChatAgentState`；清空对话时清除 | ✅ |
| 2 | `GET /documents/:id/timeline` + 画布旁「审阅记录」折叠列表 | ✅ |
| 3 | `pnpm gate:pi`：本环境无 Key → `PI_GATE_SKIP`（exit 2）；有 Key 后应见 `PI_GATE_OK` | ⏭ SKIP |

## 第 28 轮 — 受控计算 pack + gate 收口 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 声明式 CSV 引擎（inspect / analyze / resultRef） | ✅ |
| 2 | `data-analysis` pack 四工具 + social harness toolProfile | ✅ |
| 3 | `propose_block_edit_from_results` Host 绑定数 + evidence | ✅ |
| 4 | skill `fill-table-from-csv` | ✅ |
| 5 | `pi-quality-gate`：hydrate + 拷贝 `.margin/llm-settings.json`；本机跑通 `PI_GATE_OK` | ✅ |
| 6 | 无界 bash / 云端 / Desktop | ❌ 明确不做 |

## 第 29 轮 — 维护态（非阻塞）

仅在有信号时做：PI_GATE 真跑通记录、XLSX、WASM 用户代码、时间线增强。默认停在可交付本地写作 Agent。

## 第 30 轮 — 前端交互水位（Grok/Kimi 构图） ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | Landing：品牌先行 + 一句支持文案 + 居中主输入；徽章/设置收右上 | ✅ |
| 2 | 浅色学术纸感大气氛；消息流去气泡卡片感；有稿左纸右聊 | ✅ |
| 3 | composer 聚焦 / hero 入场 / turn 淡入；窄屏分栏可用 | ✅ |
| 4 | 不做营销全屏大图、不重做 TipTap 可编辑、不引新 UI 框架 | ❌ 明确不做 |

## 第 31 轮 — 苏格拉底可选模式 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | `direct`（默认）\| `socratic`（可选）；设置区旁模式切换 | ✅ |
| 2 | skill `socratic-revision-zh`：模糊改稿可追问；同一线程最多 3 轮，满则按假设提案 | ✅ |
| 3 | chat/stream 传 `chatMode`；宿主注入澄清预算并计数 | ✅ |
| 4 | 选区「重写」保持 direct 快路径（proposal run，不经苏格拉底拦） | ✅ |
| 5 | 不做强制全局苏格拉底 / 复杂对话树 UI | ❌ 明确不做 |

## 第 32 轮 — 协作会话收口 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | `agent_sessions` 落盘 `chatTurns` + `clarificationRounds`（兼容旧数组格式） | ✅ |
| 2 | 启动 hydrate ChatMemory；`/session` 带回对话与澄清预算；前端恢复消息流 | ✅ |
| 3 | 红笔区 / 审阅时间线按钮中文化 | ✅ |

## 第 33 轮 — 全文可读 + 联动门禁 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | Scan：只读工具见全文；`propose` 限 primaryAllowlist | ✅ |
| 2 | 会话：选区外 propose 须确认集；`offer_cascade` 产出候选 | ✅ |
| 3 | skill `cascade-consistency-zh` + 改稿 hint + 大纲标题注入 | ✅ |

## 第 34 轮 — 联动确认卡 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | chat/stream 传 `cascadeBlockIds`；done 回 `cascadeOffer` | ✅ |
| 2 | CascadeCard：仅本地 / 改所选（≤3）；不计入苏格拉底预算 | ✅ |
| 3 | 不做静默全篇改写 / 一键 Accept 全文 | ❌ 明确不做 |

## 第 35 轮 — 多源资料会话（定性）+ 全库收敛 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 工作区资料支持 `md/markdown/txt/csv`；chat/stream/session 贯通 `sourcePaths`，同稿恢复、切稿清空 | ✅ |
| 2 | `read_workspace_file` 有界分段读取：`offset/limit/nextOffset/hasMore/sourceRef` + 同轮缓存 | ✅ |
| 3 | `propose_block_edit.evidence` 仅接受已挂资料路径/sourceRef；段旁提案显示依据路径 | ✅ |
| 4 | Web 紧凑资料挂载器：多选、已挂 chips、移除、主稿排除；不引入新 UI 框架 | ✅ |
| 5 | 存储边界收紧：隐藏内部目录、链接/junction 越界、hardlink、正文路径别名均拒绝；正文仍仅 proposal → Accept/CAS | ✅ |
| 6 | 全库正确性收敛：Pi 非成功 outcome 不再伪完成；stale/missing/N 时间线、apply 串行与失败恢复、披露 decisions 关联 | ✅ |
| 7 | 效率：未变文稿打开不重写 blocks；proposal SQL 索引/状态下推；run/transcript/session 有界；表格聚合提前校验 | ✅ |
| 8 | Web：TipTap 统一 2.27；pending 单事务；流式 delta 合帧；Canvas memo；编辑器懒加载，首包约 `608 kB → 289 kB` | ✅ |
| 9 | 验收：`pnpm test` 111/111、typecheck/build、`GOLDEN_PATH_OK`、`CHAT_MEMORY_OK`、DOCX gate、`PI_GATE_OK`（2 proposals / 8 comments / 22 steps） | ✅ |
| 10 | 不做无界 shell/Python、Agent 直接 apply、云端/Desktop 或量化 scope 扩张 | ❌ 明确不做 |

## 第 36 轮 — BYOK API 设置主路径 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 设置主路径收敛为 `Base URL → API Key → 获取模型 → 选择模型 → 测试 → 保存并使用`；CC Switch/预设降到高级设置 | ✅ |
| 2 | 新增 OpenAI/Anthropic 模型发现：兼容 `/models` 与有界 `/v1/models` 回退，返回去重后的模型列表与 `latencyMs` | ✅ |
| 3 | 连接测试直接使用未保存表单并验证所选模型；失败不写配置，Anthropic 不再把 401/404 误报为成功 | ✅ |
| 4 | Web 显示模型下拉、发现/测试毫秒状态；桌面与 390px 窄屏均完成真实浏览器交互复验 | ✅ |
| 5 | 探测限制 http(s)、禁止 URL userinfo/重定向、10 秒超时、1MiB 响应、500 个模型；旧 Key 仅同目标复用且不跨协议 | ✅ |
| 6 | 验收：`pnpm test` 134/134、全库 typecheck/build、`GOLDEN_PATH_OK`、`CHAT_MEMORY_OK`；mock provider 端到端发现/测试/保存通过 | ✅ |

## 第 37 轮 — API 设置状态机返工 ✅

第 36 轮的多 profile/预设/CC Switch 交互已撤下，以下单配置契约取代其 UI 行为。

| # | 项 | 状态 |
|---|----|------|
| 1 | 单配置本地草稿：读取模型、测试、协议切换、取消/关闭均不写盘；只有“保存并使用”可修改配置与 runtime | ✅ |
| 2 | 删除 profile 下拉、预设、CC Switch 导入、即时清 Key；清 Key 改为“保存时移除”的显式草稿动作 | ✅ |
| 3 | 模型发现只填列表，绝不自动选择首项；协议/鉴权切换不联动修改 URL、Key 或模型 | ✅ |
| 4 | 发现/测试返回实际 `resolvedBaseURL`；`/v1` 回退或完整 endpoint 规范化须由用户显式采用 | ✅ |
| 5 | OpenAI-compatible 探测与 Pi runtime 统一走 chat completions；Anthropic/runtime 共用 canonical Base URL | ✅ |
| 6 | 已存 Key 改为 active 配置、同 canonical target、显式 opt-in 才复用；换目标必须输入新 Key 或明确移除 | ✅ |
| 7 | 真实浏览器状态门禁：协议切换不改字段、两次发现均未自动选模、测试/取消零写盘、仅最终保存写入 | ✅ |
| 8 | 验收：`pnpm test` 143/143、全库 typecheck/build、`GOLDEN_PATH_OK`、`CHAT_MEMORY_OK`；桌面/390px 复验通过 | ✅ |

## 第 38 轮 — Pi 流式会话取消链修复 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | CLI 不再把正常的 request `close` 当成断线；仅 request `aborted` 或未完成 response `close` 才取消会话，排队期间断开则跳过执行 | ✅ |
| 2 | 外部取消直接调用 Pi core `agent.abort()`，及时停止模型与工具，不在客户端断开后继续落状态 | ✅ |
| 3 | 新增流生命周期与 Pi external signal 回归测试；真实 DeepSeek `.Margin` 流返回 `done` | ✅ |
| 4 | 验收：`pnpm test` 149/149、全库 typecheck/build、`GOLDEN_PATH_OK`、`CHAT_MEMORY_OK` | ✅ |

## 第 39 轮 — 本地 DOCX 路径直导 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 聊天识别用户明确给出的独立绝对 `.docx` 路径，由 Host 受控导入；不向 Agent 开放任意磁盘读取 | ✅ |
| 2 | 外部 DOCX 限 50 MiB；第 40 轮起改为唯一 `imports/*.docx` 原生工作副本，原文件不修改、重复导入不覆盖正文 | ✅ |
| 3 | session 重建当前 document bag；Web 启动恢复画布、提案、评论和资料挂载；聊天 hydrate 即时滚到最新结果 | ✅ |
| 4 | 真实 `E:\academic\spviolence\sport value.docx`：导入 136 段、11,699 字符、无 U+FFFD；Edge 截图确认正文与最新导入结果可见 | ✅ |
| 5 | 验收：`pnpm test` 154/154、全库 typecheck/build、DOCX gate、`GOLDEN_PATH_OK`、`CHAT_MEMORY_OK` | ✅ |

## 第 40 轮 — 原生 DOCX 内核 + Office 分页画布 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | Word 主路径从 `DOCX→Markdown` 改为原生 DOCX/OOXML；表格索引为结构块，段落提案只精确替换目标 `w:p` | ✅ |
| 2 | Web fork MIT `canvas-editor-plugin-docx` 适配层并接入 `canvas-editor`：分页、表格、格式、对齐、插表、缩放、阅读/编辑、显式保存 | ✅ |
| 3 | 人工保存走 revision/hash CAS、备份与空导出保护；Agent 表格纯文本替换拒绝为 `unsupported`，提案仍只经 Y/N/E | ✅ |
| 4 | 绝对 DOCX 路径由 Host 受控复制为 `imports/*.docx`；取消无 Key 自动弹设置，停止运行期 CC Switch 用户目录探测 | ✅ |
| 5 | 效率：Office/Markdown/保存器互斥懒加载；Office 打开 chunk `1.81 MB → 1.10 MB`；消除表格单元格双重递归与按键整稿深拷贝 | ✅ |
| 6 | 真实 `sport value.docx`：9 页、31×5 表格、无 U+FFFD；键盘编辑→保存→重载通过，桌面/390px 浏览器复验 | ✅ |
| 7 | 验收：`pnpm test` 164/164、全库 typecheck/build、DOCX/Office/Golden/Memory 门禁；`PI_GATE_OK`（2 proposals / 7 comments / 15 steps） | ✅ |

## 第 41 轮 — 绝对 DOCX 打开状态闭环 ✅
| # | 项 | 状态 |
|---|----|------|
| 1 | 对话中的唯一带引号绝对 DOCX 路径可带自然语言指令；多路径歧义仍拒绝 | ✅ |
| 2 | 无真实 `opened/documentId` 时，Host 拦截“已打开/已加载”类模型宣称；打开状态请求先缓冲再验证 | ✅ |
| 3 | 清理失败会话后真实导入 `sport value.docx`：46 个 OOXML 块；浏览器确认 Office 编辑器、文档名、8 个分页 canvas 与非空正文 | ✅ |
| 4 | 验收：CLI test/typecheck/build；全库 `pnpm test` 165/165 | ✅ |

## 第 42 轮 — Office 协作闭环 + Provider 可用性返工 ✅

| # | 项 | 状态 |
|---|----|------|
| 1 | 选区“重写 / 按指令 / 翻译 / 润色”统一走无工具 direct proposal；Host 只替换唯一选中片段，保留块外文字与 Y/N/E 契约 | ✅ |
| 2 | DeepSeek 配置纠正为 OpenAI-compatible `/v1` + Bearer；模型发现与连接测试真实返回模型列表和毫秒数；探测预算避免 reasoning-only 假失败 | ✅ |
| 3 | 设置联动：切换协议自动规范 URL 后缀与鉴权默认值，显示最终 completion endpoint；读取/测试不落盘，保存才生效 | ✅ |
| 4 | Office 深定制：字体/字号、格式、对齐、缩放、阅读/编辑、边注 dock；桌面三档左右布局，窄屏审阅独占视图 | ✅ |
| 5 | 浅色 / 深色 / 跟随系统三档主题持久化；深色只改应用 chrome，纸张保持白底 | ✅ |
| 6 | DOCX 清晰度与表格：有效 canvas backing ratio 均为 2；真实 31×5 表格、列宽及 14 个纵向合并恢复 | ✅ |
| 7 | Word 域保护：隐藏 `instrText/ADDIN` 不再进入块文本，Agent 的普通单行段落 patch 保留 field OOXML、超链接与 run 结构；DOCX 解压设单项/总量上限 | ✅ |
| 8 | 文稿状态闭环：关闭真实卸载；旧标签页不能切回旧稿；切稿清理 Pi history/资料/澄清并立即持久化 | ✅ |
| 9 | 效率：保存不再重建整个 Office 实例；选区索引缓存并按段序消歧；Accept 直接复用后端 blocks；资料未变跳过目录扫描；Object URL 及时释放 | ✅ |
| 10 | 极简运行状态：移除常驻模式/澄清/进度条，只在 composer 显示状态点；边注不覆盖正文 | ✅ |
| 11 | 验收：`pnpm test` 187/187、全库 typecheck/build、DOCX/Office/Pi 门禁；真实选区翻译提案无 `tool_choice`/`ADDIN` 泄漏 | ✅ |

## 第 43 轮 — 原生审阅交互与全库效率收口 ✅
| # | 项 | 状态 |
|---|----|------|
| 1 | 统一 Sidecar：对话/审阅常驻状态，支持停靠、悬浮、专注文稿与移动端底部抽屉；移除 Office 内部审阅栏和常驻进度条 | ✅ |
| 2 | 选区翻译/润色/改写走无工具 direct proposal；仅替换选中文字，拒绝双语夹原文和 full-block 返回，失败自动重试一次 | ✅ |
| 3 | Proposal operation 严格校验 selection 范围及 before/after 组合；损坏结构化提案禁止退化为整段处理 | ✅ |
| 4 | 单条 Y/N/E 使用显式 proposal resolve；校验文稿身份、并发 claim、响应丢失 replay、进程中断恢复与撤回历史 | ✅ |
| 5 | 审阅刷新增加 request generation、document/revision guard；Accept All 中途失败强制与磁盘工作副本 reconcile | ✅ |
| 6 | API 设置收敛为 URL + Key → 读取模型 → 选择模型 → 毫秒测试 → 保存；OpenAI/Anthropic 自动规范后缀与鉴权默认值 | ✅ |
| 7 | 主题与布局：浅色/深色/跟随系统，修正深色按钮对比度、弹窗/选区/Sidecar 层级和浮窗视口恢复 | ✅ |
| 8 | 效率复审 159 个源码文件：同轮块索引由 `3×O(N)` 降为 `1×O(N)`；浮窗 localStorage 写入改为 180ms trailing debounce | ✅ |
| 9 | Office 门禁改为单一 BrowserContext/Page，并等待字体、有限动画和双帧绘制稳定后截图；不再用重复开页验证 | ✅ |
| 10 | 验收：`pnpm test` 212/212、全库 typecheck/build、DOCX gate、`PI_GATE_OK`；真实 `sport value.docx` 为 46 blocks、10 pages、31×5 table、canvas backing ratio ≥1.8 | ✅ |

## 第 44 轮 — 保真保存、资料扩展与模块边界收口 ✅
| # | 项 | 状态 |
|---|----|------|
| 1 | 人工普通段落改字优先原位 patch DOCX OOXML，保留未触碰的页眉页脚、域、批注和表格；格式/结构修改必须确认后才重建工作副本，并返回 `ooxml_patch` / `rebuilt` 保存模式 | ✅ |
| 2 | 启动时对账磁盘 DOCX 与 SQLite hash：外部变化重新索引、revision 前移并 supersede 旧提案；中断遗留的 Y/E/N decision 自动恢复或回到可重试状态 | ✅ |
| 3 | 聊天流支持显式“停止生成”，浏览器断流触发 Host/Pi abort，不再以 `aborted by external signal` 作为普通回复暴露 | ✅ |
| 4 | 只读资料扩展到 `pdf/docx`：文本层 PDF 有页数/大小/字符上限，DOCX 复用 OOXML 提取；继续使用有界分段读取和 evidence 路径约束 | ✅ |
| 5 | 工作区 Skill 可从文件或文本导入 `.margin/skills/<name>/SKILL.md`，同名覆盖内置项，下一轮进入 skills 索引；仅加载方法文本，不执行 Skill 附带脚本 | ✅ |
| 6 | 远程 MCP 支持 Streamable HTTP：只允许用户显式勾选且服务器声明 `readOnly` 的工具，调用前重新校验，结果仅作上下文；Token 只存本地、API 不回传明文且远程发送强制 HTTPS，禁止重定向，明确不支持 stdio/命令启动 | ✅ |
| 7 | 未配置 MCP 时不向 Agent 暴露 MCP 工具；移动端 Office 按可用宽度自动 fit，手动缩放后尊重用户设置 | ✅ |
| 8 | 正确性与效率复审：选区 replacement/operation 全链校验、旧请求 generation guard、块索引同轮复用、浮窗位置写盘 debounce；未发现新的无界会话内存或明确 N+1 查询 | ✅ |
| 9 | 验收：`pnpm test` 221/221、全库 typecheck/build、DOCX gate、`PI_GATE_OK`（3 proposals / 7 comments / 25 steps）；真实 `sport value.docx` 为 46 blocks、10 pages、31×5 table，纯文本人工保存强制 `ooxml_patch`，单页桌面/表格/390px 门禁通过 | ✅ |
| 10 | OCR、可执行 Skill、stdio MCP、无界 shell/Python、Agent 直接 apply 原文 | ❌ 明确不做 |

## 第 45 轮 — 扩展管理与移动端阅读优化 ✅
| # | 项 | 状态 |
|---|----|------|
| 1 | Extensions 改为 `Skills / MCP` 两个 segmented tabs；内置与工作区 Skill 分组展示，工作区 Skill 可确认后删除，内置项不可删除 | ✅ |
| 2 | Skill 删除校验合法名称、真实目录、frontmatter 一致性、单链接普通文件；拒绝越界、symlink/junction/hardlink，仅删除目标 `SKILL.md` 和空目录 | ✅ |
| 3 | 已配置 MCP 可直接编辑和重新读取；保留用户最新勾选，URL 改动立即清除旧 serverId/Token 复用状态 | ✅ |
| 4 | MCP 重新发现仅在 `serverId + normalized URL` 完全匹配时由 Host 复用本地 Token，API 仍不回传明文；跨 URL 必须重新输入凭据 | ✅ |
| 5 | 选区翻译夹原文检测统一 NFKC、空白和大小写归一，短选区不再漏检；审阅操作明确显示 `Y 接受 / E 编辑 / N 撤回` | ✅ |
| 6 | 手机 Office 阅读缩放下限由 42% 提升到 72%，允许横向滚动；缩放组固定在工具栏前部，百分比按钮可在阅读缩放与 100% 间切换 | ✅ |
| 7 | Office 首开包实测约 `727 kB raw / 219 kB gzip`，仅在打开 DOCX 后懒加载；无真实减字节的安全拆分点，不用 manualChunks 制造额外 waterfall | ✅ |
| 8 | 真实表格复核：31×5、14 个纵向合并起点/57 个延续、网格宽未超版心、无多段单元格或 `w:br/w:cr`；不以猜测改动解析器 | ✅ |
| 9 | Office 单页门禁新增 Extensions 生命周期与截图、移动缩放 `72% → 100% → 72%`、最小表格字体约 9.6px 断言 | ✅ |
| 10 | 验收：`pnpm test` 232/232、全库 typecheck/build、DOCX gate、`PI_GATE_OK`（3 proposals / 8 comments / 28 steps）；真实 `sport value.docx` 仍为 46 blocks、10 pages、31×5 table，`ooxml_patch` 保存与桌面/扩展/表格/390px 截图通过 | ✅ |

## 第 46 轮 — Agent 桌面 Word 保真与单元格审阅闭环 ✅
| # | 项 | 状态 |
|---|----|------|
| 1 | 人工 DOCX 保存改为先尝试 OOXML 原位移植；Canvas 只上报本次真实变更的稳定 OOXML blockId，未触碰的域、引文、书签、批注、页眉页脚和其它 ZIP parts 不再因编辑器往返差异触发整篇重建 | ✅ |
| 2 | 段落文本、字体、字号、粗体/斜体/下划线、对齐、缩进和行距可在原包移植；结构变化仍返回 `rebuild_required`，并向用户显示具体不兼容块/结构原因 | ✅ |
| 3 | 表格进入现有不可变 Proposal / Decision / ApplyEvent 队列：Agent 只能提交精确 A1 单元格 before/after，Y/E/N 复用同一审阅与崩溃恢复，禁止整表 replacement | ✅ |
| 4 | 单元格 Host resolver 支持 `gridSpan` 逻辑列，合并单元格只接受左上地址，拒绝纵向合并 continuation、多段单元格和陈旧 before；仍执行文稿 revision/hash + table block hash CAS | ✅ |
| 5 | Office 选区贯通 `row/column/address/before`；翻译、润色、重写和聊天中的短指令均生成单元格提案，不直接改原文，不再返回“表格选区不可用” | ✅ |
| 6 | 修复单元格提案持久化错误：校验目标 table block 的 `contentHash/baseHash`，不再错误地用 cell before 重算整块 hash 后静默丢弃 | ✅ |
| 7 | Workspace Skill 同名导入必须确认；MCP 支持重新读取、只读工具恢复、URL 改动清除凭据复用，以及显式 `clearToken`；消息上限 120、单一 active abort 和 revision/generation guards 保持 | ✅ |
| 8 | 主题 `浅色 / 深色 / 跟随系统`、悬浮/停靠/专注文稿布局和可调侧栏继续作为桌面一等能力；PDF 与移动端本轮冻结，不扩大范围 | ✅ |
| 9 | 真实 Office 门禁只复用一个 Browser Page：`sport value.docx` 为 46 blocks、10 pages、31×5 table；文字+加粗保存为 `ooxml_patch`，A1 走 E 写回并同页重载，52 个域、20 个书签和表格拓扑保持 | ✅ |
| 10 | 验收：`pnpm test` 263/263、全库 typecheck/build、DOCX corpus、`PI_GATE_OK`（2 proposals / 7 comments / 25 steps）、`OFFICE_NATIVE_GATE_OK`；无持久服务 | ✅ |

## 第 47 轮 — 多资料研究闭环与写入可靠性收口 ✅
| # | 项 | 状态 |
|---|----|------|
| 1 | Session task 持久化 `running/completed/interrupted`、选区起点与资料路径；中断后“继续”恢复原任务，不把外部 abort 文案暴露给用户 | ✅ |
| 2 | 多资料回执记录实际读取的 sourceRef、提案数和全文联动检查；提案 evidence 只能引用本轮真实读取返回的 `path#sha256=...&chars=start-end` | ✅ |
| 3 | 资料挂载立即持久化；evidence 可展开原文上下文并高亮精确范围，资料变化后旧 sourceRef 显式报 stale | ✅ |
| 4 | 选区翻译/润色/重写仅在明确要求资料支撑时注入已挂资料；生成后保留选区，表格候选重写继续绑定原单元格 | ✅ |
| 5 | proposal run 支持 DELETE/AbortSignal；取消或新任务取代后晚到结果不得落盘，Pi abort 不回退到 simple，候选版本可并存 | ✅ |
| 6 | Office 审阅定位按 blockId/重复 occurrence/单元格坐标消歧并显式滚动；DOCX revision 异步加载使用 generation + AbortController，旧响应不能覆盖新正文 | ✅ |
| 7 | 启动恢复顺序修正：保留已提交 `decided`，先恢复 Y/N/E 再对账外部 DOCX；close→reopen 回归通过 | ✅ |
| 8 | Agent apply 增加持久化 journal：正文已替换而 SQLite 未提交时，下次启动按磁盘 hash finalize；未替换则清 journal 并重试 decision | ✅ |
| 9 | 人工 DOCX 保存与 Agent apply 共用文稿级串行队列并在异步 OOXML 处理后二次校验磁盘 hash；所有文稿统一 50 MiB 打开上限，超大 HTTP 响应主动取消 body | ✅ |
| 10 | 外部 Markdown 变更重新打开时 supersede 旧提案；补 task selection、stale sourceRef、Office 旧 revision、共享写入队列和 TOCTOU 回归 | ✅ |
| 11 | 验收：`pnpm test` 273/273（后续补测增至 278）、全库 typecheck/build、DOCX corpus、`PI_GATE_OK`（3 proposals / 7 comments / 16 steps）、真实 `sport value.docx` `OFFICE_NATIVE_GATE_OK`（46 blocks / 10 pages / 31×5 table） | ✅ |
| 12 | 不扩展 PDF/OCR、移动端主战场、无界 shell/Python、Agent 直接 apply、云端或 Desktop | ❌ 明确不做 |

## 第 48 轮 — 选区保真、交互安全与全库验收 ✅
| # | 项 | 状态 |
|---|----|------|
| 1 | DOCX Agent 选区 Y/E 写回改为 selection-aware OOXML patch：只替换目标 visible text leaves，保留选区外 run、超链接、域和字段结构；E 从人类提交的完整目标文本反推出最终 replacement，越界编辑拒绝 | ✅ |
| 2 | 补选区跨 run、跨超链接、E 决策和 review-store Accept 集成回归；避免原有按旧 run 长度重分配导致翻译变长后粗体/斜体边界漂移 | ✅ |
| 3 | Office 跨段/多段单元格选区不再静默掉入通用 Pi/tool-loop；显示受控不可改原因，单段仍走无工具 direct proposal；前端与 Host 读取边界都阻断多段表格，保持正文只经 Proposal → Y/N/E | ✅ |
| 4 | 深色主题 Office active/mode/save/disabled 控件改用完整主题 token，补齐浅色/深色对比度；Office 仍懒加载，不回灌首包 | ✅ |
| 5 | 工程/发布效率：LLM completion 改为有界原生 fetch，移除重复 `ai/@ai-sdk-openai` 运行时；release 构建打包 workspace 实现，门禁拒绝 `@margin/*` 未发布依赖、源码/测试/导入稿泄漏 | ✅ |
| 6 | 验收：`pnpm test` 292/292、全库 typecheck/build、`GOLDEN_PATH_OK`、`CHAT_MEMORY_OK`、`gate:docx`、`PI_GATE_OK`（2 proposals / 7 comments / 24 steps）、`OFFICE_NATIVE_GATE_OK`、`RELEASE_PACKAGE_GATE_OK`（22 files / 908,034 bytes）；真实 `sport value.docx` 为 46 blocks、10 pages、31×5 table、单一 Browser Page 通过 | ✅ |
| 7 | 不扩展跨段多块静默改写、表格多段落猜测 patch、OCR/PDF 主战场、无界 shell/Python、Agent 直接 apply、持久服务或 git commit/push | ❌ 明确不做 |
## 第 49 轮 — 0.1 发布收口 ✅

| # | 项 | 状态 |
|---|---|---|
| 1 | 发布包统一为 `margin-agent@0.1.0`；runtime capabilities、Paper Agent adapter、MCP client 与包版本一致 | ✅ |
| 2 | 选区安全：跨段/跨单元格禁用破坏性改写但保留讨论；翻译/润色走无工具 direct proposal，拒绝原文回显和双语夹带 | ✅ |
| 3 | OOXML selection-aware patch 只替换选中 visible text leaves，保留后续 run、hyperlink、field 格式；Y/N/E 与 E 编辑有回归测试 | ✅ |
| 4 | 人工 DOCX 保存增加 SQLite crash journal；启动按磁盘 hash finalize 或清理，和 Agent apply 共用文档串行队列 | ✅ |
| 5 | API 设置收敛为协议 → Base URL 自动规范化 → Key → 获取模型 → 选择 → 毫秒测试 → 保存；Skill/MCP 扩展边界和本地安全约束写入用户文档 | ✅ |
| 6 | 完成全库效率与安全复审，未引入无界 shell/Python、第二套 coding agent、Desktop/PDF 扩 scope | ✅ |
| 7 | 验收：全库 292 项测试、类型/构建、DOCX、Office、Pi、release gate 与全新 tarball 安装冒烟 | ✅ |

## 第 50 轮 — 真实用户旅程回归 ✅

| # | 项 | 状态 |
|---|---|---|
| 1 | 用单一 Edge 页面完成真实 DOCX 打开、选区翻译、审阅 Accept、表格 E 写回、人工格式保存、扩展面板、焦点布局与重载；人工查看首屏、表格和扩展截图 | ✅ |
| 2 | 修复 `executeSetRange` 的第三方 history/contentChange 副作用：受控定位精确消费一次事件，Agent Accept 后不再伪报“未保存”，人工内容与格式编辑仍可保存 | ✅ |
| 3 | 源码 CLI 静态资源优先使用最新 `apps/web/dist`，安装包无源码时才回退随包 `web-dist`，避免发布副本遮蔽刚构建的前端 | ✅ |
| 4 | Office 字体选择框加宽，`Times New Roman` 等常用字体名不再裁断 | ✅ |
| 5 | 验收：`pnpm test` 292/292、typecheck、真实 `gate:office`（46 blocks / 10 pages / 31×5 / Y 后 clean）、release gate 与最新 tarball 隔离启动 | ✅ |

## 第 51 轮 - API 配置路径与专注文稿布局收口 ✅

| # | 项 | 状态 |
|---|---|---|
| 1 | 设置页收敛为「接口格式 → 服务地址/自动 endpoint → Key/默认鉴权 → 读取模型 → 选择 → 测试延迟 → 保存」；移除重复状态与结果 | ✅ |
| 2 | OpenAI 根地址与自动 `/v1` 后缀在前端、探测复用和持久化保存中统一视为同一目标，已保存 Key 不再被错误要求重填 | ✅ |
| 3 | 保存拒绝非 `http(s)`、含用户凭据、查询参数或片段的 Base URL；本地无 Key endpoint 仍允许 | ✅ |
| 4 | 既有单页 Edge Office 门禁增加 API 模拟旅程：切 OpenAI/Anthropic、读取模型、选择、42ms 测试、保存 payload 与设置页截图 | ✅ |
| 5 | 专注文稿模式将 Office 纸张居中；门禁断言页面中心偏移小于 2px | ✅ |
| 6 | 验收：`pnpm test` 295/295、`pnpm typecheck`、`pnpm gate:office -- "E:\academic\spviolence\sport value.docx"`、`pnpm gate:release` | ✅ |

## 第 52 轮 - 锚定线程的单一上下文面 ✅

| # | 项 | 状态 |
|---|---|---|
| 1 | 修复锚定线程消息同时进入浮层与全局对话导致的重复渲染：带 `threadId` 的消息只在 ThreadPopover 中显示；折叠后仍可经审阅页的线程收件箱恢复 | ✅ |
| 2 | 从审阅收件箱重开线程时，侧栏切回全局对话，避免同一提案在浮层与审阅面出现两套 Y/N/E 操作入口 | ✅ |
| 3 | `visual-thread-check.mjs` 增加真实 Word 讨论旅程断言：线程消息不回流 `.chat-activity`，收件箱恢复的上下文恰好一份，且侧栏已离开审阅页 | ✅ |
| 4 | 验收：`pnpm test` 295/295、`pnpm typecheck`、`pnpm build`、`visual-thread-check`、`debug-thread-accept`、真实 `gate:office` 均通过；Office 门禁验证 46 blocks / 10 pages / 31×5 table 与单元格 E 写回 | ✅ |

## 第 53 轮 - 锚点轨道的真实位置与恢复闭环 ✅

| # | 项 | 状态 |
|---|---|---|
| 1 | 锚定线程的轨道点优先使用创建时保存的选区像素坐标，不再把首段讨论错误压到整个文稿比例轨道的顶部；没有坐标的旧提案/批注保留比例回退 | ✅ |
| 2 | `visual-thread-check.mjs` 断言折叠后的锚点中心距原选区不超过 36px，并直接点击该轨道点恢复同一条线程；随后仍验证审阅收件箱恢复 | ✅ |
| 3 | 验收：`pnpm test` 295/295、`pnpm typecheck`、`pnpm build`、`visual-thread-check`、`debug-thread-accept`、真实 `gate:office` 均通过；Office 门禁验证 46 blocks / 10 pages / 31×5 table 与单元格 E 写回 | ✅ |

## 第 54 轮 - 滚动中的锚点同步与工具条避让 ✅

| # | 项 | 状态 |
|---|---|---|
| 1 | Word 画布滚动和程序化线程恢复后，实时选区坐标会同步回匹配线程；轨道点、浮层与正文不再停留在旧屏幕位置 | ✅ |
| 2 | Office 顶部空间不足时，选区快捷条自动移至选区下方，并由真实浏览器旅程断言不与 Word 工具栏重叠 | ✅ |
| 3 | 补 reducer 回归，验证线程锚点坐标更新；视觉旅程验证滚动跟随、轨道恢复、收件箱恢复及单一审阅入口 | ✅ |
| 4 | 验收：`pnpm test` 296/296、`pnpm typecheck`、`pnpm build`、`visual-thread-check`、`debug-thread-accept`、真实 `gate:office` 均通过；Office 门禁验证 46 blocks / 10 pages / 31×5 table 与单元格 E 写回 | ✅ |

## 第 55 轮 - 锚定线程的进程重启持久化 ✅

| # | 项 | 状态 |
|---|---|---|
| 1 | 扩展现有 `agent_sessions.messages_json` envelope：有界保存审阅线程、文稿 ID、选区锚点、折叠状态与 `chatTurns.threadId`；非法锚点丢弃，长文本截断，旧 envelope 继续兼容 | ✅ |
| 2 | Agent 内部保存省略 threads 时保留已有线程；CLI 启动恢复线程与带 threadId 的聊天记忆，给 LLM 的历史仍只暴露 `{ role, text }`，不改变提示词契约 | ✅ |
| 3 | 新增 `PUT /api/v1/session/threads` 与前端 hydration/debounce 同步；首次 hydration 后才允许写回，屏幕坐标 `pos` 不持久化，重启线程统一折叠并通过现有 focusRequest 重新定位 | ✅ |
| 4 | 文稿切换或关闭会清空旧线程；恢复时仅接纳当前文稿的线程消息，无效 threadId 消息不会回落到全局 Chat；shutdown 发起 Fastify close 后先释放 workspace lock，再等待连接退出，立即重启不再偶发 ELOCKED | ✅ |
| 5 | 新增 `gate:thread-restart`：真实 `sport value.docx` 创建讨论与待审提案，完整终止 CLI、同 workspace 新进程与新 token 启动，恢复原问答/提案且全局不重复，并继续讨论后执行 N | ✅ |
| 6 | 验收：`pnpm test` 301/301、`pnpm typecheck`、`pnpm build`、`gate:thread-restart`、`visual-thread-check`、`debug-thread-accept`、真实 `gate:office` 全部通过；Office 仍为 46 blocks / 10 pages / 31×5 table，OOXML 保护结构与单元格 E 写回保持 | ✅ |

## 第 56 轮 - 体验重构（跨段选区 / 注意力 / 表格 / 设计语言 / 走查） ✅

spec/plan：`docs/superpowers/specs/2026-07-23-ux-overhaul-design.md`、`docs/superpowers/plans/2026-07-23-ux-overhaul.md`（子代理逐任务执行，spec+质量双审）。

| # | 项 | 状态 |
|---|---|---|
| 1 | 跨段选区误判修复三处根因：Office 跨段解析携带逐段文本校验（表格后不再错位/静默错 block）；`crossTableCells` 跨格全链路拦截（含线程内编辑守卫）；多块选区跳过表格块并提示"已跳过 N 个表格块" | ✅ |
| 2 | agent 注意力三态显式化：`attention.ts` 派生模型（global/selection/mixed）+ attention-strip 图标与契约文案；修掉 global 态悬空"选区："标签 | ✅ |
| 3 | 聊天 markdown 表格视觉打磨：斑马纹、表头加粗、圆角外框、横向滚动边缘阴影（四背景技法），light/dark 均验证不溢出 | ✅ |
| 4 | 设计语言收口：styles.css 3724→3671 行，合并 10 组双定义、9 段分区注释、space/radius/motion token、overlay-in 微交互、21 选择器 :focus-visible、prefers-reduced-motion | ✅ |
| 5 | 走查扩展：表格后跨段场景（blockId 归属硬断言）、注意力三态断言、dark 硬断言+dark 表格重注入；走查中修复两个真实缺陷（选区替换吃掉首尾空格；清除按钮清不掉画布高亮） | ✅ |
| 6 | 验收：`pnpm test` 319/319、typecheck、build、smoke、ux-walkthrough（零槽点）、visual-thread-check 全绿；16 张截图人工复核 | ✅ |

## 第 57 轮 - 提示词与模块化三步重构 ✅

spec/plan：`docs/superpowers/specs/2026-07-23-prompt-modularity-design.md`、`docs/superpowers/plans/2026-07-23-prompt-modularity.md`。

| # | 项 | 状态 |
|---|---|---|
| 1 | harness 约束层抽取：人格 = 共享骨架 CORE_CONTRACT（身份/编辑契约/微观选区优先/证据先行/寻址模型/澄清/联动底线）+ 参数化约束；新增 `office-zh`（core scope）——"更松的同一骨架"而非平行复制，经 `/api/v1/harnesses` 自动暴露 | ✅ |
| 2 | skills 两层归属：frontmatter `packs:` + 按 skillScope 过滤（索引与 load_skill 双路）；新增 `format-tidy-zh`（core，标题层级/图表编号/标点/GB-T 7714） | ✅ |
| 3 | prompt 去重：cascade/source/clarification 三处 hint 瘦身并按 scope 门控（office/minimal 不再踩 Unknown skill）；无工具路径统一 `directIdentity()`（60 字符） | ✅ |
| 4 | 验收：`pnpm test` 327/327、typecheck、build、ux-walkthrough 全绿；三档 prompt 输出抽查（office 877 字符零学术泄漏 / 社科 1500 六 skills / minimal 无索引） | ✅ |

## 第 58 轮 - Word 式修订模式 + 收尾项 ✅

spec/plan：`docs/superpowers/specs/2026-07-23-revision-mode-draft.md`、`docs/superpowers/plans/2026-07-23-revision-mode.md`（spike 定路线 A：画布注入可行有条件）。

| # | 项 | 状态 |
|---|---|---|
| 1 | 修订标记核心：待审提案以样式 spans（del=淡色划线、ins=主题色下划线、extension.marginMark）注入 Word 画布正文；原语 getKeywordRangeList→setRange→insertElementList(isSubmitHistory:false)，不触发 contentChange、不污染 undo；table_cell/跨块/文档开头降级 rail | ✅ |
| 2 | Y/N/E 联动 + 保存兜底 + 篡改检测：Y/E 经 revision+1 外部变化判定清标记并整体 reload（无画布双写）；N 快照还原；保存前全部还原→导出→重注入（标记永不进 docx）；contentChange 检测标记被破坏则强制还原并提示 | ✅ |
| 3 | 走查抓获并修复坐标系漂移核心缺陷（getKeywordRangeList 流坐标 vs setRange 元素下标，probeStreamDrift 探针校正 + 快照改取 selectionElementList + 逐字校验）；修复 officeReady 保存后永久卡死；修复 visual-thread-check 与标记注入的语义冲突 | ✅ |
| 4 | 修订记录面板：复用 timeline 端点（SQL 增选 before/COALESCE(edited,after)/operation），ReviewPanel 历史视图 + 全部/已接受/已拒绝筛选 + "应用失败(reason)"分支 | ✅ |
| 5 | 收尾：Settings harness 下拉（全链路持久化+透传）、visual-thread-check usage、.tmp 清理（~48 项）+ 走查脚本自清理、directIdentity 签名清理 | ✅ |
| 6 | 验收：`pnpm test` 375/375、typecheck、build、smoke、ux-walkthrough（新增 3b 标记断言/4b 保存泄漏检测+N 还原/6c 历史面板）、visual-thread-check 全绿；17/18 截图人工复核达标 | ✅ |

遗留（第 59 轮候选，plan 文档有完整清单）：cli PUT settings undefined-patch（数据损坏级）、手动保存 supersede pending 提案的语义冲突、长段落全文匹配注入限制、mock 模式 harness 保存、&amp;amp;apos; 双重转义 + 历史面板列宽 polish。

## 第 59 轮 - 修订模式遗留清零 ✅

plan：`docs/superpowers/plans/2026-07-23-round59-leftovers.md`。

| # | 项 | 状态 |
|---|---|---|
| 1 | cli PUT settings undefined-patch 修复（仅携带 harnessId 的调用不再触碰 active provider，补 llm-settings-patch 测试）；Settings mock 模式仅改 harness 下拉也可保存 | ✅ |
| 2 | 保存前确认：pending 提案存在时保存先弹"保存将关闭 N 条待审提案"确认（发生在还原/导出之前），取消零副作用、确认走原 supersede 链路 | ✅ |
| 3 | 标记注入改片段级锚定：buildAnchor（markedKey/markOffset/markText + 上下文边界换算），restoreMark 严格 occurrence；1196 字长段落可直接注入（此前 1206 字段落因整段逐字命中失败降级 rail） | ✅ |
| 4 | 双重转义修复（office-docx.ts 删 processEntities:false，parse/build 幂等）+ .review-history-diff 两列 flex 布局（前后列均衡、长文本省略） | ✅ |
| 5 | 走查扩展：4b 保存前确认正/反向断言（dialog 文案含"待审提案"；取消后标记仍在、提案仍 pending、文档未保存）+ 最长段落直接生成提案并断言 marginMark 注入（保留探测兜底）；新增 19-save-confirm.png | ✅ |
| 6 | 验收：`pnpm test` 394/394、typecheck、build、smoke（GOLDEN_PATH_OK）、ux-walkthrough（UX_WALKTHROUGH_OK，1196 字段落注入成功）、visual-thread-check 全绿；17/18/19 截图人工复核达标（18 两列布局正常、无多层转义文本） | ✅ |

## 第 60 轮 - unlimited 外部读取模式 ✅

spec：`docs/superpowers/specs/2026-07-24-unlimited-external-read-design.md`（经独立评审精简：落点从"openWorkspace 传参链+meta 接口+前端徽标"砍到 bridge 一处旁路，核心 ~80 行）。

背景：agent 读取被 `resolveWorkspacePath` 限制在工作区内，用户读外部资料（如 `E:\academic\spviolence\park`）只能复制。本轮提供显式开启的 unlimited **读取**模式；写入边界不变，外部 docx 仍只能导入工作副本。

| # | 项 | 状态 |
|---|---|---|
| 1 | `readWorkspaceSource` 加 `opts.unlimitedRead`：绝对路径且关→专属错误（`path escapes workspace` 写路径错误不动）；开→existsSync→realpath→工作区内归一化（黑名单不生效）→黑名单→普通文件→复用现有大小上限/TEXT_EXT/PDF/DOCX 提取；relativePath 回填绝对路径，sourceRef 自动兼容 | ✅ |
| 2 | 密钥黑名单 `isDeniedExternalPath`（module-private 纯函数）：basename `.env*`/`id_rsa*`/`id_ed25519*`/`id_ecdsa*`/`*.pem`/`*.key`/`*.p12`/`*.pfx`/`.netrc`/`.npmrc`/`.pgpass` + 路径段 `.ssh`/`.aws`/`.gnupg`/`.git`/`.margin`；realpath 后检查（防 symlink 绕过）、小写+分隔符归一 | ✅ |
| 3 | 开关：`--unlimited` argv（剔除后取工作区路径）或 `MARGIN_UNLIMITED=1`；bridge.readText 每次调用时读 env 透传；启动日志开启时打印 `security: unlimited-read ON` | ✅ |
| 4 | 测试：storage-local 新增 9 用例（黑名单各模式含 Windows 大小写/反斜杠、junction→`.ssh` 拒绝、junction→正常目录允许、工作区内 `id_rsa.txt` 归一化、超限/目录/不存在拒绝）；cli bridge 透传 1 用例 | ✅ |
| 5 | USAGE.md 本地边界节补 `--unlimited` 说明 + 提示注入警示 | ✅ |
| 6 | 验收：storage-local 104/104、cli 41/41、typecheck 7 包、build 全绿 | ✅ |

非目标（第二阶段候选）：外部路径挂资料（replaceAttachedSources/readSourceExcerpt/source-chunk 三处，~25 行）、tool description 告知模型可传绝对路径、meta 接口+前端 UNLIMITED READ 徽标。
