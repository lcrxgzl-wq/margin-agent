# 体验重构实施计划（UX Overhaul）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-07-23-ux-overhaul-design.md` 完成五项体验重构：跨段选区误判修复、注意力显式化、聊天表格打磨、设计语言收口、端到端走查。

**Architecture:** 前端 React19+Vite（`apps/web`），双画布（Office canvas-editor / TipTap），自研 Context+reducer 状态；后端 fastify（`apps/cli`）+ `packages/agent`。本计划只动 `apps/web` 与 `scripts/ux-walkthrough.mjs`，不改后端协议。

**Tech Stack:** TypeScript, React 19, TipTap 2, @hufe921/canvas-editor 0.9.137, Vitest, playwright-core（走查）。

**通用约定：**
- 仓库无 git 历史（0 commit），本计划**不执行任何 git 操作**；每个 Task 以门禁命令验证代替 commit。
- 多个源文件存在 lone `\r` 混排行尾，编辑时用精确字符串匹配，不要全文件格式化。
- 每个 Task 完成后必须跑：`cd apps/web && pnpm test` 与 `pnpm typecheck`（根目录 `pnpm typecheck` 亦可）。
- canvas-editor 类型在 `node_modules/.pnpm/@hufe921+canvas-editor@0.9.137/node_modules/@hufe921/canvas-editor/dist/src/editor/interface/Range.d.ts`：`IRange` 含 `isCrossRowCol?/startTdIndex?/endTdIndex?/startTrIndex?/endTrIndex?`（`RangeContext` 不含，须用 `editor.command.getRange()` 取）。

---

### Task 1: Office 跨段选区解析携带文本校验（修复误判 1a）

**Files:**
- Modify: `apps/web/src/office/blockSelection.ts:73-114`（resolver 返回函数）
- Modify: `apps/web/src/components/OfficeCanvas.tsx:50-76`（`resolveBlocksForRange`）与 `:303-310`（调用处传 `paragraphElements`）
- Test: `apps/web/src/office/blockSelection.test.ts`

**问题**：跨段分支 `resolve({ paragraphNo, isTable })` 不传文本，resolver 盲信 `byBodyIndex`；选区在表格之后时 paragraphNo 与 `w:body` 序号错位 → 静默错 block 或塌缩 null。

- [ ] **Step 1: 写失败测试**（`blockSelection.test.ts` 追加）

```ts
it("rejects bodyIndex match when provided text does not score", () => {
  const blocks = [
    { id: "ooxml-p-0-aaa", kind: "paragraph", text: "第一段正文" },
    { id: "ooxml-t-1-bbb", kind: "table", text: "表格内容" },
    { id: "ooxml-p-2-ccc", kind: "paragraph", text: "表格后的段落" },
  ] as unknown as Block[];
  const resolve = createOfficeBlockResolver(blocks);
  // paragraphNo=1 错位指到 table，但文本是正文段落 → 不得返回 table 块
  const id = resolve({ paragraphNo: 1, paragraphText: "表格后的段落" });
  expect(id).toBe("ooxml-p-2-ccc");
});

it("returns null instead of blind ordinal fallback when text queries score zero", () => {
  const blocks = [
    { id: "ooxml-p-0-aaa", kind: "paragraph", text: "完全无关的内容" },
  ] as unknown as Block[];
  const resolve = createOfficeBlockResolver(blocks);
  expect(resolve({ paragraphNo: 5, paragraphText: "无法匹配的文字" })).toBeNull();
});
```

（顶部按现有测试的 import 风格补 `createOfficeBlockResolver` 与 `Block` 类型。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && pnpm exec vitest run src/office/blockSelection.test.ts`
Expected: FAIL（当前实现返回 `ooxml-t-1-bbb` / `ooxml-p-0-aaa`）

- [ ] **Step 3: 修改 resolver**（`blockSelection.ts` 返回函数尾部）

把 110-113 行的兜底改为"有文本 query 且全部 0 分时返回 null"：

```ts
    if (winner && winner.score > (context.isTable ? 2 : 0)) return winner.id;
    if (queries.length) return null;
    if (!context.isTable && context.paragraphNo != null) {
      return paragraphs[context.paragraphNo]?.id ?? null;
    }
    return context.isTable ? tables[0]?.id ?? null : null;
