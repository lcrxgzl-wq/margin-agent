import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DocumentMeta, TableCellProposalDraft } from "@margin/domain";
import { composeSystemPrompt, getAgentProfile, getHarness } from "@margin/harness";
import {
  emitTextChunks,
  generateProposal,
  streamDiscuss,
  type ChatHistoryTurn,
} from "@margin/llm";
import { getHeuristicComments } from "./packs/registry.js";
import { runPiAgentLoop, type ToolAuditEvent } from "./pi-loop.js";
import { assertPiLoopCompleted } from "./pi-outcome.js";
import { decideRoute } from "./policy/router.js";
import { isUserFacingPhase, toolPhaseLabel } from "./progress.js";
import type { Draft } from "./pi-tools.js";
import { hasRuntimeCredentials, resolveRuntimeModel } from "./resolve-model.js";
import {
  createSessionTools,
  type SessionDocBag,
  type SessionSideEffects,
  type WorkspaceBridge,
} from "./session-tools.js";
import { buildClarificationHint, isEditOrRewriteIntent } from "./clarification.js";
import { formatOutlineHint, type CascadeCandidate } from "./cascade.js";
import type { AgentComment, AgentWorkReport, ScanProgressHandler } from "./types.js";

export type SessionTurnInput = {
  message: string;
  /** Unexpanded user text used for this turn's workspace-write approval only. */
  workspaceWriteApprovalMessage?: string;
  /** Prior pi transcript (multi-turn). */
  messages?: AgentMessage[];
  bag: SessionDocBag;
  bridge: WorkspaceBridge;
  harnessId?: string;
  selectionHint?: string;
  selectionBlockIds?: string[];
  /** User-confirmed cascade block ids from offer card. */
  cascadeBlockIds?: string[];
  /** Short chat history for offline/discuss turns. */
  history?: ChatHistoryTurn[];
  onProgress?: ScanProgressHandler;
  /** Incremental assistant text (true streaming when available). */
  onDelta?: (chunk: string) => void;
  /** Abort in-flight Pi turn (e.g. client disconnect). */
  signal?: AbortSignal;
  /** Stable Pi session id for continuity / cache affinity. */
  sessionId?: string;
  /** direct = revise promptly; socratic = ask first, propose only when user greenlights. */
  chatMode?: "direct" | "socratic";
  /** Clarification turns already used in this rewrite/edit thread (0..3). */
  clarificationRound?: number;
  /** Read-only materials attached by the host for this turn. */
  sourcePaths?: string[];
};

export type SessionTurnResult = {
  engine: "pi" | "offline";
  reply: string;
  messages: AgentMessage[];
  proposals: Draft[];
  tableCellProposals?: TableCellProposalDraft[];
  comments: AgentComment[];
  steps: string[];
  opened?: { document: DocumentMeta; blocks: SessionDocBag["blocks"] };
  written?: { relativePath: string; created: boolean };
  loadedSkills?: Array<{ name: string; contentHash: string }>;
  cascadeOffer?: CascadeCandidate[];
  notes?: string[];
  workReport?: AgentWorkReport;
  toolAudit?: ToolAuditEvent[];
};

function buildWorkReport(
  effects: SessionSideEffects,
  steps: string[],
  proposalCount: number,
): AgentWorkReport {
  return {
    sourceRefs: [...new Set(effects.readSourceRefs ?? [])],
    proposalCount,
    inspectedDocument: steps.some((step) =>
      /阅读大纲|浏览段落|阅读选中段落|检索段落/.test(step),
    ),
    consistencyChecked: steps.some((step) =>
      /检索段落|整理联动候选/.test(step),
    ),
  };
}

