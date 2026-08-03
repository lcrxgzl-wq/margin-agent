import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  PiLoopFailure,
  getHarness,
  hasRuntimeCredentials,
  nextClarificationRound,
  normalizeAttachedEvidenceCache,
  orchestrateCompaction,
  resolveRuntimeModel,
  runSessionTurn,
  stripLiteralThinkingBlocks,
  type CompactionEvent,
  type SummarizerFn,
  type AgentMessage,
  type SessionDocBag,
  type SessionTurnResult,
  type WorkspaceBridge,
  type ToolAuditEvent,
  type RemoteMcpApprovalFn,
  type RemoteMcpBridge,
} from "@margin/agent";
import type { BlockSnapshot, DocumentMeta, EvidenceCacheEntry, Proposal } from "@margin/domain";
import {
  archiveAgentSession,
  activeProfile,
  assertNotRegisteredDocumentWrite,
  enqueueDocumentMutation,
  getDocument,
  importExternalDocxDocument,
  latestAgentCompactionSummary,
  listBlocks,
  listWorkspaceSourceFiles,
  listRegisteredDocumentPaths,
  loadAgentSession,
  loadAgentSessionEnvelope,
  openDocumentFile,
  readRegisteredDocumentContentHash,
  readWorkspaceSource,
  readWorkspaceSourceVersion,
  readLlmSettingsStore,
  readSkillSettings,
  disabledSkillNames,
  readNativeDocxTableCell,
  saveAgentCompaction,
  saveAgentSession,
  saveScanArtifactsAtomically,
  saveAgentTranscript,
  writeWorkspaceText,
  type PersistedAgentSession,
  type PersistedAgentTask,
  type PersistedReviewThread,
  type Workspace,
} from "@margin/storage-local";
import type { ChatMemory } from "./chat-memory.js";
import type { McpApprovalAuditEntry } from "./mcp-approvals.js";
import {
  claimsDocumentOpened,
  isDocumentOpenStatusMessage,
  parseExplicitLocalDocxPath,
} from "./local-document-intent.js";
import { buildDomainSnapshot, buildProposalHint, buildSessionSummaryNote } from "./conversation-notes.js";
import { workspacePathComparisonKey } from "./workspace-path.js";

const MAX_SOURCE_PATHS = 50;

export type ChatAgentState = {
  sessionId: string;
  agentMessages: AgentMessage[];
  bag: SessionDocBag;
  /** Clarification turns already used in the current rewrite/edit thread (0..3). */
  clarificationRounds: number;
  sourcePaths: string[];
  evidenceCache: EvidenceCacheEntry[];
  /** Main document that owns sourcePaths; used to clear attachments on document switch. */
  sourceDocumentId?: string;
  task?: PersistedAgentTask;
  /** Stale persisted task kept only long enough to restart it on the current revision. */
  restartTask?: PersistedAgentTask;
  /** A reset already happened server-side but has not reached a successful UI response yet. */
  conversationResetPending: boolean;
  /** Stay on lean document injection after an overflow demotion this session. */
  documentModeLeanLock: boolean;
};

export function createChatAgentState(seed?: {
  sessionId?: string;
  agentMessages?: AgentMessage[];
  clarificationRounds?: number;
  sourcePaths?: string[];
  evidenceCache?: EvidenceCacheEntry[];
  sourceDocumentId?: string;
  task?: PersistedAgentTask;
  documentModeLeanLock?: boolean;
}): ChatAgentState {
  return {
    sessionId: seed?.sessionId ?? randomUUID(),
    agentMessages: seed?.agentMessages ?? [],
    bag: { revision: 0, blocks: [] },
    clarificationRounds: seed?.clarificationRounds ?? 0,
    sourcePaths: seed?.sourcePaths ?? [],
    evidenceCache: seed?.evidenceCache ?? [],
    sourceDocumentId: seed?.sourceDocumentId,
    task: seed?.task,
    conversationResetPending: false,
    documentModeLeanLock: Boolean(seed?.documentModeLeanLock),
  };
}

/** Rebuild in-memory agent state from a persisted session envelope (startup or session switch). */
export function chatAgentStateFromSession(
  workspace: Workspace,
  saved: PersistedAgentSession | null,
): ChatAgentState {
  if (!saved?.sessionId || !Array.isArray(saved.messages)) {
    return createChatAgentState();
  }
  const state = createChatAgentState({
    sessionId: saved.sessionId,
    agentMessages: saved.messages as AgentMessage[],
    clarificationRounds: saved.clarificationRounds ?? 0,
    sourcePaths: saved.sourcePaths ?? [],
    evidenceCache: normalizeAttachedEvidenceCache(saved.evidenceCache ?? [], saved.sourcePaths ?? []),
    sourceDocumentId: saved.documentId,
    task: saved.task,
    documentModeLeanLock: Boolean(saved.documentModeLeanLock),
  });
  if (saved.documentId) {
    try {
      const document = getDocument(workspace, saved.documentId);
      state.bag = {
        documentId: document.id,
        revision: document.revision,
        relativePath: document.relativePath,
        blocks: listBlocks(workspace, document.id),
      };
    } catch {
      state.sourcePaths = [];
      state.evidenceCache = [];
      state.sourceDocumentId = undefined;
    }
  }
  if (
    state.task?.status === "interrupted" &&
    !isTaskResumableForDocument(state.task, state.bag)
  ) {
    state.restartTask = state.task;
    state.task = undefined;
    state.agentMessages = [];
    state.clarificationRounds = 0;
  }
  return state;
}

