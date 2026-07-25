# 第 58 轮实施计划：Word 式修订模式 + 收尾项

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 待审提案以 Word 修订样式（删除=淡色划线、新增=主题色下划线）标记在 Word 画布正文中；Y 接受经 CAS 修入、N 拒绝还原、E 编辑后接受；标记永不进保存的 docx；修订记录面板；顺带收尾小项。

**Spike 结论（58-1，已批准路线 A）**：核心原语 = `getKeywordRangeList(key)`（字符级闭区间 range）→ `executeSetRange(start-1, end)` → `executeInsertElementList(spans, { isSubmitHistory: false })`。实测：渲染正确、不触发 contentChange（delta=0）、不污染 undo 栈、快照还原字节级一致。IElement.extension 可打标 `marginMark: proposalId` 且 `getValue({extraPickAttrs:["extension"]})` 可读回。**禁止用 executeSetValue 做注入**（清 undo 栈+触发 contentChange）。泄漏漏洞：保存时 `changedBlockIds` 为空会全段落移植（office-docx.ts:709）→ 保存前必须剥标记。

**通用约定：** 无 git，禁 git；混排行尾文件用临时 node 脚本做字节级编辑（Edit 多行块常失败），用完删除；后台有用户重任务，浏览器探针单实例、不并发跑全量 build；每 Task 后相关包 test + typecheck 绿。

---

### Task 2: 修订标记核心（marks manager + 注入/还原）

**Files:**
- Create: `apps/web/src/office/revisionMarks.ts`（纯逻辑：spans 构造/快照/定位 key 计算，可单测）
- Test: `apps/web/src/office/revisionMarks.test.ts`
- Modify: `apps/web/src/components/OfficeCanvas.tsx`（注入/还原编排 + editor 命令调用）

**规格：**
- `revisionMarks.ts` 纯函数：
  - `buildMarkSpans(baseStyle, beforeFragment, afterFragment, proposalId)` → IElement[]（del: strikeout+灰、ins: underline+accent，均带 `extension:{marginMark:proposalId}`，继承 baseStyle 的 font/size/bold 等）。
  - `markKey(beforeFragment, afterFragment)` = 拼接串（注入/还原共用定位 key）。
  - `stripMarks(elements, marks)` → 纯函数剥除：把带 marginMark 的 spans 用快照原文替换（保存兜底用）。
  - 数据源：`proposalChange.ts` 的 `changedRange()`（beforeFragment/afterFragment）；scope=selection 用 selection.start/end；`table_cell` 与跨块提案**本轮不注入**（保持 pending-rail 展示），在 marks manager 里按类型跳过。
- OfficeCanvas 编排：
  - `marksRef: Map<proposalId, { snapshot: IElement[], key, blockId }>`。
  - `injectMark(proposal)`：按 blockId 定位段落（ordinal 消歧沿用 OfficeCanvas.tsx:610-613 现有模式）→ structuredClone 快照 → setRange(key 定位) → insertElementList(spans) → 收回光标（参照 :445-465 test hook 模式）。**多 pending 按文档倒序注入**（避免注入变长影响后续 ordinal）。
  - `restoreMark(proposalId)`：getKeywordRangeList(key) → setRange → insertElementList(快照替换片段)。
  - 触发时机：proposals prop 变化时 diff（新增 pending → inject；消失/已决 → 由 Task 3 的 Y/N/E 路径处理还原）。
- 测试：纯函数单测（spans 结构、stripMarks 往返、key 计算、table_cell/跨块跳过）；editor 命令侧靠 Task 6 走查验证。

### Task 3: Y/N/E 联动 + 保存锁定 + 篡改检测

**Files:** Modify `apps/web/src/components/OfficeCanvas.tsx`（保存链路 :771-815、accept/edit/undo 回调）、`apps/web/src/App.tsx`（accept/edit 回调装配处）

