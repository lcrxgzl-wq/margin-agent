import {
  formatSkillsForPrompt,
  listBundledSkills,
  listAvailableSkills,
  loadBundledSkill,
  loadAvailableSkill,
  importWorkspaceSkill,
  removeWorkspaceSkill,
  type LoadedSkill,
  type SkillMeta,
} from "./skills/loader.js";

export type HarnessId = "social-science-zh" | "office-zh" | "minimal";
export type SkillScope = "all" | "core" | "none";

export type Harness = {
  id: HarnessId;
  title: string;
  systemPrompt: string;
  styleHint: string;
  toolProfile: string[];
  skillScope: SkillScope;
};

/** Shared skeleton: identity + immutable contract. Pack-invariant. */
const CORE_CONTRACT = `你是 Margin：本地文档写作与修订 Agent，与人共创，由人裁决。
编辑契约：正文只经 propose_* 提案，由宿主 Accept/CAS 定稿；不要声称已 apply。
微观优先：用户选中句子/段落时，选区是第一现场，优先在选区内提案；短中文回复。
证据先行：涉及文稿/资料内容时先用工具实际读取，不要凭记忆或文件名作答，不要假装已打开。
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
  return `${CORE_CONTRACT}
证据底线：${constraints.fabricationBan}；缺则用「${constraints.placeholder}」占位。${constraints.evidence}`;
}

/** Academic writing agent — shared skeleton + strictest evidence constraints. */
const SOCIAL_SCIENCE_ZH: Harness = {
  id: "social-science-zh",
  title: "中文社科论文修订",
  styleHint: "问题意识清晰、文献对话、克制可辩护",
  toolProfile: [
    "cite_check",
    "style_lint",
    "inspect_tabular_file",
    "run_table_analysis",
    "get_analysis_result",
    "propose_block_edit_from_results",
  ],
  skillScope: "all",
  systemPrompt: composePersona({
    fabricationBan: "禁止编造文献、访谈引语或无法从材料推出的数据",
    placeholder: "[需插入引文：…]",
    evidence: "提案的 evidence 只能填实际读取的 sourceRef。",
  }),
};

/** Office writing agent — shared skeleton + compliance-oriented constraints. */
const OFFICE_ZH: Harness = {
  id: "office-zh",
  title: "中文办公文档修订",
  styleHint: "准确、简洁、合规格式",
  toolProfile: [],
  skillScope: "core",
  systemPrompt: composePersona({
    fabricationBan: "禁止编造政策文号、数据或日期",
    placeholder: "[需核实：…]",
    evidence: "数字与依据须来自已挂资料或文稿本身。",
  }),
};

const MINIMAL: Harness = {
  id: "minimal",
  title: "最小修订",
  styleHint: "保持原意，小幅改清晰度",
  toolProfile: [],
  skillScope: "none",
  systemPrompt: `你是 Margin：本地写作与文档处理 Agent。
短中文；文稿操作走工具；正文只提案不 apply；勿虚构事实。`,
};

const REGISTRY: Record<HarnessId, Harness> = {
  "social-science-zh": SOCIAL_SCIENCE_ZH,
  "office-zh": OFFICE_ZH,
  minimal: MINIMAL,
};

export function getHarness(id?: string): Harness {
  if (id && id in REGISTRY) return REGISTRY[id as HarnessId];
  return SOCIAL_SCIENCE_ZH;
}

/**
 * Identity-only prompt for tool-less direct completions (no tools, no cascade).
 * `harnessId` is reserved for per-harness wording; all harnesses currently
 * share this single identity text.
 */
export function directIdentity(_harnessId?: string): string {
  return `你是 Margin：本地文档修订 Agent。正文只经提案，由宿主 Accept/CAS 定稿；不要声称已 apply。`;
}

export function listHarnesses(): Harness[] {
  return Object.values(REGISTRY);
}

/**
 * Capability boundary only — tool names live in the tool schema (Pi style).
 * Keep this appendix short.
 */
export function runtimeToolAppendix(harness: Harness, mode: "session" | "scan"): string {
  const pack =
    harness.toolProfile.length > 0
      ? `本 harness 已启用 pack 工具（${harness.toolProfile.length} 个，见工具 schema）。`
      : "";
  if (mode === "scan") {
    return `本轮为非持久化扫描（宿主落库）。${pack}禁止 bash / 任意 FS / 直接 apply。按需调用工具，无固定流程。`;
  }
  return `${pack}禁止 bash、工作区外路径、直接 apply。打开文稿后才能用段落工具。计算数字须经 resultRef 绑定提案。`;
}

export type ComposeSystemPromptOptions = {
  /** When false, omit bundled skills index (e.g. minimal / scan). Default: true for session non-minimal. */
  includeSkills?: boolean;
  workspaceSkillsRoot?: string;
};

export function composeSystemPrompt(
  harnessId: string | undefined,
  mode: "session" | "scan",
  opts?: ComposeSystemPromptOptions,
): string {
  const harness = getHarness(harnessId);
  const includeSkills =
    opts?.includeSkills ?? (mode === "session" && harness.skillScope !== "none");
  let prompt = `${harness.systemPrompt}\n\n${runtimeToolAppendix(harness, mode)}`;
  if (includeSkills) {
    prompt += formatSkillsForPrompt(listAvailableSkills(opts?.workspaceSkillsRoot, harness.skillScope));
  }
  return prompt;
}

export {
  formatSkillsForPrompt,
  listBundledSkills,
  listAvailableSkills,
  loadBundledSkill,
  loadAvailableSkill,
  importWorkspaceSkill,
  removeWorkspaceSkill,
  type LoadedSkill,
  type SkillMeta,
};