function maxTurns(fallback: number): number {
  const n = Number(process.env.MARGIN_PI_MAX_TURNS ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function timeoutMs(fallback: number): number {
  const n = Number(process.env.MARGIN_PI_TIMEOUT_MS ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function explicitlyRequestedWorkspaceWritePaths(message: string): string[] {
  const paths: string[] = [];
  const matches = message.matchAll(
    /(?:新建|创建|写入|保存为?|write|create|save(?:\s+as)?)\s+(?:["“']([^"”'\r\n]+\.(?:md|txt|json|csv))\b["”']|([^\s"“”'，。；;:]+\.(?:md|txt|json|csv))\b)/gi,
  );
  for (const match of matches) {
    const clausePrefix = message
      .slice(0, match.index)
      .split(/[，。；;！？!?\r\n]/)
      .at(-1) ?? "";
    if (/(?:不要|别|勿|禁止|不必|无需|do\s+not|don't|never)/i.test(clausePrefix)) continue;
    const requested = (match[1] ?? match[2] ?? "").trim();
    if (requested) paths.push(requested.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return [...new Set(paths)];
}

function extractAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((c) => {
          if (typeof c === "string") return c;
          if (c && typeof c === "object" && "type" in c && (c as { type: string }).type === "text") {
            return String((c as { text?: string }).text ?? "");
          }
          return "";
        })
        .join("")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

/** Full agent turn via pi-agent-core (requires API key / base URL). */
export async function runPiSessionTurn(
  input: SessionTurnInput,
): Promise<SessionTurnResult> {
  const profile = getAgentProfile(input.harnessId);
  const runtime = resolveRuntimeModel(profile.model);
  const { model, apiKey } = runtime;
  if (!hasRuntimeCredentials()) {
    throw new Error(
      "session agent requires API key or Base URL (configure in Settings / CC Switch)",
    );
  }

  const drafts: Draft[] = [];
  const comments: AgentComment[] = [];
  const effects: SessionSideEffects = {};
  const selectionIds = (input.selectionBlockIds ?? []).filter(Boolean);
  const cascadeIds = (input.cascadeBlockIds ?? []).filter(Boolean);
  const tools = createSessionTools(input.bridge, input.bag, drafts, comments, effects, {
    harnessId: input.harnessId,
    enforceProfile: true,
    workspaceWriteApprovedPaths: explicitlyRequestedWorkspaceWritePaths(
      input.workspaceWriteApprovalMessage ?? input.message,
    ),
    selectionBlockIds: selectionIds,
    cascadeConfirmedIds: cascadeIds,
    enforceCascadeGate: selectionIds.length > 0 || cascadeIds.length > 0,
    cascadeUnlocked: cascadeIds.length > 0,
    sourcePaths: input.sourcePaths,
  });
  const steps: string[] = [];

  const emit = (phase: string, tool?: string) => {
    if (!isUserFacingPhase(phase)) return;
    steps.push(phase);
    input.onProgress?.({ phase, tool });
  };
  emit("正在思考…");

  const selection = input.selectionHint?.trim()
    ? `\n\n用户当前选区${selectionIds.length ? `（blockIds: ${selectionIds.join(", ")}）` : ""}：\n"""\n${input.selectionHint.trim().slice(0, 800)}\n"""`
    : selectionIds.length
      ? `\n\n用户选中段落 blockIds: ${selectionIds.join(", ")}`
      : "";
  const docHint = input.bag.relativePath
    ? `\n当前已打开：${input.bag.relativePath}（${input.bag.blocks.length} 段）`
    : "\n当前未打开文稿。";
  const outlineHint =
    input.bag.blocks.length > 0 ? formatOutlineHint(input.bag.blocks) : "";
  const modeHint = buildClarificationHint({
    clarificationRound: input.clarificationRound ?? 0,
    chatMode: input.chatMode,
    harnessId: input.harnessId,
  });
  const cascadeSkillHint =
    getHarness(input.harnessId).skills.scope === "none"
      ? ""
      : `可 load_skill("cascade-consistency-zh").`;
  const cascadeHint = cascadeIds.length
    ? `\n\n[联动已确认] 用户同意修订这些相关段（每轮最多 3 处）：${cascadeIds.join(", ")}。请 get_block 后 propose_*；勿再 offer_cascade。${cascadeSkillHint}`
    : isEditOrRewriteIntent(input.message) || selectionIds.length
      ? `\n\n[联动] 本轮涉及改稿；若需修订选区外段落，先走联动确认流程。${cascadeSkillHint}`
      : "";
  const sourcePaths = [
    ...new Set(
      (input.sourcePaths ?? [])
        .map((item) => item.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter(Boolean),
    ),
  ];
  const sourceSkillHint =
    getHarness(input.harnessId).skills.scope === "all"
      ? `可 load_skill("source-grounded-writing").`
      : "";
  const sourceHint = sourcePaths.length
    ? `\n\n[已挂资料，只读] ${sourcePaths.join("、")}。涉及资料的事实/引语须先 read_workspace_file 实际读取再起草；提案 evidence 用 read_workspace_file 返回的 sourceRef 填写。${sourceSkillHint}`
    : "";

  const result = await runPiAgentLoop({
    prompt: `${input.message}${docHint}${outlineHint}${selection}${modeHint}${cascadeHint}${sourceHint}`,
    systemPrompt: composeSystemPrompt(input.harnessId, "session", {
      workspaceSkillsRoot: input.bridge.skillsRoot,
    }),
    tools,
    messages: input.messages,
    model,
    apiKey,
    sessionId: input.sessionId,
    maxTurns: maxTurns(profile.limits.maxTurns),
    timeoutMs: timeoutMs(profile.limits.timeoutMs),
    maxContextMessages: profile.limits.maxContextMessages,
    maxContextChars: profile.limits.maxContextChars,
    allowedToolNames: tools.map((tool) => tool.name),
    onProgress: emit,
    onDelta: input.onDelta,
    signal: input.signal,
  });
  assertPiLoopCompleted(result, "pi session");

  let reply = extractAssistantText(result.messages) || result.streamedText;
  if (!reply) {
    if (effects.opened) {
      reply = `已打开《${effects.opened.document.relativePath.replace(/^.*\//, "")}》（${effects.opened.blocks.length} 段）。`;
    } else if (drafts.length) {
      reply = `已提出 ${drafts.length} 处修订，请在正文旁 Accept / Undo。`;
    } else if (effects.written) {
      reply = `${effects.written.created ? "已创建" : "已写入"} ${effects.written.relativePath}。`;
    } else if (effects.cascadeOffer?.length) {
      reply = `主修订之外，发现 ${effects.cascadeOffer.length} 处可能需联动；请确认是否一并修改。`;
    } else {
      reply = "本轮已结束。若要继续，直接说下一步。";
    }
    await emitTextChunks(reply, input.onDelta, { chunkSize: 64, delayMs: 8 });
  } else if (!result.streamedText && reply) {
    await emitTextChunks(reply, input.onDelta, { chunkSize: 64, delayMs: 8 });
  }

  const heuristicComments = getHeuristicComments(undefined, input.harnessId);
  if (heuristicComments && drafts.length && comments.length < 2 && input.bag.blocks.length) {
    for (const h of heuristicComments(input.bag.blocks.slice(0, 8), { max: 6 })) {
      if (comments.length >= 10) break;
      comments.push(h);
    }
  }

  return {
    engine: "pi",
    reply,
    messages: result.messages,
    proposals: drafts,
    tableCellProposals: effects.tableCellProposals,
    comments,
    steps,
    opened: effects.opened,
    written: effects.written,
    loadedSkills: effects.loadedSkills,
    cascadeOffer: effects.cascadeOffer,
    notes: result.notes.length ? result.notes : undefined,
    toolAudit: result.toolAudit,
    workReport: buildWorkReport(effects, steps, drafts.length + (effects.tableCellProposals?.length ?? 0)),
  };
}

/**
 * Offline tool-loop (no LLM key): still uses the same tools, planner is deterministic.
 * Used so local UX remains agent-shaped when BYOK is missing.
 */
export async function runOfflineSessionTurn(
  input: SessionTurnInput,
): Promise<SessionTurnResult> {
  const drafts: Draft[] = [];
  const comments: AgentComment[] = [];
  const effects: SessionSideEffects = {};
  const selectionIds = (input.selectionBlockIds ?? []).filter(Boolean);
  const cascadeIds = (input.cascadeBlockIds ?? []).filter(Boolean);
  const tools = createSessionTools(input.bridge, input.bag, drafts, comments, effects, {
    harnessId: input.harnessId,
    selectionBlockIds: selectionIds,
    cascadeConfirmedIds: cascadeIds,
    enforceCascadeGate: selectionIds.length > 0 || cascadeIds.length > 0,
    cascadeUnlocked: cascadeIds.length > 0,
    sourcePaths: input.sourcePaths,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const steps: string[] = [];
  const emit = (phase: string, tool?: string) => {
    if (!isUserFacingPhase(phase)) return;
    steps.push(phase);
    input.onProgress?.({ phase, tool });
  };

  const call = async (name: string, params: Record<string, unknown> = {}) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    const label = toolPhaseLabel(name);
    if (label) emit(label, name);
    return tool.execute("offline", params as never);
  };

  const msg = input.message.trim();
  const notes = ["offline tool loop (no API key)"];

  const finish = async (
    partial: Omit<SessionTurnResult, "engine" | "messages" | "steps" | "notes"> & {
      reply: string;
    },
  ): Promise<SessionTurnResult> => {
    await emitTextChunks(partial.reply, input.onDelta, {
      chunkSize: Math.min(96, Math.max(24, Math.ceil(partial.reply.length / 8))),
      delayMs: 4,
    });
    return {
      engine: "offline",
      messages: input.messages ?? [],
      steps,
      notes,
      workReport: buildWorkReport(effects, steps, partial.proposals.length + (partial.tableCellProposals?.length ?? 0)),
      ...partial,
    };
  };

  // Identity / chitchat — still agent turn, no fake "open first"
  // Note: JS \b is ASCII-word only — never rely on it after CJK.
  if (/^(你是谁|你是什么|介绍一下你自己|who are you)\s*$/i.test(msg)) {
    return finish({
      reply:
        "我是 Margin：本地工作区上的论文 Agent。通过工具读写文件、打开文稿、提出可 Accept/Undo 的修订。未配 API 时走离线工具环；接上 Key 后同一套工具由模型调度。",
      proposals: [],
      comments: [],
    });
  }

  if (/^(你好|您好|嗨|hello|hi)[!！。.?？\s]*$/i.test(msg)) {
    return finish({
      reply: "在。要我列出工作区文稿、打开样章，还是先读某个文件？",
      proposals: [],
      comments: [],
    });
  }

  if (/有哪些|列出|list|ls|文件列表|文章列表|打开文稿|打开文章|打开文件/i.test(msg) && !/打开\s+\S+\.md/i.test(msg) && !/样章/.test(msg)) {
    const result = await call("list_workspace_files");
    const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
    const files = (JSON.parse(text) as { files: string[] }).files;
    return finish({
      reply: files.length
        ? `工作区文稿：\n${files
            .slice(0, 40)
            .map((f) => `· ${f}`)
            .join("\n")}\n\n可以说「打开样章」或「打开 …」。`
        : "工作区里还没有 Markdown、TXT 或 CSV 资料。",
      proposals: [],
      comments: [],
    });
  }

  if (/样章|agent-chapter/i.test(msg) || /打开\s+/i.test(msg)) {
    let path = "fixtures/agent-chapter.md";
    const named = /打开\s+[《"'「]?([^\s》"'」]+)[》"'」]?/i.exec(msg);
    if (named && !/文稿|文章|文件|文档|论文|样章/.test(named[1])) {
      path = named[1];
    }
    if (/样章/.test(msg)) path = "fixtures/agent-chapter.md";
    await call("open_document", { relativePath: path });
    return finish({
      reply: effects.opened
        ? `已打开《${effects.opened.document.relativePath.replace(/^.*\//, "")}》（${effects.opened.blocks.length} 段）。选中一段可以说「重写」。`
        : "打开失败。",
      proposals: [],
      comments: [],
      opened: effects.opened,
    });
  }

  const readMatch = /(?:读取|读一下|read)\s+(\S+)/i.exec(msg);
  if (readMatch) {
    const result = await call("read_workspace_file", {
      relativePath: readMatch[1],
    });
    const text = result.content[0] && "text" in result.content[0]
      ? result.content[0].text
      : "{}";
    const file = JSON.parse(text) as {
      relativePath: string;
      text: string;
      hasMore: boolean;
      nextOffset: number;
    };
    const preview = file.text.length > 1200
      ? `${file.text.slice(0, 1200)}\n…`
      : file.text;
    return finish({
      reply: `已读取 ${file.relativePath}：\n\n${preview}${
        file.hasMore ? `\n\n还有后续内容（nextOffset: ${file.nextOffset}）。` : ""
      }`,
      proposals: [],
      comments: [],
    });
  }

  const writeMatch = /^(?:新建|写入|创建)\s+([^\s：:]+)(?:\s*[：:]\s*|\n+)([\s\S]+)$/i.exec(msg);
  if (writeMatch) {
    await call("write_workspace_file", {
      relativePath: writeMatch[1],
      content: writeMatch[2],
    });
    return finish({
      reply: effects.written
        ? `${effects.written.created ? "已创建" : "已写入"} ${effects.written.relativePath}。`
        : "写入完成。",
      proposals: [],
      comments: [],
      written: effects.written,
    });
  }

  if (/重写|润色|改写|修订/i.test(msg)) {
    if (!input.bag.documentId || !input.bag.blocks.length) {
      await call("open_document", { relativePath: "fixtures/agent-chapter.md" });
    }
    const instruction = extractRewriteInstruction(msg);
    const selected = (input.selectionBlockIds ?? []).filter(Boolean);
    const blockIds = selected.length
      ? selected
      : input.bag.blocks.filter((b) => b.kind !== "heading").slice(0, 2).map((b) => b.id);
    emit(instruction ? "正在按指令生成修订…" : "正在生成修订…");
    for (const id of blockIds) {
      const block = input.bag.blocks.find((b) => b.id === id);
      if (!block || block.kind === "heading") continue;
      const idx = input.bag.blocks.findIndex((b) => b.id === id);
      const neighbors = input.bag.blocks.slice(Math.max(0, idx - 1), idx + 2);
      const out = await generateProposal({
        block,
        neighbors,
        harnessId: input.harnessId,
        instruction,
      });
      await call("propose_block_edit", {
        blockId: id,
        after: out.after,
        rationale: out.rationale,
        risk: out.risk,
      });
    }
    return finish({
      reply: drafts.length
        ? `已提出 ${drafts.length} 处修订${instruction ? "（已按你的指令）" : ""}，请在段旁 Accept / Undo。`
        : "没有生成提案。换一段再试。",
      proposals: drafts,
      tableCellProposals: effects.tableCellProposals,
      comments: getHeuristicComments(undefined, input.harnessId)?.(
        input.bag.blocks.slice(0, 6),
        { max: 6 },
      ) ?? [],
      opened: effects.opened,
    });
  }

  // Default discuss — stream tokens when BYOK; paced mock when offline
  emit(input.bag.documentId ? "正在结合当前文稿思考…" : "正在思考…");
  const outlineHint = input.bag.blocks
    .filter((b) => b.kind === "heading")
    .slice(0, 8)
    .map((b) => b.text.replace(/^#+\s*/, ""))
    .join(" · ");
  const reply = await streamDiscuss(
    {
      message: msg,
      excerpt: input.selectionHint,
      outlineHint,
      harnessId: input.harnessId,
      history: input.history,
      hasDocument: !!input.bag.documentId,
      signal: input.signal,
    },
    input.onDelta,
  );
  return {
    engine: "offline",
    reply,
    messages: input.messages ?? [],
    proposals: [],
    comments: [],
    steps,
    notes,
  };
}

function extractRewriteInstruction(message: string): string | undefined {
  const msg = message.trim();
  const labeled =
    /(?:按(?:照)?(?:以下)?(?:要求|指令)|指令|方向|目标)[：:\s]+([\s\S]+)/i.exec(msg);
  if (labeled?.[1]?.trim()) return labeled[1].trim().slice(0, 600);
  const directed =
    /(?:重写|润色|改写)(?:得|成|为|成[：:]|一下[，,]?)?\s*([^\n]{2,200})$/i.exec(msg);
  if (directed?.[1] && !/这段|选区|全文|一下$|段落/.test(directed[1])) {
    return directed[1].trim();
  }
  return undefined;
}

export async function runSessionTurn(
  input: SessionTurnInput,
): Promise<SessionTurnResult> {
  const decision = decideRoute({
    message: input.message,
    hasCredentials: hasRuntimeCredentials(),
    engineEnv: process.env.MARGIN_ENGINE,
  });
  if (decision.route === "offline_planner" || decision.route === "host_command") {
    return runOfflineSessionTurn(input);
  }
  return runPiSessionTurn(input);
}
