# 第 59 轮实施计划：修订模式遗留清零

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 清零第 58 轮终审遗留：cli settings undefined-patch（数据损坏级）、手动保存 supersede 待审提案的体验陷阱（方向已定：**保存前确认**）、长段落标记注入限制、mock 模式 harness 保存、双重转义与历史面板列宽。

**通用约定：** 无 git，禁 git；混排行尾文件用临时 node 脚本编辑（用完删除）；后台有用户重任务：浏览器单实例、命令串行、不并发跑全量 build；每 Task 后相关包 test + typecheck 绿。

---

### Task 1: cli PUT settings undefined-patch + mock 模式 harness 保存

**Files:**
- Modify: `apps/cli/src/index.ts:547-559`（PUT /api/v1/settings/llm）
- Modify: `apps/web/src/components/Settings.tsx`（保存校验 :285 附近）
- Test: `apps/cli` 或 storage-local 对应测试文件

**规格：**
- PUT 端点只在 body 实际携带 provider 字段（apiFormat/baseURL/model/authStyle/apiKey 任一存在）时构造 provider patch；仅 `{ harnessId }` 的调用不得触碰 active provider。补测试：仅发 harnessId → provider 不变、 harnessId 持久化；再发完整表单 → 两者都更新。
- Settings：mock 模式（无 baseURL/model）下，仅修改 harness 下拉时保存可用（校验放宽为"provider 字段完整 或 仅 harnessId 变化"）；实现时读现有校验与 hydrate 逻辑选最小改动。

### Task 2: 保存前确认（supersede 体验陷阱）

**Files:**
- Modify: `apps/web/src/components/OfficeCanvas.tsx`（save 链路 :975-1030 附近）、`apps/web/src/App.tsx`（pending 数传递，若需要）

**规格：**
- 保存触发时若存在 pending 提案（含已注入标记与仅 rail 的），先弹确认："保存将关闭 N 条待审提案"（沿用现有 confirmRebuild 确认对话模式，看 save() 里既有 confirm 实现）。[保存并关闭提案] / [取消]。
- 用户确认 → 走现有 supersede 行为；取消 → 中止保存，标记与提案保持原样（已还原的标记需重新注入——注意与 Task 3 保存兜底的顺序：确认应发生在还原之前）。
- 走查（Task 5）补断言：pending 时保存触发确认对话。

### Task 3: 标记注入改片段级锚定

**Files:**
- Modify: `apps/web/src/office/revisionMarks.ts`、`apps/web/src/components/OfficeCanvas.tsx`（injectMark）
- Test: `apps/web/src/office/revisionMarks.test.ts`

**规格：**
- 现状：injectMark 依赖 `proposal.before`（整段文本）在画布逐字命中，长段落/字符差异时静默不注入（走查实测 1206 字段落 rangeCount=0）。
- 改为片段级锚定：以 changedRange 的 `beforeFragment`（或 selection 选区文本）+ 前后少量上下文（如各 20 字符）作为定位 key；命中后用上下文边界换算替换区间；快照与还原区间随之改为片段级（不再整段）。保留：stale-base 校验（改为片段级等价校验）、ordinal 消歧、probeStreamDrift 校正、逐字校验、失败降级 rail。
- 测试：片段锚定的定位/边界换算纯函数用例（含长段落、重复片段 ordinal、上下文不足时退化）。

### Task 4: 双重转义修复 + 历史面板列宽 polish

**Files:**
- Modify: `apps/web/src/office/docxImport.ts`（`&amp;apos;` 双重转义，先定位：导入时实体被二次转义的环节）
- Modify: `apps/web/src/styles.css`（.review-history-diff 列宽/省略）
- Test: docxImport 相关测试补含 `&apos;`/`&amp;` 实体的用例

**规格：**
- 正文出现字面 `&amp;apos;`（截图 18 可见）：找到导入链路的二次转义点（mammoth/xml 解析/元素构造），修复为单次解码；补回归测试（含 `'`、`&`、`<` 的文本段落）。
- 历史面板"前"列过窄逐字断行：调整 `.review-history-diff` 的列宽/white-space/省略策略（前后两列均衡、长文本省略号）。

### Task 5: 走查扩展 + 全量门禁 + 终审

- `scripts/ux-walkthrough.mjs`：补 保存前确认 断言（pending 时保存 → 确认对话出现 → 取消后标记仍在）；若 Task 3 落地，补长段落标记注入断言（之前降级的 1206 字段落场景）。
- `pnpm test && pnpm typecheck && pnpm build && pnpm smoke` + ux-walkthrough + visual-thread-check 全绿。
- 截图复查新增/受影响场景；更新 `docs/EXECUTION_PLAN.md` 第 59 轮。

---

## Self-Review 记录

- 覆盖：终审遗留 must（Task 1/2）+ should（Task 3/4）+ 验证（Task 5）。可缓项（ReviewTimeline 统一、探针重复文本歧义、selectRange 坐标校正）明确不做。
- 依赖：Task 1 是 mock 保存的前置，同 Task 交付；Task 2 与 Task 3 无耦合但同改 OfficeCanvas，顺序执行。
