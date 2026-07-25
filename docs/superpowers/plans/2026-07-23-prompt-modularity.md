# 提示词与模块化三步重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 按 `docs/superpowers/specs/2026-07-23-prompt-modularity-design.md` 完成 harness 约束层抽取、skills pack 归属 + 格式整理 skill、prompt 去重与寻址模型。

**Architecture:** `packages/harness`（人格/skills）、`packages/agent`（session-runner/direct-proposal/packs）。harness 选择经 `/api/v1/harnesses`（`apps/cli/src/index.ts:585-588`，`listHarnesses()` 驱动）自动暴露；`load_skill` 工具在 `packages/agent/src/session-tools.ts:302-313`。

**通用约定：** 仓库无 git，禁 git 操作；lone `\r` 行尾精确匹配编辑；每 Task 后 `pnpm --filter @margin/harness test`（或相关包）+ `pnpm typecheck` 全绿；微观选区优先（句子/段落级）是文案基调。

---

### Task 1: harness 约束层抽取 + office-zh

**Files:**
- Modify: `packages/harness/src/index.ts:13-65`（Harness 类型、两个人格、REGISTRY）
- Test: `packages/harness/src/index.test.ts`

- [ ] **Step 1: 读现状**（index.ts 全文、index.test.ts）后写失败测试：

```ts
it("composes persona from shared skeleton + parameterized constraints", () => {
  for (const id of ["social-science-zh", "office-zh"] as const) {
    const h = getHarness(id);
    expect(h.systemPrompt).toContain("propose_"); // 编辑契约（共享骨架）
    expect(h.systemPrompt).toContain("选区"); // 微观选区优先（共享骨架）
  }
  expect(getHarness("office-zh").systemPrompt).not.toContain("文献"); // 学术约束不进办公档
  expect(getHarness("office-zh").toolProfile).toEqual([]);
});
it("exposes office-zh in registry", () => {
  expect(listHarnesses().map((h) => h.id)).toContain("office-zh");
});
```

- [ ] **Step 2: 跑测试确认失败** `pnpm --filter @margin/harness test`

- [ ] **Step 3: 重构 index.ts**

```ts
export type HarnessId = "social-science-zh" | "office-zh" | "minimal";
export type SkillScope = "all" | "core" | "none";

/** Shared skeleton: identity + immutable contract. Pack-invariant. */
const CORE_CONTRACT = `你是 Margin：本地文档写作与修订 Agent，与人共创，由人裁决。
编辑契约：正文只经 propose_* 提案，由宿主 Accept/CAS 定稿；不要声称已 apply。
微观优先：用户选中句子/段落时，选区是第一现场，优先在选区内提案；短中文回复。
寻址模型：段落地址是不可变 blockId；用户说"第几页/第几段"时用 get_document_outline + search_blocks 对齐后再提案。
协作澄清：改稿指令过模糊时可尖锐追问；同一改稿线程最多 3 轮，满则按假设提案。
联动底线：选区外禁止静默提案；局部改主张/口径后须大纲+检索，用 offer_cascade 请用户确认相关段。`;

export type HarnessConstraints = {
  /** 证据要求（本档严格度）。 */
  evidence: string;
  /** 禁止编造清单。 */
  fabricationBan: string;
  /** 缺证据时的占位符风格。 */
  placeholder: string;
};

function composePersona(constraints: HarnessConstraints): string {
  return `${CORE_CONTRACT}\n证据底线：${constraints.fabricationBan}；缺则用「${constraints.placeholder}」占位。${constraints.evidence}`;
}
```

