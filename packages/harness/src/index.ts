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

export type AgentCapability =
  | "workspace.read"
  | "workspace.write"
  | "document.open"
  | "document.inspect"
  | "document.propose"
  | "skills.load"
  | "review.academic"
  | "analysis.tabular"
  | "remote.mcp";

export type AgentProfile = {
  id: HarnessId;
  title: string;
  instructions: string;
  styleHint: string;
  model?: string;
  capabilities: AgentCapability[];
  skills: {
    scope: SkillScope;
    direct: string[];
  };
  limits: {
    maxTurns: number;
    timeoutMs: number;
    maxContextMessages: number;
    maxContextChars: number;
  };
  approvals: {
    workspaceWrite: "explicit" | "never";
    remoteMcp: "per-call" | "never";
  };
};

/** @deprecated Use AgentProfile. */
export type Harness = AgentProfile;

const CAPABILITIES = new Set<AgentCapability>([
  "workspace.read",
  "workspace.write",
  "document.open",
  "document.inspect",
  "document.propose",
  "skills.load",
  "review.academic",
  "analysis.tabular",
  "remote.mcp",
]);

export function validateAgentProfile(profile: AgentProfile): AgentProfile {
  if (!profile.instructions.trim()) throw new Error("agent profile instructions are required");
  if (!profile.styleHint.trim()) throw new Error("agent profile styleHint is required");
  if (profile.model !== undefined && !profile.model.trim()) {
    throw new Error("agent profile model cannot be blank");
  }
  if (new Set(profile.capabilities).size !== profile.capabilities.length) {
    throw new Error("agent profile capabilities must be unique");
  }
  for (const capability of profile.capabilities) {
    if (!CAPABILITIES.has(capability)) throw new Error(`unknown agent capability: ${capability}`);
  }
  if (!["all", "core", "none"].includes(profile.skills.scope)) {
    throw new Error("invalid agent profile skill scope");
  }
  if (profile.skills.direct.length > 16 || profile.skills.direct.some(
    (name) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name),
  )) {
    throw new Error("invalid direct skill list");
  }
  const { maxTurns, timeoutMs, maxContextMessages, maxContextChars } = profile.limits;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) {
    throw new Error("agent profile maxTurns must be an integer from 1 to 100");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("agent profile timeoutMs must be an integer from 1000 to 600000");
  }
  if (!Number.isInteger(maxContextMessages) || maxContextMessages < 4 || maxContextMessages > 200) {
    throw new Error("agent profile maxContextMessages must be an integer from 4 to 200");
  }
  if (!Number.isInteger(maxContextChars) || maxContextChars < 8_000 || maxContextChars > 1_000_000) {
    throw new Error("agent profile maxContextChars must be an integer from 8000 to 1000000");
  }
  if (!["explicit", "never"].includes(profile.approvals.workspaceWrite)) {
    throw new Error("invalid workspace write approval policy");
  }
  if (!["per-call", "never"].includes(profile.approvals.remoteMcp)) {
    throw new Error("invalid remote MCP approval policy");
  }
  return profile;
}

export function hasCapability(
  profile: AgentProfile,
  capability: AgentCapability,
): boolean {
  return profile.capabilities.includes(capability);
}

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

const DEFAULT_LIMITS: AgentProfile["limits"] = {
  maxTurns: 20,
  timeoutMs: 120_000,
  maxContextMessages: 80,
  maxContextChars: 200_000,
};

/** Academic writing agent — shared skeleton + strictest evidence constraints. */
const SOCIAL_SCIENCE_ZH = validateAgentProfile({
  id: "social-science-zh",
  title: "中文社科论文修订",
  styleHint: "问题意识清晰、文献对话、克制可辩护",
  capabilities: [
    "workspace.read",
    "workspace.write",
    "document.open",
    "document.inspect",
    "document.propose",
    "skills.load",
    "review.academic",
    "analysis.tabular",
    "remote.mcp",
  ],
  skills: {
    scope: "all",
    direct: ["argument-revision-zh", "source-grounded-writing"],
  },
  limits: { ...DEFAULT_LIMITS },
  approvals: { workspaceWrite: "explicit", remoteMcp: "per-call" },
  instructions: composePersona({
    fabricationBan: "禁止编造文献、访谈引语或无法从材料推出的数据",
    placeholder: "[需插入引文：…]",
    evidence: "提案的 evidence 只能填实际读取的 sourceRef。",
  }),
});

