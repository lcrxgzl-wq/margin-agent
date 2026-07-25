# 提示词与模块化三步重构设计

日期：2026-07-23 · 状态：已批准（用户口头确认三步与推进顺序）
前置：体验重构已收口（见 2026-07-23-ux-overhaul-design.md），门禁全绿。

## 定位（用户确认）

- Margin 是**文档写作/修订的人机共创 agent**：agent 只提案，人按 Y/N/E 裁决（"边注"之名由此来）。
- **主推微观场景**：选中句子/段落级的编辑，符合手工 Word 编辑习惯；选区是人与 agent 之间的主要寻址方式。
- 当前模块化聚焦社科场景；**办公场景是扩张方向**（pack-academic 应是"更严格的 pack-office"，非平行赛道）。
- Word 式"替换+淡色标记"修订模式（文中内联显示增删、同意后修入、留历史）**不在本轮**，下一轮专项设计。

## 现状问题（已核实）

1. 约束苛刻度写死在 `SOCIAL_SCIENCE_ZH.systemPrompt` 散文里（`packages/harness/src/index.ts:36-41`），办公场景只能平行复制，违背 memo §41 的"约束层参数化"。
2. skills 全局加载：`composeSystemPrompt` 只看 `mode==="session" && id!=="minimal"`（`index.ts:94-98`），无 pack 归属；办公 harness 出现后会吃到学术 skills。且 5 个 bundled skills 全是论证/写作向，**格式整理向为零**。
3. 同一规则三处重复：人格（`index.ts:41`）、`cascadeHint`（`session-runner.ts:171-175`）、`sourceHint`（`:183-185`）；sourceHint 是每轮重发的整段流程指令；`direct-proposal.ts:241` 把整段人格塞进无工具 completion（含"用工具/offer_cascade"等无意义噪声）。
4. 提示词无明写的寻址模型：用户说"第几页/第几段"时，模型不知道要用 blockId+outline+search 对齐、选区优先。

## 设计

### Step 1：harness 约束层抽取 + office-zh

`packages/harness/src/index.ts` 重构：

- **共享骨架**（所有 harness 共有，抽为常量 `CORE_CONTRACT`）：身份一句话、编辑契约（只经 propose_* 提案，宿主 Accept/CAS 定稿，不得声称已 apply）、协作澄清预算、选区外禁止静默提案。
- **参数化严格度**：每个 harness 声明 `constraints: { evidence: string; fabricationBan: string; placeholder: string }` 等条目，人格 = 骨架 + 本档约束文案拼接。
  - `social-science-zh`：最严——禁止编造文献/访谈引语、sourceRef 证据、`[需插入引文：…]` 占位。
  - `office-zh`（新增）：较松——禁止编造政策文号/数据来源，占位 `[需核实：…]`；`toolProfile: []`（先复用核心工具面，pack 后续补）；title "中文办公文档修订"，styleHint "准确、简洁、合规格式"。
  - `minimal`：保持现状（最简，无 skills 索引）。
- `HarnessId` 加 `"office-zh"`；`getHarness()` 默认仍为 social-science-zh。harness 选择入口（Settings/启动参数）若已支持列表选择则自动生效，需核对 `apps/web/src/components/Settings.tsx` 与 cli 的 harness 列表端点。
- 微观选区优先写进共享骨架：一句"用户选中句子/段落时，选区是第一现场；优先在选区内提案"。

### Step 2：skills pack 归属 + 格式整理 skills

- `packages/harness/src/skills/loader.ts`：frontmatter 支持可选 `packs:` 字段（逗号分隔，缺省 = core/全部）。`listAvailableSkills(root, opts?: { harnessId? })` 按 harness 的 skillScope 过滤。
- harness 增加 `skillScope: "core" | "all"` 或允许的 pack 名列表：`social-science-zh` → all（现状兼容）；`office-zh` → core + office；`minimal` → 无（现状）。
- 归属标注：现有 5 个 skills 中 `argument-revision-zh`、`socratic-revision-zh`、`source-grounded-writing` 标 `packs: academic`；`cascade-consistency-zh` 为 core（联动是通用机制）；`fill-table-from-csv` 标 `packs: data-analysis`。
- 新增格式整理 skill（core，论文与办公共用）：`format-tidy-zh`——标题层级统一、图表编号连续、列表/编号规整、参考文献格式（GB/T 7714）与标点全半角清理；提案粒度=选区或单段，禁止整篇重写。一个 SKILL.md，按现有 5 个的篇幅与结构（何时使用/步骤/边界）。

### Step 3：prompt 去重 + 寻址模型

- `session-runner.ts`：`cascadeHint`/`sourceHint` 瘦身——只保留"状态事实"（哪些 blockIds 已确认联动、挂了哪些资料 + 必须 read_workspace_file 的要求一句），流程指引改为一句 `可 load_skill("cascade-consistency-zh")` / `("source-grounded-writing")`。人格与 hint 不再重复同一规则。
- 共享骨架补**寻址模型**一段（3 行内）："段落地址是不可变 blockId；用户说'第几页/第几段'时用 get_document_outline + search_blocks 对齐后再提案；选中文字时选区优先"。
- `direct-proposal.ts:241`：人格注入裁剪为"身份+编辑契约两行"（新增 `directProposalIdentity(harness)` 或复用骨架常量），去掉工具/offer_cascade 等无工具场景噪声。

## 边界（YAGNI）

- 不做 Word 式内联修订标记（下一轮专项）。
- 不新增办公 pack 工具（cite/style 仍学术专属）；office-zh 先用核心工具面。
- 不改 CLI 启动参数/协议；harness 选择走既有入口。
- 不做 git 操作。

## 验证

- `pnpm test`（harness 测试更新：三 harness、骨架拼接、skills 过滤）、`pnpm typecheck`、`pnpm build` 全绿。
- `node scripts/ux-walkthrough.mjs "imports/sport value.docx"` 通过（UI 断言不受 prompt 改动影响，跑一次兜底）。
- 抽查 `composeSystemPrompt("office-zh", "session")` 输出：无学术 skills、含骨架+办公约束。