- `Harness` 类型加 `skillScope: SkillScope`。
- `social-science-zh`：`skillScope: "all"`，constraints = 禁止编造文献/访谈引语或无法从材料推出的数据、`[需插入引文：…]`、"提案的 evidence 只能填实际读取的 sourceRef"。
- `office-zh`（新增）：id `"office-zh"`、title "中文办公文档修订"、styleHint "准确、简洁、合规格式"、`toolProfile: []`、`skillScope: "core"`，constraints = 禁止编造政策文号/数据/日期、`[需核实：…]`、"数字与依据须来自已挂资料或文稿本身"。
- `minimal`：保持现有极简散文（不套骨架，避免改变其行为），`skillScope: "none"`。
- REGISTRY 注册三者。`runtimeToolAppendix`/`composeSystemPrompt` 签名不变（skills 过滤在 Task 2 接入 `skillScope`）。

注意：既有测试（`index.test.ts:28-43` 断言 toolProfile 等）需同步更新；`docs/` 与 UI 中若列出 harness 名称无需改（走 listHarnesses）。

- [ ] **Step 4: 全绿** `pnpm --filter @margin/harness test && pnpm typecheck`

---

### Task 2: skills pack 归属 + 按 harness 过滤

**Files:**
- Modify: `packages/harness/src/skills/loader.ts`（frontmatter 解析、listAvailableSkills、loadAvailableSkill）
- Modify: `packages/harness/src/index.ts`（composeSystemPrompt 接入 skillScope）
- Modify: `packages/agent/src/session-tools.ts:302-313`（load_skill 工具过滤）
- Modify: 5 个既有 SKILL.md frontmatter（`packages/harness/skills/*/SKILL.md`）
- Test: `packages/harness/src/index.test.ts`（或 loader 专属测试，按现有结构）

- [ ] **Step 1: 失败测试**

```ts
it("filters skills by harness scope", () => {
  const session = composeSystemPrompt("office-zh", "session");
  expect(session).not.toContain("argument-revision-zh");
  expect(session).not.toContain("socratic-revision-zh");
  expect(session).toContain("cascade-consistency-zh"); // core 技能保留
});
```

- [ ] **Step 2: 实现**
  - `parseSkillMarkdown`：frontmatter 支持可选 `packs: a, b`（缺省 = core，即所有 scope 可见）。`SkillMeta` 加 `packs?: string[]`。
  - `listAvailableSkills(workspaceSkillsRoot?, scope: SkillScope = "all")`：scope `"none"` → `[]`；`"core"` → 仅无 packs 或 packs 含 "core"/"office" 者；`"all"` → 全部。workspace 覆盖逻辑不变。
  - `loadAvailableSkill(name, workspaceSkillsRoot?, scope = "all")`：同规则过滤后查找，不在 scope 内抛 `Unknown skill`。
  - `composeSystemPrompt`：`includeSkills` 判定改为 `mode === "session" && harness.skillScope !== "none"`，并把 `harness.skillScope` 传入 listAvailableSkills。
  - `session-tools.ts` 的 `load_skill`：`createSessionTools` 已收 `harnessId`（:140 附近），取 `getHarness(harnessId).skillScope` 传入 loadAvailableSkill。
  - 既有 SKILL.md frontmatter 标注：`argument-revision-zh`/`socratic-revision-zh`/`source-grounded-writing` → `packs: academic`；`fill-table-from-csv` → `packs: data-analysis`；`cascade-consistency-zh` → 不加（core）。

- [ ] **Step 3: 全绿**（harness + agent 两包测试；agent 侧 writing-behavior.test.ts 等若断言索引内容需同步）

---

### Task 3: 格式整理 skill `format-tidy-zh`（core）

**Files:**
- Create: `packages/harness/skills/format-tidy-zh/SKILL.md`
- Test: 在 Task 2 的过滤测试文件补一条"core scope 含 format-tidy-zh"

- [ ] **Step 1: 写 SKILL.md**（frontmatter 不带 packs = core；结构对齐既有 5 个：何时使用/步骤/边界；600-1200 字）：

内容要点：标题层级统一（不跳级）；图表编号连续且文内引用一致；列表/编号样式统一；标点全半角与空格清理；参考文献按 GB/T 7714 规整（仅格式，不补内容）。**提案粒度=选区或单段，逐段 propose_*；禁止整篇重写、禁止改动事实与数据**；用户选中片段时只整理选区。