/** Restore Pi AgentMessage[] from the last persisted session, if any. */
export function restoreChatAgentState(workspace: Workspace): ChatAgentState {
  return chatAgentStateFromSession(workspace, loadAgentSession(workspace));
}

/** Keep a hidden stale task durable without exposing its selection to the UI. */
export function taskForPersistence(state: ChatAgentState): PersistedAgentTask | undefined {
  return state.task ?? state.restartTask;
}


/** Short chat turns for UI hydrate (may be empty on legacy sessions). */
export function loadPersistedChatTurns(workspace: Workspace): Array<{
  role: "user" | "assistant" | "system";
  text: string;
  threadId?: string;
}> {
  return loadAgentSession(workspace)?.chatTurns ?? [];
}

export function loadPersistedReviewThreads(workspace: Workspace): PersistedReviewThread[] {
  return loadAgentSession(workspace)?.threads ?? [];
}

export function syncBagFromDocument(
  state: ChatAgentState,
  document: DocumentMeta,
  blocks: BlockSnapshot[],
): boolean {
  const currentDocumentId = state.sourceDocumentId ?? state.bag.documentId;
  const switched = Boolean(currentDocumentId && currentDocumentId !== document.id);
  if (switched) {
    clearChatAgentConversation(state);
    state.sourcePaths = [];
  }
  state.sourceDocumentId = document.id;
  state.bag = {
    documentId: document.id,
    revision: document.revision,
    relativePath: document.relativePath,
    blocks,
  };
  if (
    state.task?.status === "interrupted" &&
    !isTaskResumableForDocument(state.task, state.bag)
  ) {
    state.restartTask = state.task;
    state.task = undefined;
    state.agentMessages = [];
    state.clarificationRounds = 0;
  }
  return switched;
}

export function replaceAttachedSources(
  state: ChatAgentState,
  workspace: Workspace,
  requestedPaths: string[],
): void {
  const normalizedRequested = [...new Set(requestedPaths
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(Boolean))];
  if (
    normalizedRequested.length === state.sourcePaths.length &&
    normalizedRequested.every((value, index) => value === state.sourcePaths[index]?.replace(/\\/g, "/"))
  ) {
    state.evidenceCache = normalizeAttachedEvidenceCache(state.evidenceCache, state.sourcePaths);
    return;
  }
  const available = new Map(
    listWorkspaceSourceFiles(workspace).map((relativePath) => [
      workspacePathComparisonKey(relativePath),
      relativePath,
    ]),
  );
  const sourcePaths: string[] = [];
  for (const requested of normalizedRequested) {
    const normalized = requested
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    if (!normalized) continue;
    const relativePath = available.get(workspacePathComparisonKey(normalized));
    if (!relativePath) {
      throw new Error(`source file not found or unsupported: ${normalized}`);
    }
    if (!sourcePaths.includes(relativePath)) {
      if (sourcePaths.length >= MAX_SOURCE_PATHS) {
        throw new Error(`too many attached sources (max ${MAX_SOURCE_PATHS})`);
      }
      sourcePaths.push(relativePath);
    }
  }
  state.sourcePaths = sourcePaths;
  state.evidenceCache = normalizeAttachedEvidenceCache(state.evidenceCache, sourcePaths);
  state.sourceDocumentId = state.bag.documentId;
}