```

- [ ] **Step 4: 修改 `resolveBlocksForRange` 跨段分支携带逐段文本**

在 `OfficeCanvas.tsx` 顶部 helper 区（`elementText` 之后）新增：

```ts
/** Split range paragraph elements into per-paragraph texts (best effort, "\n" segmented). */
function splitRangeParagraphTexts(elements: IElement[] | null): string[] {
  if (!elements?.length) return [];
  const texts: string[] = [];
  let current = "";
  for (const element of elements) {
    if (element.trList?.length) {
      if (current) { texts.push(current); current = ""; }
      texts.push(elementText([element]));
      continue;
    }
    const value = element.value ?? "";
    if (value.includes("\n")) {
      const parts = value.split("\n");
      parts.forEach((part, index) => {
        current += part;
        if (index < parts.length - 1) { texts.push(current); current = ""; }
      });
    } else {
      current += value;
    }
  }
  if (current) texts.push(current);
  return texts;
}
```

`resolveBlocksForRange` 签名加 `paragraphElements: IElement[] | null`，跨段分支改为：

```ts
  const perParagraph = splitRangeParagraphTexts(paragraphElements);
  const ids: string[] = [];
  for (
    let paragraphNo = context.startParagraphNo, index = 0;
    paragraphNo <= context.endParagraphNo && ids.length < 12;
    paragraphNo += 1, index += 1
  ) {
    const id = resolve({
      paragraphNo,
      isTable: context.isTable,
      paragraphText: perParagraph[index],
      selectionText: index === 0 ? text : undefined,
    });
    if (id && !ids.includes(id)) ids.push(id);
  }
  return { blockId: ids[0] ?? null, blockIds: ids.length > 1 ? ids : undefined };
```

调用处（`emitSelection`，:305-310）把 `paragraphElements` 传入。右键路径（`handleContextMenu`，:753-786）若也调 `resolveBlocksForRange`，同样传入。

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `cd apps/web && pnpm test`
Expected: 全部 PASS（若有旧测试编码了"盲信 fallback"行为，评估后按新语义修正该测试并在汇报中注明）

- [ ] **Step 6: typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: Done 无错误

---

### Task 2: 跨单元格选区检测（修复误判 1b）

**Files:**
- Modify: `apps/web/src/components/OfficeCanvas.tsx:293-340`（`emitSelection`）、`:40-46`（`SelectionInfo` 类型）、`handleContextMenu`（:753-786）
- Modify: `apps/web/src/store.tsx`（`Selection` 类型，:8-16）
- Modify: `apps/web/src/selectionSafety.ts:12-26`
- Test: `apps/web/src/selectionSafety.test.ts`

- [ ] **Step 1: 写失败测试**（`selectionSafety.test.ts` 追加）

```ts
it("blocks selections spanning multiple table cells with a precise reason", () => {
  const reason = selectionEditUnavailableReason({
    blockId: "ooxml-t-1-x",
    text: "跨格文字",
    tableCell: { row: 1, column: 1, address: "A1", before: "跨格文字" },
    crossTableCells: true,
  });
  expect(reason).toContain("单个单元格");
});
```

- [ ] **Step 2: 跑测试确认失败**（类型不存在的编译/断言失败均可）

Run: `cd apps/web && pnpm exec vitest run src/selectionSafety.test.ts`

- [ ] **Step 3: 贯通 `crossTableCells` 字段**

- `SelectionTarget`（`selectionSafety.ts:3-9`）加 `crossTableCells?: boolean`；`selectionEditUnavailableReason` 在 tableCell 分支之前加：

```ts
  if (target.crossTableCells) {
    return "选区横跨多个单元格，目前只能在单个单元格内生成提案；仍可讨论。";
  }