- [ ] **Step 2: 测试 + 全绿**

---

### Task 4: prompt 去重 + direct-proposal 裁剪

**Files:**
- Modify: `packages/agent/src/session-runner.ts:157-185`（cascadeHint/sourceHint 瘦身）
- Modify: `packages/agent/src/direct-proposal.ts:215-241`（人格注入裁剪）
- Test: `packages/agent/src/index.test.ts` / `session-tools.test.ts` 中断言旧 hint 文案的用例（grep 确认）

- [ ] **Step 1: cascadeHint 瘦身**（:171-175）：

```ts
  const cascadeHint = cascadeIds.length
    ? `\n\n[联动已确认] 用户同意修订这些相关段（每轮最多 3 处）：${cascadeIds.join(", ")}。请 get_block 后 propose_*；勿再 offer_cascade。可 load_skill("cascade-consistency-zh").`
    : isEditOrRewriteIntent(input.message) || selectionIds.length
      ? `\n\n[联动] 选区外禁止静默提案；需联动时先 offer_cascade 请用户确认。可 load_skill("cascade-consistency-zh").`
      : "";
```

（流程细节交给 cascade-consistency-zh skill；若该 skill 正文缺少"主段先提案→outline+search→offer_cascade"流程描述，先补进 SKILL.md 再删 hint。）

- [ ] **Step 2: sourceHint 瘦身**（:183-185）：

```ts
  const sourceHint = sourcePaths.length
    ? `\n\n[已挂资料，只读] ${sourcePaths.join("、")}。涉及资料的事实/引语须先 read_workspace_file 实际读取再起草；提案 evidence 只能填该工具返回的 sourceRef。可 load_skill("source-grounded-writing").`
    : "";
```

（被删的"大纲/检索检查联动、资料不足留占位、回复简短说明"等流程并入 source-grounded-writing SKILL.md，同样先补后删。）

- [ ] **Step 3: direct-proposal 人格裁剪**（`direct-proposal.ts:216 promptFor`）：

`harness.systemPrompt` 替换为 harness 包新导出的 `directIdentity(harnessId)`——只含身份一行 + 编辑契约一行（如 `你是 Margin：本地文档修订 Agent。正文只提案，由宿主定稿。`），从 index.ts 导出并测一条"direct 身份串不含 offer_cascade/工具字样"。

- [ ] **Step 4: 回归** `pnpm --filter @margin/agent test && pnpm --filter @margin/harness test && pnpm typecheck`

---

### Task 5: 全量门禁 + 输出抽查

- [ ] **Step 1:** `cd /e/margin && pnpm test && pnpm typecheck && pnpm build`
- [ ] **Step 2:** `node scripts/ux-walkthrough.mjs "imports/sport value.docx"` 通过（UX_WALKTHROUGH_OK）
- [ ] **Step 3: 抽查**（node -e 或临时脚本，跑完删除）：打印 `composeSystemPrompt("office-zh", "session")` 全文与 `composeSystemPrompt("social-science-zh", "session")` 全文，人工核对：office 档无学术 skills、含骨架+办公约束；社科档 skills 索引完整；同一规则不再重复出现于人格/hint。
- [ ] **Step 4: 更新文档**：`docs/AGENT_ARCHITECTURE.md` 中 harness/skills 章节若描述过时（两个人格、无 skillScope），同步更新为三层结构。

---

## Self-Review 记录

- Spec 覆盖：Step1→Task1；Step2→Task2/3；Step3→Task4；验证→Task5。无缺口。
- 类型一致性：`SkillScope` 仅 Task 1 定义、Task 2 消费；`directIdentity` Task 4 定义于 harness 包导出。
- 已知妥协：minimal 不套骨架（保持行为不变）；office-zh 暂无专属 pack 工具；前端 Settings 是否有 harness 选择 UI 由 Task 1 实现者核对（API 已自动暴露）。
