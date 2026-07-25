# 体验重构设计（UX Overhaul）

日期：2026-07-23 · 状态：待评审
前置：基线 `pnpm test`（全 7 包）、`pnpm typecheck` 已绿。上一任 agent 已部分落地：attention-strip、跨段多块提案链路、markdown 表格渲染与 walkthrough 断言，但残留三类选区误判、styles.css 尾部覆盖层未收口。

## 目标回顾

1. 修复跨段选区被误判为"不可编辑单块"，实现跨段/跨块编辑提案
2. agent 注意力（选中 vs 全局 vs 混合）逻辑明确且 UI 可见
3. 聊天区 markdown 表格渲染打磨（渲染已存在，不约束模型输出）
4. 前端布局与设计语言整体重构 —— **方向已定：延续"纸面工作台 + 深绿"基调做系统收口**
5. 用户视角端到端走查（打开 agent → 打开文档 → 各类命令），槽点清零

全程门禁：`pnpm test` / `pnpm typecheck` / `pnpm build` 常绿。

## 1. 跨段/跨块选区误判修复

误判不在 `selectionSafety.ts`（它已支持跨段），而在上游三处：

- **1a. Office 跨段解析盲信 paragraphNo**（`apps/web/src/components/OfficeCanvas.tsx:66-75`）
  跨段分支逐段调 `createOfficeBlockResolver` 时只传 `{paragraphNo, isTable}`，不传段落文本；resolver 在无文本时无条件信任 `byBodyIndex`（`apps/web/src/office/blockSelection.ts:77-92`）。canvas-editor 的 paragraphNo 与 `w:body` 子元素序号在"选区位于表格之后/覆盖表格"时错位 → 静默错配或塌缩为 null → 落入"无法定位"单块态。
  **修复**：跨段分支携带每段文本（`getRangeParagraph()` 已可得），走与单段相同的 `textScore` 校验与多级 fallback；仍失配时返回精确原因"选区跨越表格，无法逐段定位"，而非静默错 block。
- **1b. 跨单元格选区误判为单格**（`OfficeCanvas.tsx:173-193` `currentTableCell` 只读起点格）
  **修复**：探测 canvas-editor range 的 `isCrossRowCol`/`endTdIndex`/`endTrIndex`（dist 内可用字段，需实测确认），跨格时给明确 safety reason"请在单个单元格内选择"，不再放行到服务端报错。
- **1c. 多块选区扫过表格块即整次拒绝**（`apps/web/src/useWorkspaceActions.ts:124-126`）
  **修复**：多块路径含表格块时跳过该块、保留其余文本块生成提案，UI 在提案卡/回执注明"已跳过 N 个表格块"；仅当**全部**块都是表格块时才报"请在表格单元格内选择"。

**验证**：`ux-walkthrough.mjs` 新增"表格之后跨段选区"场景（现有用例恰好选表格前的两段，未覆盖错位面）；`blockSelection.test.ts`/`selectionSafety.test.ts` 补单测。

## 2. agent 注意力显式化

逻辑三态已隐式存在（无选区=全文；有选区=选区优先+大纲；cascade=混合），本次做"明确 + 可见"：

- **派生模型**：前端加 `attentionMode: "global" | "selection" | "mixed"` 派生函数（selection / selectionBlockCount / 资料数 → mode），单测覆盖。协议层不动（后端 cascade 门已是真源）。
- **UI**：升级 attention-strip（`apps/web/src/components/Chat.tsx:314-336`）——三态各有图标与一句话契约文案：
  - global：`全文` —— "Agent 通读全文与大纲"
  - selection：`焦点 · 选区 N 段` —— "优先看选区，全文按需读取"
  - mixed：`焦点 · 选区 N 段 + 资料 ×M` —— "选区优先，资料与全文按需读取"
  附"清除选区"操作；提案卡/ThreadPopover 标注 scope（仅选中文字 / 整段 / N 段）沿用现有能力，统一样式。

## 3. 聊天区 markdown 表格

不自残功能去约束模型输出——渲染管线（`apps/web/src/components/Markdown.tsx`，含 GFM 表格、半截表格降级纯文本）已可控。做视觉打磨：

- 表格样式升级：紧凑行高、斑马纹、表头底色与加粗、圆角外框、`overflow-x:auto` 内的滚动阴影提示。
- 走查保留"表格不横向溢出气泡"断言（`ux-walkthrough.mjs:226-232`），并加真实长表截图入视觉清单。

## 4. 设计语言收口（方向：延续打磨）

`styles.css`（3707 行）尾部 3385 行起是未收口的重构覆盖层，存在双定义（`.sel-bubble` 1581 vs 3612 等）：

- **结构**：全文按 `tokens → base → layout → canvas → chat → review → overlays → motion → responsive` 分区重组，消除双定义，后者语义并入前者；不改类名（避免动组件与走查断言）。
- **Token 完善**：补齐 spacing / font-size 阶梯 / radius / shadow / motion（duration、easing）变量，深色主题同步；检查深色对比度（accent-on-dark、表格、pending-rail）。
- **微交互**：bubble / popover / rail / 卡片的进入动画（fade+translate ≤160ms）、统一 hover/focus 态与 `:focus-visible` 环；`prefers-reduced-motion` 降级。
- **顺手收敛**：`App.tsx` 中 SelectionBubble/SelectionMenu/ThreadPopover 的重复 prop 装配抽为小组件/hook——仅限服务体验的收敛，不做无关重构。

## 5. 端到端走查与门禁

- 扩展 `scripts/ux-walkthrough.mjs`：新增表格后跨段选区、注意力三态 chip 断言、表格视觉截图；槽点（note）清单必须清零。
- 全量门禁：`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm smoke`、`node scripts/ux-walkthrough.mjs imports/"sport value.docx"`、`node scripts/visual-thread-check.mjs`。
- 人工视角复查全部走查截图（landing / 选区 / 提案 / 审阅 / 表格 / 深色 / 浮窗 / 移动端），确认"漂亮、流畅"达标。

## 执行策略（推荐 A）

- **A. 顺序推进 1→2→3→4→5，每步门禁绿**（推荐）：风险最小、可逐步验收；styles.css 单文件不适合并行。
- B. subagent 分治（内核组 + 样式组）：快，但 styles.css 与 walkthrough 脚本有合并冲突面。
- C. 先纯走查记槽点再修：并入 A 的第 5 步迭代，不单独成段。

## 范围外（YAGNI）

- 不换编辑器、不引 Tailwind/路由/状态库、不改后端协议与 cascade 门语义。
- 不做云端版、不动 packs/harness 人格（表格输出不约束）。
- 不初始化 git 仓库/提交（仓库当前无任何 commit，保持原状）。
