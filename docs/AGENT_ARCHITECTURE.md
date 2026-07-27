# Margin Paper Agent 架构规划（v0.2 执行稿）

> GPT sol 审定：**Go with changes**（2026-07-18）  
> 下文已吸收强制修改点。

## 裁决摘要（强制）

1. **执行前选路，执行后不重跑**：有凭据时开放任务只运行一次 Pi；无凭据或 `MARGIN_ENGINE=simple` 才在启动前选择离线流程。Pi 超时/失败直接报错，禁止用第二套 planner 重放。
2. **工具副作用**：前八个工具不持久化、不 apply；评论工具名 **`propose_block_comment`**（仅写入本次 ScanRun）；`finish_scan` 只终止。  
3. **提案契约**：Draft 含 `blockId` + `baseRevision` + `baseHash` + after/rationale；host 持久化后不可变；Apply 仅 CAS。  
4. **`cite_check`**：每条结果必须 `heuristic_only: true` + `verification: "not_verified"`；文案声明未验证真伪。  
5. **验收**：工具单测 + 无凭据预选离线 + Pi 失败不重放；不得把离线执行冒充 Pi。

## 产品命题

Margin Agent = 只提案、不擅自改稿的块级审阅运行时（Git for papers）。  
不 fork `pi-coding-agent`；云端无此 Agent。

## 分层

Host 命令（apply/reject/…）不可见 → `PaperAgentRuntime` → 九工具 + harness → 确定性学术工具 → `pi-agent-core`。

## 工具面（9）

`get_document_outline` · `list_blocks` · `get_block` · `search_blocks` · `propose_block_edit` · `propose_block_comment` · `cite_check` · `style_lint` · `finish_scan`

## 本轮验收

核心工具与 packs 可测；comments 会话返回；有凭据时单 Pi、无凭据时预选离线；capabilities 报 preferred/actual；test+smoke 绿；无云/Desktop/真文献库。TipTap 仅保留旧 Markdown 兼容。

## 文档内核（第 40 轮）

- Word 主路径的规范文件是原生 `.docx`；Host 直接解析/索引 OOXML，表格不再扁平化为 Markdown。
- Agent 只读取块快照并提交不可变提案；Accept/CAS 只替换目标段落 `w:p`，表格文本替换被拒绝。
- 人类在 `canvas-editor` 分页画布中直接编辑，显式保存走 revision/hash CAS 与备份；Markdown 画布仅服务旧稿。
- 外部绝对 DOCX 路径由 Host 受控复制进工作区，模型仍没有任意文件系统能力。

详见实现：`packages/agent/`。

## Profile、提示词与模块化（2026-07 重构后现状）

- **AgentProfile 三档**：`social-science-zh`（默认）/ `office-zh` / `minimal`。每档只组合 instructions、model、capabilities、skills、limits、approvals；未知 id 直接拒绝。`minimal` 的 Pi 工具面仅保留块读取、提案与结束。
- **三条执行路径**：纯列文件/打开命令走 Host；选区重写/翻译/润色走单次 Quick Edit；开放任务只走一次 Pi。三者共用同一 profile 编译器，Quick Edit 可用 `@skill-name` 显式内联已导入 Skill。
- **skills 两层归属**：SKILL.md frontmatter 可选 `packs:`（缺省 core）；索引与 `load_skill` 按 profile 的 skills.scope 过滤。bundled：argument-revision-zh / socratic-revision-zh / source-grounded-writing（academic）、fill-table-from-csv（data-analysis）、cascade-consistency-zh / format-tidy-zh（core）。
- **工具面**：上节"九工具"是扫描期原始面；会话面已扩展（open_document / read_workspace_file / propose_* / offer_cascade / load_skill 等，见 `packages/agent/src/session-tools.ts`）。
- **运行时边界**：Pi 用 `transformContext` 按完整用户轮次裁剪消息和工具输出；`beforeToolCall` 二次验权，`afterToolCall` 产出脱敏审计。远程 MCP 配置与输入 schema 可保留，但在 Host 完成逐次参数确认前不向模型暴露调用工具。