export function createWorkspaceBridge(
  workspace: Workspace,
  activeDocument?: SessionDocBag,
): WorkspaceBridge {
  return {
    skillsRoot: path.join(workspace.root, ".margin", "skills"),
    listSourceFiles: () => listWorkspaceSourceFiles(workspace),
    readText: (relativePath) =>
      readWorkspaceSource(workspace, relativePath, {
        unlimitedRead: process.env.MARGIN_UNLIMITED === "1",
      }),
    readVersion: (relativePath) =>
      readWorkspaceSourceVersion(workspace, relativePath, {
        unlimitedRead: process.env.MARGIN_UNLIMITED === "1",
      }),
    writeText: (relativePath, content) => {
      assertNotRegisteredDocumentWrite(workspace, relativePath);
      return writeWorkspaceText(workspace, relativePath, content);
    },
    openDocument: async (relativePath) => {
      const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
      const activePath = activeDocument?.relativePath
        ?.replace(/\\/g, "/")
        .replace(/^\.\//, "");
      const sameActivePath = Boolean(
        activeDocument?.documentId &&
        activePath !== undefined &&
        workspacePathComparisonKey(activePath) === workspacePathComparisonKey(normalizedPath),
      );
      const indexedDocument = sameActivePath
        ? getDocument(workspace, activeDocument!.documentId!)
        : undefined;
      const unchangedActiveDocument = Boolean(
        indexedDocument &&
        indexedDocument.revision === activeDocument?.revision &&
        readRegisteredDocumentContentHash(workspace, indexedDocument.relativePath) ===
          indexedDocument.contentHash,
      );
      const document = unchangedActiveDocument
        ? indexedDocument!
        : await openDocumentFile(workspace, normalizedPath);
      const blocks = listBlocks(workspace, document.id);
      return {
        document,
        blocks,
        alreadyOpen: unchangedActiveDocument,
      };
    },
    listProtectedDocumentPaths: () => listRegisteredDocumentPaths(workspace),
    readTableCell: (documentId, blockId, row, column) =>
      readNativeDocxTableCell(workspace, documentId, blockId, row, column),
  };
}

export type ChatAgentTurnResult = {
  reply: string;
  /** Host reset document-scoped conversation context during this turn. */
  conversationReset?: boolean;
  opened?: { document: DocumentMeta; blocks: BlockSnapshot[] };
  engine?: string;
  steps?: string[];
  proposalCount?: number;
  clarificationRounds?: number;
  sourcePaths: string[];
  cascadeOffer?: Array<{ blockId: string; reason: string; query?: string }>;
  notes?: string[];
  /** Skills inlined via explicit selection or loaded via load_skill this turn. */
  loadedSkills?: Array<{ name: string; contentHash: string }>;
  task?: PersistedAgentTask;
};

function taskDocumentBinding(bag: SessionDocBag): {
  documentId?: string;
  documentRevision?: number;
} {
  return bag.documentId
    ? { documentId: bag.documentId, documentRevision: bag.revision }
    : {};
}

function isTaskResumableForDocument(
  task: PersistedAgentTask,
  bag: SessionDocBag,
): boolean {
  if (!bag.documentId) {
    return task.documentId === undefined &&
      task.documentRevision === undefined &&
      task.selection === undefined;
  }
  return task.documentId === bag.documentId && task.documentRevision === bag.revision;
}

function isTaskResumeRequest(message: string): boolean {
  return /^(?:请)?(?:继续(?:分析|处理|通读|审阅|检查|修改|修订|润色|写|做)?|接着(?:做|分析|处理|通读|审阅|检查|修改|修订|润色|写)?|恢复(?:任务|上次任务)?|continue(?:\s+(?:analysis|working|the\s+task))?)(?:一下|下去)?(?:吧|呢)?(?:[。！？!.?])?$/i.test(
    message.trim(),
  );
}

export function buildTranscriptPayload(input: {
  steps?: string[];
  reply: string;
  proposalCount: number;
  clarificationRounds: number;
  sessionId: string;
  engine: string;
  notes?: string[];
  loadedSkills?: Array<{ name: string; contentHash: string }>;
  sourcePaths: string[];
  toolAudit?: ToolAuditEvent[];
  mcpApprovals?: McpApprovalAuditEntry[];
}) {
  return {
    steps: (input.steps ?? []).slice(-24),
    replySummary: input.reply.replace(/\s+/g, " ").slice(0, 1_000),
    proposalCount: input.proposalCount,
    clarificationRounds: input.clarificationRounds,
    sessionId: input.sessionId,
    engine: input.engine,
    notes: input.notes?.slice(-12).map((note) => note.slice(0, 500)),
    loadedSkills: input.loadedSkills?.slice(-20),
    sourcePaths: input.sourcePaths.slice(0, MAX_SOURCE_PATHS),
    toolAudit: input.toolAudit?.slice(-24).map((event) => ({
      toolCallId: event.toolCallId.slice(0, 200),
      toolName: event.toolName.slice(0, 120),
      status: event.status,
      durationMs: Math.max(0, Math.floor(event.durationMs)),
      args: event.args,
    })),
    mcpApprovals: input.mcpApprovals?.slice(-12),
  };
}

/** Clear conversational model state without detaching the active document or its sources. */
export function clearChatAgentConversation(state: ChatAgentState): void {
  state.sessionId = randomUUID();
  state.agentMessages = [];
  state.clarificationRounds = 0;
  state.evidenceCache = [];
  state.task = undefined;
  state.restartTask = undefined;
  state.conversationResetPending = false;
  state.documentModeLeanLock = false;
}

/** Append a rule-based "[Margin 记录]" user-role note to the pi transcript (model-visible memory). */
export function appendConversationNote(state: ChatAgentState, note: string): void {
  const text = note.trim();
  if (!text) return;
  state.agentMessages.push({
    role: "user" as const,
    content: text,
    timestamp: Date.now(),
  } as AgentMessage);
}

/**
 * New-session flow: archive the current transcript, reset conversation state,
 * then seed a deterministic summary note so the next session inherits context.
 */
export function rotateChatSessionWithSummary(
  workspace: Workspace,
  state: ChatAgentState,
  hasChatTurns: boolean,
): void {
  const previousSessionId = state.sessionId;
  const hasContent =
    state.agentMessages.length > 0 || hasChatTurns || Boolean(taskForPersistence(state));
  const archived = hasContent
    ? archiveAgentSession(workspace, previousSessionId)
    : false;
  clearChatAgentConversation(state);
  if (!archived) return;
  const envelope = loadAgentSessionEnvelope(workspace, previousSessionId);
  const note = envelope
    ? buildSessionSummaryNote(workspace, envelope)
    : undefined;
  if (note) appendConversationNote(state, note);
}

const compactionConversationNote = (event: CompactionEvent): string =>
  `[Margin 记录] 上下文已压缩：约 ${event.tokensBefore} → ${event.tokensAfter} tokens，压缩前记录已存档`;

const compactionChatTurnText = (event: CompactionEvent): string =>
  `上下文已压缩：约 ${event.tokensBefore} → ${event.tokensAfter} tokens（压缩前记录已存档）`;

const compactionSwapWarning = (event: CompactionEvent): string =>
  `[Margin 警告] 压缩换血校验未通过（eventId: ${event.eventId}）：压缩前记录已存档，但转录未替换，请以存档为准`;

/** role + content equality, tolerant of array-vs-string content blocks. */
function sameMessageIdentity(
  left: AgentMessage | undefined,
  right: AgentMessage | undefined,
): boolean {
  if (!left || !right) return false;
  const a = left as { role?: unknown; content?: unknown };
  const b = right as { role?: unknown; content?: unknown };
  return a.role === b.role && JSON.stringify(a.content) === JSON.stringify(b.content);
}

/**
 * Settle one compaction event on the host side: archive the compaction-time
 * snapshot (messagesBefore — not the possibly-grown current transcript),
 * swap the live transcript's messagesBefore prefix for messagesAfter, then
 * leave a model-visible note and a UI-visible system chat turn.
 * Idempotent per eventId: a repeated settle is a no-op.
 *
 * Swap safety: pi only appends messages, so the compaction-time view must be
 * a prefix of the turn-end transcript (verified by length + last-message
 * identity). The overflow path is detected by the messagesAfter head already
 * sitting at the transcript head. When neither holds, the archive is kept
 * but the transcript is left untouched (宁缺毋错) with a warning note.
 */
export function settleCompactionEvent(
  workspace: Workspace,
  state: ChatAgentState,
  chat: ChatMemory,
  event: CompactionEvent,
): boolean {
  const archived = saveAgentCompaction(workspace, {
    sessionId: state.sessionId,
    eventId: event.eventId,
    reason: event.reason,
    tokensBefore: event.tokensBefore,
    tokensAfter: event.tokensAfter,
    summary: event.summary,
    previousSummary: latestAgentCompactionSummary(workspace, state.sessionId),
    messages: event.messagesBefore,
  });
  if (archived.duplicate) return false;
  const current = state.agentMessages;
  // Overflow path: pi-loop already wrote the compacted transcript back.
  const alreadyApplied = sameMessageIdentity(current[0], event.messagesAfter[0]);
  if (!alreadyApplied) {
    const prefixIntact =
      event.messagesBefore.length > 0 &&
      current.length >= event.messagesBefore.length &&
      sameMessageIdentity(
        current[event.messagesBefore.length - 1],
        event.messagesBefore[event.messagesBefore.length - 1],
      );
    if (!prefixIntact) {
      const warning = compactionSwapWarning(event);
      appendConversationNote(state, warning);
      chat.remember("system", warning);
      return true;
    }
    state.agentMessages = [
      ...event.messagesAfter,
      ...current.slice(event.messagesBefore.length),
    ];
  }
  appendConversationNote(state, compactionConversationNote(event));
  chat.remember("system", compactionChatTurnText(event));
  return true;
}

/** Manual compaction failures map to 409 at the route layer. */
export class ManualCompactionError extends Error {}

/**
 * POST /sessions/compact core: force a fresh summarization of the current
 * transcript (reason "manual"), then settle through the same path as
 * automatic compactions and persist the session envelope.
 */
export async function compactChatAgentConversation(opts: {
  workspace: Workspace;
  agentState: ChatAgentState;
  chat: ChatMemory;
  harnessId?: string;
  /** Test seam; defaults to pi generateSummary via the active model. */
  summarizer?: SummarizerFn;
  signal?: AbortSignal;
}): Promise<{ tokensBefore: number; tokensAfter: number; summary: string }> {
  const { workspace, agentState, chat } = opts;
  if (!agentState.agentMessages.length) {
    throw new ManualCompactionError("当前会话没有可压缩的内容");
  }
  const settings = readLlmSettingsStore(workspace.root);
  const tier = settings.contextTier ?? "standard";
  if (tier === "eco") {
    throw new ManualCompactionError("当前为节省（eco）档位，不启用 LLM 摘要压缩；请在设置中切换上下文档位");
  }
  if (!hasRuntimeCredentials()) {
    throw new ManualCompactionError("需要先在设置中配置模型 API Key，才能压缩上下文");
  }
  const profile = getHarness(opts.harnessId);
  const runtime = resolveRuntimeModel(profile.model);
  const outcome = await orchestrateCompaction({
    messages: agentState.agentMessages,
    model: runtime.model as never,
    contextWindow: runtime.model.contextWindow,
    tier,
    force: true,
    summarizer: opts.summarizer,
    previousSummary: latestAgentCompactionSummary(workspace, agentState.sessionId),
    domainSnapshot: agentState.bag.documentId
      ? buildDomainSnapshot(workspace, agentState.bag.documentId) || undefined
      : undefined,
    signal: opts.signal,
  });
  if (outcome.kind !== "compacted") {
    const detail = outcome.kind === "failed" ? outcome.error : outcome.reason;
    throw new ManualCompactionError(`上下文压缩未执行：${detail}`);
  }
  settleCompactionEvent(workspace, agentState, chat, {
    eventId: outcome.eventId,
    reason: "manual",
    tokensBefore: outcome.tokensBefore,
    tokensAfter: outcome.tokensAfter,
    summary: outcome.summary,
    messagesBefore: agentState.agentMessages,
    messagesAfter: outcome.messages,
  });
  saveAgentSession(workspace, {
    sessionId: agentState.sessionId,
    documentId: agentState.bag.documentId,
    messages: agentState.agentMessages,
    clarificationRounds: agentState.clarificationRounds,
    documentModeLeanLock: agentState.documentModeLeanLock,
    chatTurns: chat.list(),
    sourcePaths: agentState.sourcePaths,
    evidenceCache: agentState.evidenceCache,
    task: taskForPersistence(agentState),
  });
  return {
    tokensBefore: outcome.tokensBefore,
    tokensAfter: outcome.tokensAfter,
    summary: outcome.summary,
  };
}

/** Detach the active document and all document-scoped Agent context. */
export function closeChatAgentDocument(state: ChatAgentState): void {
  state.sessionId = randomUUID();
  state.agentMessages = [];
  state.bag = { revision: 0, blocks: [] };
  state.clarificationRounds = 0;
  state.sourcePaths = [];
  state.evidenceCache = [];
  state.sourceDocumentId = undefined;
  state.task = undefined;
  state.restartTask = undefined;
  state.conversationResetPending = false;
  state.documentModeLeanLock = false;
}

export function isCloseDocumentRequest(message: string): boolean {
  return /^(?:请)?(?:退出|关闭|关掉|收起)(?:这个|当前|这篇)?\s*(?:word|docx|文档|文稿|文章)(?:吧|。|！|!)?$/i.test(
    message.trim(),
  );
}

export async function runChatAgentTurn(opts: {
  workspace: Workspace;
  chat: ChatMemory;
  agentState: ChatAgentState;
  message: string;
  selectionText?: string;
  selectionStart?: number;
  selectionBlockIds?: string[];
  cascadeBlockIds?: string[];
  /** Replace current attachments when present; [] explicitly detaches all. */
  sourcePaths?: string[];
  chatMode?: "direct" | "socratic";
  harnessId?: string;
  threadId?: string;
  onProgress?: (phase: string) => void;
  onDelta?: (chunk: string) => void;
  onDeltaReset?: (text: string) => void;
  signal?: AbortSignal;
  /** Remote MCP bridge + per-call approval (stream chat path only). */
  remoteMcp?: { bridge: RemoteMcpBridge; requestApproval: RemoteMcpApprovalFn };
  /** Live per-run audit array; settled approvals are appended by the host. */
  mcpApprovalAudit?: McpApprovalAuditEntry[];
  /** Explicit one-turn Skills (structured ids) for this chat turn. */
  selectedSkills?: string[];
}): Promise<ChatAgentTurnResult> {
  const { workspace, chat, agentState } = opts;
  if (opts.sourcePaths !== undefined) {
    replaceAttachedSources(agentState, workspace, opts.sourcePaths);
  }
  const requestedMessage = opts.message;
  const resumeRequested = isTaskResumeRequest(requestedMessage);
  const persistedInterruptedTask = agentState.task?.status === "interrupted"
    ? agentState.task
    : undefined;
  const pendingRestartTask = agentState.restartTask;
  const interruptedCandidate =
    resumeRequested
      ? persistedInterruptedTask ?? pendingRestartTask
      : undefined;
  const interruptedTask =
    interruptedCandidate && isTaskResumableForDocument(interruptedCandidate, agentState.bag)
      ? interruptedCandidate
      : undefined;
  const staleInterruptedTask = interruptedCandidate && !interruptedTask
    ? interruptedCandidate
    : undefined;
  const restartInterruptedTask = Boolean(
    staleInterruptedTask?.documentId &&
    staleInterruptedTask.documentId === agentState.bag.documentId &&
    staleInterruptedTask.documentRevision !== agentState.bag.revision,
  );
  const revisionResetRequired = Boolean(
    pendingRestartTask ||
    (persistedInterruptedTask &&
      !isTaskResumableForDocument(persistedInterruptedTask, agentState.bag)),
  );
  if (revisionResetRequired) {
    archiveAgentSession(workspace, agentState.sessionId);
    clearChatAgentConversation(agentState);
    chat.clear();
    agentState.conversationResetPending = true;
  }
  const message = interruptedTask
    ? `继续此前任务：${interruptedTask.objective}`
    : restartInterruptedTask
      ? `文稿已更新。请从当前版本重新执行此前任务，不要复用旧选区或读取位置：${staleInterruptedTask!.objective}`
      : staleInterruptedTask
        ? "此前中断任务无法安全绑定到当前文稿。请告知用户需要针对当前文稿重新说明具体任务，不要执行旧任务。"
        : requestedMessage;
  const objective = interruptedTask
    ? interruptedTask.objective
    : restartInterruptedTask
      ? staleInterruptedTask!.objective
      : requestedMessage.trim();
  const selectionBlockIds = interruptedTask
    ? interruptedTask.selection?.blockIds
    : staleInterruptedTask
      ? undefined
      : opts.selectionBlockIds?.length
      ? opts.selectionBlockIds
      : undefined;
  const selectionText = interruptedTask
    ? interruptedTask.selection?.text
    : staleInterruptedTask
      ? undefined
      : opts.selectionText?.trim()
      ? opts.selectionText
      : undefined;
  const selectionStart = interruptedTask
    ? interruptedTask.selection?.start
    : staleInterruptedTask
      ? undefined
      : Number.isInteger(opts.selectionStart) && Number(opts.selectionStart) >= 0
      ? opts.selectionStart
      : undefined;
  agentState.task = {
    objective,
    status: "running",
    ...taskDocumentBinding(agentState.bag),
    currentStep: "正在处理…",
    sourcePaths: [...agentState.sourcePaths],
    sourceRefs: [],
    proposalCount: 0,
    inspectedDocument: false,
    consistencyChecked: false,
    selection: selectionBlockIds?.length
      ? { blockIds: [...selectionBlockIds], text: selectionText, start: selectionStart }
      : undefined,
    updatedAt: new Date().toISOString(),
  };
  saveAgentSession(workspace, {
    sessionId: agentState.sessionId,
    documentId: agentState.bag.documentId,
    messages: agentState.agentMessages,
    clarificationRounds: agentState.clarificationRounds,
    documentModeLeanLock: agentState.documentModeLeanLock,
    chatTurns: chat.list(),
    sourcePaths: agentState.sourcePaths,
    evidenceCache: agentState.evidenceCache,
    task: taskForPersistence(agentState),
  });
  const clarificationRound = agentState.clarificationRounds ?? 0;
  const proposalHint = agentState.bag.documentId
    ? buildProposalHint(workspace, agentState.bag.documentId)
    : "";
  const localDocxPath = parseExplicitLocalDocxPath(message);
  const verifyDocumentOpen =
    !agentState.bag.documentId && isDocumentOpenStatusMessage(message);
  const turnBag = {
    ...agentState.bag,
    blocks: [...agentState.bag.blocks],
  };
  let turnEvidenceCache = [...agentState.evidenceCache];
  const syncFailedTurnRevision = () => {
    const documentId = agentState.bag.documentId;
    if (!documentId || turnBag.documentId !== documentId) return false;
    try {
      const current = getDocument(workspace, documentId);
      if (current.revision === agentState.bag.revision) return false;
      syncBagFromDocument(agentState, current, listBlocks(workspace, documentId));
      agentState.conversationResetPending = true;
      return true;
    } catch {
      return false;
    }
  };

  const llmSettings = readLlmSettingsStore(workspace.root);
  const compactionEvents: CompactionEvent[] = [];
  let turn: SessionTurnResult;
  try {
    turn = localDocxPath
      ? await (async () => {
        const phase = "正在导入 Word 文稿…";
        opts.onProgress?.(phase);
        const { document, report } = await importExternalDocxDocument(
          workspace,
          localDocxPath,
        );
        const blocks = listBlocks(workspace, document.id);
        const originalName = path.basename(localDocxPath);
        const warning = report.ok ? "" : ` 转换提示：${report.flags.join("、")}。`;
        return {
          engine: "offline" as const,
          reply: `已导入并打开《${originalName}》（${blocks.length} 段）。工作副本：${document.relativePath}。原 DOCX 未修改；后续正文改动仍走提案审阅。${warning}`,
          messages: agentState.agentMessages,
          proposals: [],
          comments: [],
          steps: [phase],
          opened: { document, blocks },
          notes: ["Host imported an explicitly supplied local DOCX path."],
        };
        })()
      : await runSessionTurn({
        reasoningMode: llmSettings.reasoningMode,
        timeoutMs: llmSettings.agentTimeoutMs,
        retryAttempts: llmSettings.retryAttempts,
        retryDelayMs: llmSettings.retryDelayMs,
        contextTier: llmSettings.contextTier,
        selectionContextChars: llmSettings.selectionContextChars,
        reasoningOptIn: activeProfile(llmSettings).reasoningOptIn,
        compactionAuto: llmSettings.compactionAuto !== false,
        previousSummary: latestAgentCompactionSummary(workspace, agentState.sessionId),
        domainSnapshot: agentState.bag.documentId
          ? buildDomainSnapshot(workspace, agentState.bag.documentId) || undefined
          : undefined,
        onCompaction: (event) => {
          compactionEvents.push(event);
        },
        message,
        workspaceWriteApprovalMessage: requestedMessage,
        proposalHint: proposalHint || undefined,
        messages: agentState.agentMessages,
        bag: turnBag,
        bridge: createWorkspaceBridge(workspace, turnBag),
        selectionHint: selectionText,
        selectionBlockIds,
        cascadeBlockIds: opts.cascadeBlockIds,
        sourcePaths: agentState.sourcePaths,
        evidenceCache: turnEvidenceCache,
        onEvidenceCacheChange: (entries) => {
          turnEvidenceCache = entries;
        },
        history: chat.prior(),
        sessionId: agentState.sessionId,
        remoteMcp: opts.remoteMcp,
        chatMode: opts.chatMode,
        harnessId: opts.harnessId,
        disabledSkills: disabledSkillNames(readSkillSettings(workspace.root)),
        selectedSkills: opts.selectedSkills,
        clarificationRound,
        signal: opts.signal,
        documentModeLeanLock: agentState.documentModeLeanLock,
        onProgress: (ev) => {
          if (agentState.task) {
            agentState.task.currentStep = ev.phase;
            agentState.task.updatedAt = new Date().toISOString();
          }
          opts.onProgress?.(ev.phase);
        },
        onDelta: verifyDocumentOpen ? undefined : opts.onDelta,
        onDeltaReset: verifyDocumentOpen ? undefined : opts.onDeltaReset,
      });
  } catch (error) {
    if (turnBag.documentId === agentState.bag.documentId) {
      agentState.evidenceCache = turnEvidenceCache;
    }
    if (agentState.task) {
      agentState.task.status = "interrupted";
      agentState.task.updatedAt = new Date().toISOString();
    }
    syncFailedTurnRevision();
    saveAgentSession(workspace, {
      sessionId: agentState.sessionId,
      documentId: agentState.bag.documentId,
      messages: agentState.agentMessages,
      clarificationRounds: agentState.clarificationRounds,
      documentModeLeanLock: agentState.documentModeLeanLock,
      chatTurns: chat.list(),
      sourcePaths: agentState.sourcePaths,
      evidenceCache: agentState.evidenceCache,
      task: taskForPersistence(agentState),
    });
    if (error instanceof PiLoopFailure) {
      saveAgentTranscript(workspace, {
        turnId: randomUUID(),
        documentId: agentState.bag.documentId,
        role: "assistant",
        payload: buildTranscriptPayload({
          steps: [],
          reply: error.message,
          proposalCount: 0,
          clarificationRounds: agentState.clarificationRounds,
          sessionId: agentState.sessionId,
          engine: "pi",
          notes: error.notes,
          sourcePaths: agentState.sourcePaths,
          toolAudit: error.toolAudit,
          mcpApprovals: opts.mcpApprovalAudit,
        }),
      });
    }
    throw error;
  }

  agentState.evidenceCache = turnEvidenceCache;
  turn.reply = stripLiteralThinkingBlocks(turn.reply);

  if (
    verifyDocumentOpen &&
    !turn.opened &&
    !agentState.bag.documentId &&
    claimsDocumentOpened(turn.reply)
  ) {
    turn.reply =
      "Host 没有返回有效的文稿打开结果，所以文稿尚未打开。我不会把模型文字当作成功；只有分页画布实际出现才算打开。请发送一个带引号的绝对 DOCX 路径。";
    turn.messages = agentState.agentMessages;
    turn.notes = [
      ...(turn.notes ?? []),
      "Host blocked an unverified document-open claim.",
    ];
  }

  agentState.agentMessages = turn.messages;
  if (turn.documentModeLeanLock) {
    agentState.documentModeLeanLock = true;
  }
  for (const event of compactionEvents) {
    settleCompactionEvent(workspace, agentState, chat, event);
  }
  let switchedDocument = Boolean(turn.documentSwitchOccurred);
  if (turn.opened) {
    const finalDocumentSwitched = syncBagFromDocument(
      agentState,
      turn.opened.document,
      turn.opened.blocks,
    );
    switchedDocument = finalDocumentSwitched || switchedDocument;
    if (turn.documentSwitchOccurred && !finalDocumentSwitched) {
      clearChatAgentConversation(agentState);
      agentState.sourcePaths = [];
    }
    if (switchedDocument) chat.clear();
  }

  const runId = randomUUID();
  const proposals: Proposal[] = [];
  if (agentState.bag.documentId && turn.proposals.length) {
    for (const draft of turn.proposals) {
      if (
        draft.documentId !== agentState.bag.documentId ||
        draft.baseRevision !== agentState.bag.revision
      ) continue;
      const targetBlock = agentState.bag.blocks.find((block) => block.id === draft.blockId);
      if (!targetBlock || targetBlock.contentHash !== draft.baseHash) continue;
      const proposal = {
        ...draft,
        id: randomUUID(),
        status: "proposed" as const,
        createdAt: new Date().toISOString(),
      };
      proposals.push(proposal);
    }
  }
  const activeComments = agentState.bag.documentId
    ? turn.comments.filter((comment) =>
        !comment.documentId || comment.documentId === agentState.bag.documentId,
      )
    : [];
  const reviewChecklists = agentState.bag.documentId
    ? (turn.reviewChecklists ?? []).filter(
        (checklist) => checklist.run.documentId === agentState.bag.documentId,
      )
    : [];
  if (agentState.bag.documentId && turn.tableCellProposals?.length) {
    for (const draft of turn.tableCellProposals) {
      if (
        draft.documentId !== agentState.bag.documentId ||
        draft.baseRevision !== agentState.bag.revision
      ) continue;
      const targetBlock = agentState.bag.blocks.find((block) => block.id === draft.blockId);
      if (!targetBlock || targetBlock.contentHash !== draft.baseHash) continue;
      const proposal = {
        schemaVersion: 1 as const,
        id: randomUUID(),
        documentId: draft.documentId,
        blockId: draft.blockId,
        baseRevision: draft.baseRevision,
        baseHash: draft.baseHash,
        before: draft.cell.before,
        after: draft.cell.after,
        rationale: draft.rationale,
        risk: draft.risk,
        evidence: draft.evidence,
        tableCell: draft.cell,
        status: "proposed" as const,
        createdAt: new Date().toISOString(),
      };
      proposals.push(proposal);
    }
  }
  const proposalIds = proposals.map((proposal) => proposal.id);
  const comments = activeComments.map((comment) => ({
    id: comment.id,
    blockId: comment.blockId,
    text: comment.text,
    severity: comment.severity,
    runId,
    source: comment.source,
  }));
  if (
    agentState.bag.documentId &&
    (proposals.length || comments.length || reviewChecklists.length)
  ) {
    const documentId = agentState.bag.documentId;
    const expectedRevision = agentState.bag.revision;
    try {
      await enqueueDocumentMutation(workspace, documentId, () => {
        const document = getDocument(workspace, documentId);
        saveScanArtifactsAtomically(workspace, documentId, {
          expectedRevision,
          expectedContentHash: document.contentHash,
          proposals,
          comments,
          reviewChecklists,
          replaceComments: comments.length > 0,
        });
      });
    } catch (error) {
      agentState.task = {
        objective,
        status: "interrupted",
        ...taskDocumentBinding(agentState.bag),
        currentStep: "审阅结果保存失败",
        sourcePaths: [...agentState.sourcePaths],
        sourceRefs: turn.workReport?.sourceRefs ?? [],
        proposalCount: 0,
        inspectedDocument: turn.workReport?.inspectedDocument ?? false,
        consistencyChecked: turn.workReport?.consistencyChecked ?? false,
        selection: !switchedDocument && selectionBlockIds?.length
          ? { blockIds: [...selectionBlockIds], text: selectionText, start: selectionStart }
          : undefined,
        updatedAt: new Date().toISOString(),
      };
      syncFailedTurnRevision();
      saveAgentSession(workspace, {
        sessionId: agentState.sessionId,
        documentId: agentState.bag.documentId,
        messages: agentState.agentMessages,
        clarificationRounds: agentState.clarificationRounds,
        documentModeLeanLock: agentState.documentModeLeanLock,
        chatTurns: chat.list(),
        sourcePaths: agentState.sourcePaths,
        evidenceCache: agentState.evidenceCache,
        task: taskForPersistence(agentState),
      });
      throw error;
    }
  }

  agentState.clarificationRounds = switchedDocument
    ? 0
    : nextClarificationRound({
      previous: clarificationRound,
      message,
      proposalCount: proposalIds.length,
      chatMode: opts.chatMode,
    });

  agentState.task = {
    objective,
    status: turn.continuationRequired && !switchedDocument ? "interrupted" : "completed",
    ...taskDocumentBinding(agentState.bag),
    sourcePaths: [...agentState.sourcePaths],
    sourceRefs: turn.workReport?.sourceRefs ?? [],
    proposalCount: proposalIds.length,
    inspectedDocument: turn.workReport?.inspectedDocument ?? false,
    consistencyChecked: turn.workReport?.consistencyChecked ?? false,
    selection: !switchedDocument && selectionBlockIds?.length
      ? { blockIds: [...selectionBlockIds], text: selectionText, start: selectionStart }
      : undefined,
    updatedAt: new Date().toISOString(),
  };

  const conversationReset = switchedDocument || revisionResetRequired ||
    agentState.conversationResetPending;
  const retainedThreadId = conversationReset ? undefined : opts.threadId;
  chat.remember("user", requestedMessage, retainedThreadId);
  chat.remember("assistant", turn.reply, retainedThreadId);
  saveAgentSession(workspace, {
    sessionId: agentState.sessionId,
    documentId: agentState.bag.documentId,
    messages: agentState.agentMessages,
    clarificationRounds: agentState.clarificationRounds,
    documentModeLeanLock: agentState.documentModeLeanLock,
    chatTurns: chat.list(),
    sourcePaths: agentState.sourcePaths,
    evidenceCache: agentState.evidenceCache,
    task: taskForPersistence(agentState),
  });
  const turnId = randomUUID();
  saveAgentTranscript(workspace, {
    id: randomUUID(),
    turnId,
    documentId: agentState.bag.documentId,
    role: "assistant",
    payload: buildTranscriptPayload({
      steps: turn.steps,
      reply: turn.reply,
      proposalCount: proposalIds.length,
      clarificationRounds: agentState.clarificationRounds,
      sessionId: agentState.sessionId,
      engine: turn.engine,
      notes: turn.notes,
      loadedSkills: turn.loadedSkills,
      sourcePaths: agentState.sourcePaths,
      toolAudit: turn.toolAudit,
      mcpApprovals: opts.mcpApprovalAudit,
    }),
    createdAt: new Date().toISOString(),
  });

  agentState.conversationResetPending = false;

  return {
    reply: turn.reply,
    conversationReset: conversationReset || undefined,
    opened: turn.opened,
    engine: turn.engine,
    steps: turn.steps,
    proposalCount: proposalIds.length,
    clarificationRounds: agentState.clarificationRounds,
    sourcePaths: [...agentState.sourcePaths],
    cascadeOffer: turn.cascadeOffer,
    notes: turn.notes,
    loadedSkills: turn.loadedSkills,
    task: agentState.task,
  };
}

export type { AgentMessage };