**规格：**
- 接受（Y）：restoreMark 后用 after 全文（无标记样式）替换该段 → 走现有 CAS accept 链路。
- 拒绝/撤销（N/undo）：restoreMark 还原快照。
- E（编辑后接受）：现有编辑入口不变，编辑作用于 after 文本；接受时同 Y。
- **保存兜底**：save() 开头 `if (marksRef.size)` → 全部还原 → 导出/保存 → 重新注入仍 pending 的标记（串行化在现有 async save 内）。
- **篡改检测**：contentChange 时检查所有 marks 的 key 仍可定位（getKeywordRangeList 非空）；定位失败 → 强制 restoreMark（用快照）并 appendMessage 提示"修订标记已被手动改动，已还原"。
- 测试：尽量纯函数化联动决策（如 `planSaveWithMarks(marks)` 返回还原顺序），单测覆盖。

### Task 4: 修订记录面板

**Files:** Modify `apps/web/src/components/ReviewPanel.tsx`/`ReviewTimeline.tsx`、`apps/web/src/api.ts`（如需新端点）、`apps/cli/src/index.ts`（如需）

**规格：**
- 数据源：margin.db 已有 proposals/decisions/apply events。先查现有 API（`apps/web/src/api.ts` proposals/decisions 端点）能否拉全量历史（含已 accept/reject）；不足则在 cli 加只读端点 `GET /api/v1/documents/:id/revisions?limit=…`。
- UI：审阅 tab 新增"历史"视图（或 ReviewTimeline 扩展）：每条记录显示 时间/操作（提案→接受/拒绝/编辑接受）/块摘要/before→after 摘要；按时间倒序；可筛选（全部/已接受/已拒绝）。
- 样式沿用既有 token 与 review 区类名风格。

### Task 5: 收尾小项

1. **Settings harness 选择**：`apps/web/src/components/Settings.tsx` 增加 harness 下拉（数据来自 `GET /api/v1/harnesses`），选择存入 llm-settings 持久化（看现有 harnessId 流转：api.ts:431/451、cli :232/:270/:353），发消息/提案时带上。
2. `scripts/visual-thread-check.mjs` 裸跑补 usage 检查（对齐 ux-walkthrough 的用法检查）。
3. `.tmp-*` 清理：删除仓库根 `.tmp-ux-ws-*`/`.tmp-debug-thread-*`/`.tmp-visual-ws-*`/`.tmp-styles-task6-backup.css` 等历史残留；给 walkthrough/visual 脚本加运行前自清理（或统一到单目录）。
4. `directIdentity(harnessId)`：去掉装饰性参数（全调用点同步），或保留参数但加 JSDoc 说明"预留按档区分"——选其一并全仓一致。

### Task 6: 走查扩展 + 全量门禁 + 截图复查

- `scripts/ux-walkthrough.mjs` 新增修订模式场景：生成提案后断言画布内存在 marginMark 元素（页面 evaluate 读 editor getValue extraPickAttrs）→ 接受 → 断言标记消失且正文更新 → 再生成 → 拒绝 → 断言还原。保存兜底场景：pending 时触发保存，导出 docx 不含 strikeout 标记。
- `pnpm test && pnpm typecheck && pnpm build && pnpm smoke` + ux-walkthrough + visual-thread-check 全绿；截图人工复查。

---

## Follow-ups（第 58 轮遗留）

- cli PUT /api/v1/settings/llm 无条件构造 provider patch：仅发 { harnessId } 的调用会把 active provider 重置为默认值（cli/index.ts:547-559）。当前 UI 调用路径不触发；"mock 模式单独保存 harness" 落地前必须先修。
- mock 模式下 Settings 无法单独保存 harness 选择（保存校验要求 baseURL+model 非空）。
- ReviewTimeline 弹层与新历史视图功能重叠，后续可统一。

## Self-Review 记录

- Spec 覆盖：修订标记（Task 2/3）、历史记录（Task 4）、收尾项（Task 5）、验证（Task 6）。无缺口。
- 范围控制：table_cell/跨块提案本轮不注入标记（保持 rail 卡片），spec 已注明。
- 已知风险（spike 遗留 + Task 3 审查补记）：多 pending ordinal 漂移（倒序注入缓解）、用户编辑标记（篡改检测兜底）、表格场景未实测（本轮不覆盖）；两个相同 before+after 拼接 key 的标记并存时 occurrence 可能漂移（restoreMark 回退 ranges[0]，罕见）；标记被整体删光时按"已删除"提示、待 proposals 变化重注入；文档首字符处变更不注入（rail 兜底）。
