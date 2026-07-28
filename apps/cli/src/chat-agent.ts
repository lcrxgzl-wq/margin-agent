import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  PiLoopFailure,
  runSessionTurn,
  nextClarificationRound,
  type AgentMessage,
  type SessionDocBag,
  type SessionTurnResult,
  type WorkspaceBridge,
  type ToolAuditEvent,
  type RemoteMcpApprovalFn,
  type RemoteMcpBridge,
} from "@margin/agent";
import type { BlockSnapshot, DocumentMeta } from "@margin/domain";
import {
  activeProfile,
  assertNotRegisteredDocumentWrite,
  getDocument,
  importExternalDocxDocument,
  listBlocks,
  listWorkspaceSourceFiles,
  listRegisteredDocumentPaths,
  loadAgentSession,
  openDocument,
  readWorkspaceSource,
  readLlmSettingsStore,
  readSkillSettings,
  disabledSkillNames,
  readNativeDocxTableCell,
  replaceDocumentComments,
  saveAgentSession,
  saveProposal,
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

const MAX_SOURCE_PATHS = 50;

export type ChatAgentState = {
  sessionId: string;
  agentMessages: AgentMessage[];
  bag: SessionDocBag;
  /** Clarification turns already used in the current rewrite/edit thread (0..3). */
  clarificationRounds: number;
  sourcePaths: string[];
  /** Main document that owns sourcePaths; used to clear attachments on document switch. */
  sourceDocumentId?: string;
  task?: PersistedAgentTask;
};

export function createChatAgentState(seed?: {
  sessionId?: string;
  agentMessages?: AgentMessage[];
  clarificationRounds?: number;
  sourcePaths?: string[];
  sourceDocumentId?: string;
  task?: PersistedAgentTask;
}): ChatAgentState {
  return {
    sessionId: seed?.sessionId ?? randomUUID(),
    agentMessages: seed?.agentMessages ?? [],
    bag: { revision: 0, blocks: [] },
    clarificationRounds: seed?.clarificationRounds ?? 0,
    sourcePaths: seed?.sourcePaths ?? [],
    sourceDocumentId: seed?.sourceDocumentId,
    task: seed?.task,
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
    sourceDocumentId: saved.documentId,
    task: saved.task,
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
      state.sourceDocumentId = undefined;
    }
  }
  return state;
}

/** Restore Pi AgentMessage[] from the last persisted session, if any. */
export function restoreChatAgentState(workspace: Workspace): ChatAgentState {
  return chatAgentStateFromSession(workspace, loadAgentSession(workspace));
}


/** Short chat turns for UI hydrate (may be empty on legacy sessions). */
export function loadPersistedChatTurns(workspace: Workspace): Array<{
  role: "user" | "assistant";
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
  const currentDocumentId = state.bag.documentId ?? state.sourceDocumentId;
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
    return;
  }
  const available = new Map(
    listWorkspaceSourceFiles(workspace).map((relativePath) => [
      relativePath.toLocaleLowerCase(),
      relativePath,
    ]),
  );
  const sourcePaths: string[] = [];
  for (const requested of normalizedRequested) {
    const normalized = requested
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    if (!normalized) continue;
    const relativePath = available.get(normalized.toLocaleLowerCase());
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
  state.sourceDocumentId = state.bag.documentId;
}

export function createWorkspaceBridge(workspace: Workspace): WorkspaceBridge {
  return {
    skillsRoot: path.join(workspace.root, ".margin", "skills"),
    listSourceFiles: () => listWorkspaceSourceFiles(workspace),
    readText: (relativePath) =>
      readWorkspaceSource(workspace, relativePath, {
        unlimitedRead: process.env.MARGIN_UNLIMITED === "1",
      }),
    writeText: (relativePath, content) => {
      assertNotRegisteredDocumentWrite(workspace, relativePath);
      return writeWorkspaceText(workspace, relativePath, content);
    },
    openDocument: (relativePath) => {
      const document = openDocument(workspace, relativePath.replace(/\\/g, "/"));
      const blocks = listBlocks(workspace, document.id);
      return { document, blocks };
    },
    listProtectedDocumentPaths: () => listRegisteredDocumentPaths(workspace),
    readTableCell: (documentId, blockId, row, column) =>
      readNativeDocxTableCell(workspace, documentId, blockId, row, column),
  };
}

export type ChatAgentTurnResult = {
  reply: string;
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
  state.task = undefined;
}