```

- `SelectionInfo`（`OfficeCanvas.tsx:40-46`）与 store 的 `Selection`（`store.tsx:8-16`）加 `crossTableCells?: boolean`。
- `emitSelection` 内：

```ts
    const range = editor.command.getRange();
    const crossTableCells = Boolean(
      context.isTable &&
        (range.isCrossRowCol ||
          (range.startTdIndex != null &&
            range.endTdIndex != null &&
            (range.startTdIndex !== range.endTdIndex || range.startTrIndex !== range.endTrIndex))),
    );
```

`onSelectionChangeRef.current({...})` 与 `onContextMenu` 调用都带上 `crossTableCells`（非 table 时为 false）。
- 确认 App.tsx 把 `selection.crossTableCells` 传入 `selectionEditUnavailableReason` 的调用点（grep `selectionEditUnavailableReason(` 全部调用处核对字段直通）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && pnpm test && pnpm typecheck`

---

### Task 3: 多块选区跳过表格块而非整次拒绝（修复误判 1c）

**Files:**
- Modify: `apps/web/src/useWorkspaceActions.ts:111-184`（`runRewrite`）

- [ ] **Step 1: 修改 `runRewrite` 开头（:121-126）**

把"含表格块即 throw"改为过滤：

```ts
    if (!store.doc) throw new Error("请先打开文章");
    if (!blockIds.length) throw new Error("请先选中一段文字");
    assertDocumentClean();
    const editableIds = tableCell
      ? blockIds
      : blockIds.filter((id) => store.blocks.find((block) => block.id === id)?.kind !== "table");
    const skippedTables = blockIds.length - editableIds.length;
    if (!editableIds.length) {
      throw new Error("请在表格的单个单元格内选择文字后再生成提案。");
    }
```

函数体内后续所有 `blockIds` 改用 `editableIds`（`onSelectionRunStart`、`beginBusy` 文案、`startProposalRun(editableIds.slice(0, 8), …)`）。

- [ ] **Step 2: 完成回执注明跳过**

:164-170 的消息拼接处改为：

```ts
      if (!selectionText) {
        const skipped = skippedTables ? `（已跳过 ${skippedTables} 个表格块）` : "";
        store.appendMessage({
          id: mid(),
          role: "assistant",
          text: `${note || (count ? `已提出 ${count} 处修订` : "已完成扫描")}${skipped}，请到审阅中确认。`,
        });
      }
```

（选区路径 `selectionText` 分支的消息在调用方，grep `已为选区生成修订` 的拼接点同样补 skipped 说明；若该路径文案在 `dispatchSelectionCommand`，把 `skippedTables` 通过返回值/`runRewrite` 内 append 实现，选最简单一处：直接在 `runRewrite` 内对有 selectionText 的情况不 append，由调用方文案不变——此时 skipped 说明统一放到 `runRewrite` 末尾 statusLine：`store.setStatusLine(...)`。实现时选最少改动的方案并在汇报中说明。）

- [ ] **Step 3: 回归**

Run: `cd apps/web && pnpm test && pnpm typecheck`
Expected: PASS（`commands.test.ts` 等不受影响；如有断言旧 throw 文案的测试，按新语义修正）

---

### Task 4: 注意力三态派生模型 + attention-strip 升级

**Files:**
- Create: `apps/web/src/attention.ts`
- Test: `apps/web/src/attention.test.ts`
- Modify: `apps/web/src/components/Chat.tsx:314-336`（attention-strip）及其 props（`Chat.tsx` 顶部 Props、App.tsx 传参处）

- [ ] **Step 1: 新建 `attention.ts` + 测试**

```ts
export type AttentionMode = "global" | "selection" | "mixed";

export type AttentionInput = {
  hasSelection: boolean;
  selectionBlockCount: number;
  sourceCount: number;
};

export function attentionMode(input: AttentionInput): AttentionMode {
  if (!input.hasSelection) return "global";
  return input.sourceCount > 0 ? "mixed" : "selection";
}

export const ATTENTION_COPY: Record<AttentionMode, { label: string; hint: string }> = {
  global: { label: "全文", hint: "Agent 通读全文与大纲" },
  selection: { label: "焦点 · 选区", hint: "优先看选区，全文按需读取" },
  mixed: { label: "焦点 · 选区 + 资料", hint: "选区优先，资料与全文按需读取" },
};
```

测试（`attention.test.ts`）：无选区 → global；有选区无资料 → selection；有选区有资料 → mixed。

- [ ] **Step 2: 跑测试确认失败 → 通过**

Run: `cd apps/web && pnpm exec vitest run src/attention.test.ts`

- [ ] **Step 3: 升级 attention-strip（Chat.tsx）**

现状（:314-336）：chips 为 `选区：…` / `N 段选区` / `全文` / `+ 全文大纲` / `资料 ×N` / 清除。升级为：

- 用 `attentionMode` 决定首个 chip 的图标与文案（lucide-react 已在依赖中：`Globe` = global、`Crosshair` = selection、`Layers` = mixed）；`title` 用 `ATTENTION_COPY[mode].hint`。
- 保留既有信息：选区前 48 字预览、`N 段选区`（selectionBlockCount>1 时）、`资料 ×N`、清除按钮；`+ 全文大纲` chip 保留（title 说明"全文仍可按需读取"）。
- 新增 CSS 类 `.attention-chip-icon`（图标 12px、垂直居中）；不改既有类名（walkthrough 断言 `.attention-strip` 文本，保持"全文/选区/N 段选区"字样仍出现——图标外加文字，勿删旧文案）。
- App.tsx 传参处补 `sourceCount: store.sourcePaths.length`（若已有则复用）。

- [ ] **Step 4: 回归 + 走查不破**

Run: `cd apps/web && pnpm test && pnpm typecheck`
Expected: PASS。注意 walkthrough 断言（`scripts/ux-walkthrough.mjs:106/137/173`）的 chip 文案必须仍在 DOM 中。

---

### Task 5: 聊天区 markdown 表格视觉打磨

**Files:**
- Modify: `apps/web/src/styles.css`（`.md-table-wrap` 区，:3512-3543）

- [ ] **Step 1: 表格样式升级**（沿用现有类名，只改规则）

- `.md-table-wrap`：圆角外框（`border-radius: var(--radius, 8px)`）、1px 边框、滚动时右侧渐变阴影提示（`background: linear-gradient(...)` 双背景技法或 `box-shadow: inset -12px 0 8px -8px rgba(0,0,0,.12)` 仅当可滚动——纯 CSS 用 `background-attachment: local/scroll` 四背景方案）。
- `th`：`--accent-soft` 底色保留，`font-weight: 600`，下边框加粗。
- `td/th` padding 收紧为 `4px 10px`，行高 1.5；`tbody tr:nth-child(even)` 斑马纹（`color-mix(in srgb, var(--accent-soft) 45%, transparent)`，dark 模式验证可读）。
- 字号 0.8rem 保留。

- [ ] **Step 2: 截图验证**

走查第 7 步已注入 demo 表格（`ux-walkthrough.mjs:210-234`）。运行 `node scripts/ux-walkthrough.mjs "imports/sport value.docx"` 后人工查看 `.tmp-visual/ux/10-md-table.png`：表格不溢出气泡、表头/斑马纹生效。

- [ ] **Step 3: 回归**

Run: `cd apps/web && pnpm test`

---

### Task 6: styles.css 设计语言收口 + 微交互

**Files:**
- Modify: `apps/web/src/styles.css`（全文，重点 :1-84 token 区与 :3385-3707 覆盖层）

**原则**：不改任何类名；每次只合并一组双定义，跑 `node scripts/ux-walkthrough.mjs` 前后截图对比防回归。此任务改动大，由子 agent 分段执行、每段后跑 `pnpm build`（web）+ 走查第 3/12/13 步截图人工比对。

- [ ] **Step 1: 消除双定义**

grep 全文找出重复选择器（已知：`.sel-bubble` :1581 vs :3612；其余用 `grep -o '^\.\([a-z-]*\)' styles.css | sort | uniq -d` 枚举）。逐组处理：保留尾部"Design refresh"版本的视觉语义，把它合并进主定义处，删除尾部重复块；被覆盖的旧声明若与新语义冲突以新为准。`styles.css:3385-3388` 的注释保留并改写为分区标题。

- [ ] **Step 2: 全文分区注释**

按 `tokens → base → layout → canvas → chat → review → overlays → motion → responsive` 顺序插入 `/* ===== SECTION ===== */` 注释；只移动纯覆盖块，不重排已有规则顺序（避免层叠变化）。

- [ ] **Step 3: Token 补齐**

`:root` 增加（不删既有变量）：

```css
--space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px;
--radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px;
--dur-fast: 120ms; --dur-med: 160ms; --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
```

`[data-theme="dark"]` 区同步检查对比度（accent 文字/表格斑马纹/pending-rail），不足处微调变量值而非新增类。

- [ ] **Step 4: 微交互**

- `.sel-bubble`、`.thread-popover`、`.selection-menu`、提案卡：进入动画 `opacity 0→1 + translateY(4px→0)`，`duration: var(--dur-med)`，`easing: var(--ease-out)`。
- 全部可点击元素统一 `:focus-visible` 环：`outline: 2px solid var(--accent); outline-offset: 2px;`（汇总写一条规则，列出现有交互选择器）。
- 文件末尾加：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    transition-duration: 1ms !important;
  }
}
```

- [ ] **Step 5: 验证**

Run: `cd apps/web && pnpm test && pnpm typecheck && pnpm build`，再 `node scripts/ux-walkthrough.mjs "imports/sport value.docx"`，逐张对比 `.tmp-visual/ux/01-15` 截图无视觉回归（布局位移/颜色错乱即失败，回查对应合并段）。

---

### Task 7: 端到端走查扩展 + 全量门禁 + 槽点清零

**Files:**
- Modify: `scripts/ux-walkthrough.mjs`

- [ ] **Step 1: 新增"表格后跨段选区"场景**

在现有跨段选区步骤（:162-184）之后插入：用 `__marginOfficeTestSelect` 测试钩子选中**表格之后**的两个相邻段落（先读 `imports/sport value.docx` 打开后的 block 列表，找到第一个 `kind==="table"` 之后的两个 paragraph 段的起止 offset；若该 fixture 表格后不足两段，改用 `imports/sport value-6.docx` 等其他 fixture，并在脚本注释注明）。断言：
- attention-strip 出现 `N 段选区` chip；
- 触发改写后产生 ≥1 条提案且提案的 blockId 属于表格之后的段落（非表格块、非 null）；
- 气泡不出现"无法把选区定位到文档段落"。
截图 `16-cross-after-table.png`。

- [ ] **Step 2: 注意力三态断言补强**

现有 :106/137/173 已断言部分 chip；补 global 态（打开文档后、未选中时 strip 含"全文"）、mixed 态（附资料时含"资料 ×"）断言（若无附资料步骤，可在设置步骤通过 SourcePicker 或直接 localStorage/API 附加 `fixtures/agent-chapter.md`）。

- [ ] **Step 3: 跑全量门禁**

```bash
pnpm test && pnpm typecheck && pnpm build && pnpm smoke
node scripts/ux-walkthrough.mjs "imports/sport value.docx"
node scripts/visual-thread-check.mjs "imports/sport value.docx"
```

全部输出 OK；walkthrough 结尾 note（槽点）清单为空。

- [ ] **Step 4: 人工截图复查**

逐张查看 `.tmp-visual/ux/*.png`（landing/选区/提案/审阅/表格/深色/浮窗/移动端/表格后跨段），从"漂亮的前端、优美的交互"视角记录并修复残留槽点，直至清零。

---

## Self-Review 记录

- Spec 覆盖：§1 → Task 1/2/3；§2 → Task 4；§3 → Task 5；§4 → Task 6；§5 → Task 7。无缺口。
- 类型一致性：`crossTableCells` 在 SelectionInfo/Selection/SelectionTarget 三处同名；`editableIds/skippedTables` 仅 Task 3 内部；`attentionMode/ATTENTION_COPY/AttentionMode` 仅 Task 4。
- 已知妥协：Task 3 Step 2 的 skipped 提示落点留给了实现者最小改动自由（两种方案均已列出）；Task 6 为程序性步骤（3700 行 CSS 无法内联全部代码），以走查截图对比为验收。