/** Office writing agent — shared skeleton + compliance-oriented constraints. */
const OFFICE_ZH = validateAgentProfile({
  id: "office-zh",
  title: "中文办公文档修订",
  styleHint: "准确、简洁、合规格式",
  capabilities: [
    "workspace.read",
    "workspace.write",
    "document.open",
    "document.inspect",
    "document.propose",
    "skills.load",
  ],
  skills: { scope: "core", direct: ["format-tidy-zh"] },
  limits: { ...DEFAULT_LIMITS },
  approvals: { workspaceWrite: "explicit", remoteMcp: "never" },
  instructions: composePersona({
    fabricationBan: "禁止编造政策文号、数据或日期",
    placeholder: "[需核实：…]",
    evidence: "数字与依据须来自已挂资料或文稿本身。",
  }),
});

const MINIMAL = validateAgentProfile({
  id: "minimal",
  title: "最小修订",
  styleHint: "保持原意，小幅改清晰度",
  capabilities: ["document.propose"],
  skills: { scope: "none", direct: [] },
  limits: { ...DEFAULT_LIMITS, maxTurns: 8, maxContextMessages: 24, maxContextChars: 60_000 },
  approvals: { workspaceWrite: "never", remoteMcp: "never" },
  instructions: `你是 Margin：本地文档修订 Agent。
短中文；保持原意；正文只经提案由作者确认；勿虚构事实。`,
});

const REGISTRY: Record<HarnessId, Harness> = {
  "social-science-zh": SOCIAL_SCIENCE_ZH,
  "office-zh": OFFICE_ZH,
  minimal: MINIMAL,
};

export function getHarness(id?: string): Harness {
  if (!id) return SOCIAL_SCIENCE_ZH;
  const profile = REGISTRY[id as HarnessId];
  if (!profile) throw new Error(`Unknown agent profile: ${id}`);
  return profile;
}

export const getAgentProfile = getHarness;

/** Profile instructions for tool-less completions. */
export function directIdentity(harnessId?: string): string {
  return getAgentProfile(harnessId).instructions;
}

export function listHarnesses(): Harness[] {
  return Object.values(REGISTRY);
}

/**
 * Capability boundary only — tool names live in the tool schema (Pi style).
 * Keep this appendix short.
 */
export function runtimeToolAppendix(harness: Harness, mode: "session" | "scan"): string {
  const optional = [
    hasCapability(harness, "review.academic") ? "学术检查" : "",
    hasCapability(harness, "analysis.tabular") ? "表格分析" : "",
  ].filter(Boolean);
  const pack = optional.length ? `本 profile 已启用：${optional.join("、")}。` : "";
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
    opts?.includeSkills ?? (mode === "session" && harness.skills.scope !== "none");
  let prompt = `${harness.instructions}\n风格：${harness.styleHint}\n\n${runtimeToolAppendix(harness, mode)}`;
  if (includeSkills) {
    prompt += formatSkillsForPrompt(listAvailableSkills(opts?.workspaceSkillsRoot, harness.skills.scope));
  }
  return prompt;
}

export type ComposeDirectPromptOptions = {
  workspaceSkillsRoot?: string;
  instruction?: string;
};

const MAX_DIRECT_SKILL_CHARS = 24_000;

/** Compile the same profile for a single-call Quick Edit, inlining only selected skills. */
export function composeDirectPrompt(
  harnessId: string | undefined,
  opts?: ComposeDirectPromptOptions,
): string {
  const profile = getAgentProfile(harnessId);
  const instructions = `${profile.instructions}\n风格：${profile.styleHint}`;
  if (profile.skills.scope === "none") return instructions;
  const referenced = [...(opts?.instruction ?? "").matchAll(/@([a-z0-9][a-z0-9-]{0,63})\b/gi)]
    .map((match) => match[1]!.toLowerCase());
  const requested = [...new Set([...profile.skills.direct, ...referenced])];
  const available = new Set(
    listAvailableSkills(opts?.workspaceSkillsRoot, profile.skills.scope).map((skill) => skill.name),
  );
  let used = 0;
  const bodies: string[] = [];
  for (const name of requested) {
    if (!available.has(name)) continue;
    const skill = loadAvailableSkill(name, opts?.workspaceSkillsRoot, profile.skills.scope);
    const block = `<skill name="${skill.name}">\n${skill.body}\n</skill>`;
    if (used + block.length > MAX_DIRECT_SKILL_CHARS) continue;
    bodies.push(block);
    used += block.length;
  }
  return bodies.length
    ? `${instructions}\n\n本轮为单次 Quick Edit，不调用工具。遵循以下已选 Skill：\n${bodies.join("\n\n")}`
    : instructions;
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