/** Detach the active document and all document-scoped Agent context. */
export function closeChatAgentDocument(state: ChatAgentState): void {
  state.sessionId = randomUUID();
  state.agentMessages = [];
  state.bag = { revision: 0, blocks: [] };
  state.clarificationRounds = 0;
  state.sourcePaths = [];
  state.sourceDocumentId = undefined;
  state.task = undefined;
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
  const resumeRequested = /^(?:继续|接着做|恢复任务|continue)(?:。|！|!)?$/i.test(
    requestedMessage.trim(),
  );
  const interruptedTask = resumeRequested && agentState.task?.status === "interrupted"
    ? agentState.task
    : undefined;
  const message = interruptedTask
    ? `继续此前任务：${interruptedTask.objective}`
    : requestedMessage;
  const objective = interruptedTask
    ? interruptedTask.objective
    : requestedMessage.trim();
  const selectionBlockIds = opts.selectionBlockIds?.length
    ? opts.selectionBlockIds
    : interruptedTask?.selection?.blockIds;
  const selectionText = opts.selectionText?.trim()
    ? opts.selectionText
    : interruptedTask?.selection?.text;
  const selectionStart = Number.isInteger(opts.selectionStart) && Number(opts.selectionStart) >= 0
    ? opts.selectionStart
    : interruptedTask?.selection?.start;
  agentState.task = {
    objective,
    status: "running",
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
    chatTurns: chat.list(),
    sourcePaths: agentState.sourcePaths,
    task: agentState.task,
  });
  const clarificationRound = agentState.clarificationRounds ?? 0;
  const localDocxPath = parseExplicitLocalDocxPath(message);
  const verifyDocumentOpen =
    !agentState.bag.documentId && isDocumentOpenStatusMessage(message);

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
        reasoningMode: readLlmSettingsStore(workspace.root).reasoningMode,
        reasoningOptIn: activeProfile(readLlmSettingsStore(workspace.root)).reasoningOptIn,
        message,
        workspaceWriteApprovalMessage: requestedMessage,
        messages: agentState.agentMessages,
        bag: agentState.bag,
        bridge: createWorkspaceBridge(workspace),
        selectionHint: selectionText,
        selectionBlockIds,
        cascadeBlockIds: opts.cascadeBlockIds,
        sourcePaths: agentState.sourcePaths,
        history: chat.prior(),
        sessionId: agentState.sessionId,
        remoteMcp: opts.remoteMcp,
        chatMode: opts.chatMode,
        harnessId: opts.harnessId,
        disabledSkills: disabledSkillNames(readSkillSettings(workspace.root)),
        selectedSkills: opts.selectedSkills,
        clarificationRound,
        signal: opts.signal,
        onProgress: (ev) => {
          if (agentState.task) {
            agentState.task.currentStep = ev.phase;
            agentState.task.updatedAt = new Date().toISOString();
          }
          opts.onProgress?.(ev.phase);
        },
        onDelta: verifyDocumentOpen ? undefined : opts.onDelta,
      });
  } catch (error) {
    if (agentState.task) {
      agentState.task.status = "interrupted";
      agentState.task.updatedAt = new Date().toISOString();
    }
    saveAgentSession(workspace, {
      sessionId: agentState.sessionId,
      documentId: agentState.bag.documentId,
      messages: agentState.agentMessages,
      clarificationRounds: agentState.clarificationRounds,
      chatTurns: chat.list(),
      sourcePaths: agentState.sourcePaths,
      task: agentState.task,
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
  if (turn.opened) {
    const switched = syncBagFromDocument(
      agentState,
      turn.opened.document,
      turn.opened.blocks,
    );
    if (switched) chat.clear();
  }

  const runId = randomUUID();
  const proposalIds: string[] = [];
  if (agentState.bag.documentId && turn.proposals.length) {
    for (const draft of turn.proposals) {
      const targetBlock = agentState.bag.blocks.find((block) => block.id === draft.blockId);
      if (!targetBlock || targetBlock.contentHash !== draft.baseHash) continue;
      const proposal = {
        ...draft,
        id: randomUUID(),
        status: "proposed" as const,
        createdAt: new Date().toISOString(),
      };
      saveProposal(workspace, proposal);
      proposalIds.push(proposal.id);
    }
    if (turn.comments.length) {
      replaceDocumentComments(
        workspace,
        agentState.bag.documentId,
        turn.comments.map((c) => ({
          id: c.id,
          blockId: c.blockId,
          text: c.text,
          severity: c.severity,
          runId,
          source: c.source,
        })),
      );
    }
  }
  if (agentState.bag.documentId && turn.tableCellProposals?.length) {
    for (const draft of turn.tableCellProposals) {
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
      saveProposal(workspace, proposal);
      proposalIds.push(proposal.id);
    }
  }

  agentState.clarificationRounds = nextClarificationRound({
    previous: clarificationRound,
    message,
    proposalCount: proposalIds.length,
    chatMode: opts.chatMode,
  });

  agentState.task = {
    objective,
    status: "completed",
    sourcePaths: [...agentState.sourcePaths],
    sourceRefs: turn.workReport?.sourceRefs ?? [],
    proposalCount: proposalIds.length,
    inspectedDocument: turn.workReport?.inspectedDocument ?? false,
    consistencyChecked: turn.workReport?.consistencyChecked ?? false,
    selection: selectionBlockIds?.length
      ? { blockIds: [...selectionBlockIds], text: selectionText, start: selectionStart }
      : undefined,
    updatedAt: new Date().toISOString(),
  };

  chat.remember("user", requestedMessage, opts.threadId);
  chat.remember("assistant", turn.reply, opts.threadId);
  saveAgentSession(workspace, {
    sessionId: agentState.sessionId,
    documentId: agentState.bag.documentId,
    messages: turn.messages,
    clarificationRounds: agentState.clarificationRounds,
    chatTurns: chat.list(),
    sourcePaths: agentState.sourcePaths,
    task: agentState.task,
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

  return {
    reply: turn.reply,
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
