# 第 58 轮候选：Word 式修订模式（inline tracked changes）设计草案

日期：2026-07-23 · 状态：已批准（2026-07-23：路线 A 优先 B 兜底；顺带收尾并入第 58 轮）
前置：第 56/57 轮已收口，门禁全绿（327 tests）。

## 用户原话

"可以用替换+淡色标记的方式改进正文中，用户同意后修进去并有历史记录，有点像 Word 自带的修订功能。"

## 目标

提案不再只出现在侧栏/轨道卡片，而是以 Word 修订的方式**直接标记在正文里**：删除=淡色划线、新增=主题色下划线；用户接受（Y）→ 经现有 CAS 落为正文；拒绝（N）→ 原样恢复；全程留历史。

## 已核实的事实

- canvas-editor 0.9.137 **无原生修订/track-changes API**（已查 dist 类型），但有 `strikeout` 文字样式——视觉可模拟。
- 历史记录**已存在**：`.margin/margin.db` 的 proposals/decisions/apply events + `.margin/backups/`；缺的是用户可见的"修订记录"界面。
- 现有提案展示：块级 `pending-rail`（块内 before/after）+ 审阅 tab + ThreadPopover 提案卡。
- 风险区：canvas-editor 内容是唯一事实源，把标记写进文档内容会触碰 dirty/保存/CAS（baseHash）——标记绝不能被保存进 docx。

## 技术路线（需 spike 后定）

**路线 A：画布内容注入（最像 Word）**
提案待审时，把目标段落的 element list 换成"旧文本(strikeout+灰) + 新文本(accent+下划线)"的样式化 spans；接受→走现有 apply 通道落最终文本；拒绝→还原原始 elements。必须配：标记期间锁定保存（或保存前自动剥标记）、用户编辑冲突处理、undo 栈隔离。
风险：dirty 状态污染、CAS baseHash 失配、canvas-editor 重绘/选区行为不可控。

**路线 B：锚定只读预览（安全）**
文档内容不动；在段落旁（或块内浮层）渲染内联样式的 diff 预览（同样的划线/下划线视觉），Y/N/E 操作不变。
风险低，但"标记在正文中"的沉浸感弱于 A。

**推荐：A 优先、B 兜底**——先做 1 个 spike 任务验证 A 的可行性（注入→接受→拒绝→保存锁定全链路），spike 失败或过于脆弱则落 B。

## 任务分解（草案）

1. **Spike：canvas 注入可行性**（验证 element 替换、样式 spans、保存锁定、还原；产出结论 A/B）
2. **修订标记渲染**：按 spike 结论实现 inline 标记（选区级 diff 用 `proposalChange.ts` 现有 diff 计算）
3. **接受/拒绝/编辑（Y/N/E）与标记联动**：接受走现有 CAS；E（编辑后接受）先编辑预览再落
4. **修订记录面板**：margin.db 历史 → 审阅 tab 新增"历史"视图（时间线已有 `ReviewTimeline.tsx`，扩展为可筛选的完整记录）
5. **走查扩展 + 全量门禁**

## 顺带收尾（小项，独立任务）

- 前端 Settings 增加 harness 选择（office-zh 当前只能经 API/CLI/legacy.html 触达）——办公 pack 前置
- `visual-thread-check.mjs` 裸跑补 usage 提示；清理 `.tmp-*` 堆积（walkthrough 脚本自清理）
- `directIdentity` 签名清理（去掉装饰性 harnessId 参数）

