import {
  formatSkillsForPrompt,
  isSkillAllowedInScope,
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
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000) {
    throw new Error("agent profile timeoutMs must be an integer from 1000 to 1800000");
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
对用户：短说、可行动；别讲实现架构；不要否认本机绝对路径可读，也不要把路径讲成抽象沙箱。工具读入的资料是后台上下文：对用户可见回复只写结论与必要短引，不要整段粘贴原文，除非用户明确要求预览。
路径：相对路径优先；用户给本机绝对路径就直接读取；给的是目录则先列出再读具体文件（外读关闭/密钥路径报错再简短说明）。不要要求先拷进工作区；找不到相对路径再列工作区可见资料。资料一次读全文（极大才截断）；勿 offset 分页。
编辑契约：正文只经 propose_* 提案，等人 Accept/CAS 定稿；不要声称已直接改好。
微观优先：用户选中句子/段落时，选区是第一现场，优先在选区内提案。改稿指令用短中文；通读/结构分析等长回答写在可见回复正文（可分段续写），禁止把长文只塞进 finish_turn.summary。
通读：已有 [Margin 文稿全文]…[/Margin 文稿全文] 则以其为准，勿再 outline+cursor 通读（除非用户要求重读或仅剩移除占位）。否则先 get_document_outline；用户要通读全文时从 0:0 连续 read_document_blocks 并用 nextCursor 至 hasMore=false；勿把抽样当通读，勿用读取工具扫已打开文稿。清理后按 blockId/cursor 续读，完成覆盖后写结论并 finish_turn。
证据先行：涉及文稿/资料内容时先用工具实际读取，不要凭记忆或文件名作答，不要假装已打开。
寻址：段落地址是不可变 blockId；用户说"第几页/第几段"时用 outline+search_blocks 对齐后再提案。
协作澄清：改稿指令过模糊时可尖锐追问；同一改稿线程最多 3 轮，满则按假设提案。
联动：选区外禁止静默提案；改主张/口径后须 offer_cascade 请用户确认。全文已注入时直接 offer_cascade；否则先大纲+检索再 offer_cascade。`;

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
  // lean 通读/结构分析要多轮 read_document_blocks；40 仍易在读档阶段耗尽。
  maxTurns: 60,
  timeoutMs: 300_000,
  maxContextMessages: 80,
  maxContextChars: 200_000,
};

/** Optional academic writing agent — cite tools + academic Skills auto-loaded. */
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

/** Default writing agent — full tool surface; academic tone stays optional via Skills / other profile. */
const OFFICE_ZH = validateAgentProfile({
  id: "office-zh",
  title: "中文文档修订",
  styleHint: "准确、简洁、可核对",
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
  // 工具与 Skill 全开；direct 不强制学术方法，语气保持通用
  skills: { scope: "all", direct: ["format-tidy-zh"] },
  limits: { ...DEFAULT_LIMITS },
  approvals: { workspaceWrite: "explicit", remoteMcp: "per-call" },
  instructions: composePersona({
    fabricationBan: "禁止编造政策文号、数据、日期或无法核对的事实",
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
  if (!id) return OFFICE_ZH;
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
export function runtimeToolAppendix(
  harness: Harness,
  mode: "session" | "scan",
  opts?: Pick<ComposeSystemPromptOptions, "unlimitedRead">,
): string {
  const optional = [
    hasCapability(harness, "review.academic") ? "学术检查" : "",
    hasCapability(harness, "analysis.tabular") ? "表格分析" : "",
  ].filter(Boolean);
  const pack = optional.length ? `本 profile 已启用：${optional.join("、")}。` : "";
  const unlimitedOn = opts?.unlimitedRead !== false;
  const readBoundary = unlimitedOn
    ? "外读已开启：可读工作区相对路径与本机绝对路径；给目录则 list_workspace_files 后读具体文件。"
    : "外读已关闭：资料仅限工作区相对路径；读本机绝对路径请在 Agent 设置中开启外读。";
  if (mode === "scan") {
    return `本轮为非持久化扫描（结果由服务落库）。${pack}禁止 bash / 任意写盘 / 直接 apply。按需调用工具，无固定流程。${readBoundary}`;
  }
  return `${pack}禁止 bash、写工作区外、直接 apply。${readBoundary}打开文稿后才能用段落工具。计算数字须经 resultRef 绑定提案。对用户别讲实现架构。`;
}

export type ComposeSystemPromptOptions = {
  /** When false, omit bundled skills index (e.g. minimal / scan). Default: true for session non-minimal. */
  includeSkills?: boolean;
  workspaceSkillsRoot?: string;
  disabledSkills?: readonly string[];
  /** Explicit one-turn Skills (structured ids): inlined into the prompt, bounded, visible errors. */
  selectedSkills?: readonly string[];
  /** Host unlimited external read switch; default treated as ON when omitted. */
  unlimitedRead?: boolean;
};

const MAX_SESSION_SKILL_CHARS = 24_000;

export type SystemPromptResult = {
  prompt: string;
  loadedSkills: Array<{ name: string; contentHash: string }>;
};

export function composeSystemPromptDetailed(
  harnessId: string | undefined,
  mode: "session" | "scan",
  opts?: ComposeSystemPromptOptions,
): SystemPromptResult {
  const harness = getHarness(harnessId);
  const includeSkills =
    opts?.includeSkills ?? (mode === "session" && harness.skills.scope !== "none");
  let prompt = `${harness.instructions}\n风格：${harness.styleHint}\n\n${runtimeToolAppendix(harness, mode, opts)}`;
  const selected = [...new Set((opts?.selectedSkills ?? []).map((name) => name.toLowerCase()))];
  if (selected.length && harness.skills.scope === "none") {
    throw new Error("当前 Agent 模式不允许使用 Skill");
  }
  const disabled = new Set(opts?.disabledSkills ?? []);
  if (includeSkills) {
    prompt += formatSkillsForPrompt(
      listAvailableSkills(opts?.workspaceSkillsRoot, harness.skills.scope)
        .filter((skill) => !disabled.has(skill.name)),
    );
  }
  const loadedSkills: SystemPromptResult["loadedSkills"] = [];
  if (selected.length) {
    const available = new Set(
      listAvailableSkills(opts?.workspaceSkillsRoot, harness.skills.scope).map((skill) => skill.name),
    );
    for (const name of selected) {
      if (disabled.has(name)) throw new Error(`Skill 已关闭: ${name}`);
      if (!available.has(name)) throw new Error(`当前 Agent 模式无法使用 Skill: ${name}`);
    }
    let used = 0;
    const bodies: string[] = [];
    for (const name of selected) {
      const skill = loadAvailableSkill(name, opts?.workspaceSkillsRoot, harness.skills.scope);
      const block = `<skill name="${skill.name}">\n${skill.body}\n</skill>`;
      if (used + block.length > MAX_SESSION_SKILL_CHARS) {
        throw new Error(`所选 Skill 超出本轮容量: ${name}`);
      }
      bodies.push(block);
      loadedSkills.push({ name: skill.name, contentHash: skill.contentHash });
      used += block.length;
    }
    prompt += `\n\n本轮作者显式选用以下 Skill，优先遵循其方法：\n${bodies.join("\n\n")}`;
  }
  return { prompt, loadedSkills };
}

export function composeSystemPrompt(
  harnessId: string | undefined,
  mode: "session" | "scan",
  opts?: ComposeSystemPromptOptions,
): string {
  return composeSystemPromptDetailed(harnessId, mode, opts).prompt;
}

export type ComposeDirectPromptOptions = {
  workspaceSkillsRoot?: string;
  instruction?: string;
  disabledSkills?: readonly string[];
  selectedSkills?: readonly string[];
};

const MAX_DIRECT_SKILL_CHARS = 24_000;

/** Compile the same profile for a single-call Quick Edit, inlining only selected skills. */
export type DirectPromptResult = {
  prompt: string;
  loadedSkills: Array<{ name: string; contentHash: string }>;
};

export function composeDirectPromptDetailed(
  harnessId: string | undefined,
  opts?: ComposeDirectPromptOptions,
): DirectPromptResult {
  const profile = getAgentProfile(harnessId);
  const instructions = `${profile.instructions}\n风格：${profile.styleHint}`;
  const selected = (opts?.selectedSkills ?? []).map((name) => name.toLowerCase());
  const referenced = [...(opts?.instruction ?? "").matchAll(/@([a-z0-9][a-z0-9-]{0,63})\b/gi)]
    .map((match) => match[1]!.toLowerCase());
  const explicit = [...new Set([...selected, ...referenced])];
  if (profile.skills.scope === "none") {
    if (explicit.length) throw new Error("当前 Agent 模式不允许使用 Skill");
    return { prompt: instructions, loadedSkills: [] };
  }
  const disabled = new Set(opts?.disabledSkills ?? []);
  const requested = [...new Set([
    ...profile.skills.direct.filter((name) => !disabled.has(name)),
    ...explicit,
  ])];
  const available = new Set(
    listAvailableSkills(opts?.workspaceSkillsRoot, profile.skills.scope).map((skill) => skill.name),
  );
  for (const name of explicit) {
    if (disabled.has(name)) throw new Error(`Skill 已关闭: ${name}`);
    if (!available.has(name)) throw new Error(`当前 Agent 模式无法使用 Skill: ${name}`);
  }
  let used = 0;
  const bodies: string[] = [];
  const loadedSkills: DirectPromptResult["loadedSkills"] = [];
  for (const name of requested) {
    if (!available.has(name)) continue;
    const skill = loadAvailableSkill(name, opts?.workspaceSkillsRoot, profile.skills.scope);
    const block = `<skill name="${skill.name}">\n${skill.body}\n</skill>`;
    if (used + block.length > MAX_DIRECT_SKILL_CHARS) {
      if (explicit.includes(name)) throw new Error(`所选 Skill 超出本轮容量: ${name}`);
      continue;
    }
    bodies.push(block);
    loadedSkills.push({ name: skill.name, contentHash: skill.contentHash });
    used += block.length;
  }
  return {
    prompt: bodies.length
      ? `${instructions}\n\n本轮为单次 Quick Edit，不调用工具。遵循以下已选 Skill：\n${bodies.join("\n\n")}`
      : instructions,
    loadedSkills,
  };
}

export function composeDirectPrompt(
  harnessId: string | undefined,
  opts?: ComposeDirectPromptOptions,
): string {
  return composeDirectPromptDetailed(harnessId, opts).prompt;
}

export type SkillEffectiveState = SkillMeta & {
  state: "enabled" | "disabled" | "blocked_by_profile";
  overridesBundled: boolean;
};

export function listSkillStates(
  workspaceSkillsRoot: string | undefined,
  scope: SkillScope,
  disabledSkills: readonly string[] = [],
): SkillEffectiveState[] {
  const disabled = new Set(disabledSkills);
  const bundledNames = new Set(listBundledSkills().map((skill) => skill.name));
  return listAvailableSkills(workspaceSkillsRoot, "all").map((skill) => ({
    ...skill,
    state: !isSkillAllowedInScope(skill, scope)
      ? "blocked_by_profile" as const
      : disabled.has(skill.name)
        ? "disabled" as const
        : "enabled" as const,
    overridesBundled: skill.source === "workspace" && bundledNames.has(skill.name),
  }));
}

export {
  formatSkillsForPrompt,
  isSkillAllowedInScope,
  listBundledSkills,
  listAvailableSkills,
  loadBundledSkill,
  loadAvailableSkill,
  importWorkspaceSkill,
  removeWorkspaceSkill,
  type LoadedSkill,
  type SkillMeta,
};
