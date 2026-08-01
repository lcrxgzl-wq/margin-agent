#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import open from "open";
import {
  openWorkspace,
  openDocumentFile,
  getDocument,
  listBlocks,
  listProposals,
  listWorkspaceSourceFiles,
  readWorkspaceText,
  readWorkspaceSource,
  readWorkspaceSourceVersion,
  writeWorkspaceText,
  supersedeOpenProposals,
  saveProposal,
  saveDecision,
  rejectProposal,
  reopenProposal,
  getLatestDecision,
  getLatestProposalApplyEvent,
  recoverDecidedProposals,
  applyApproved,
  exportPacket,
  getProposal,
  importDocxDocument,
  readNativeDocx,
  readNativeDocxTableCell,
  saveNativeDocx,
  reconcileRegisteredDocxDocuments,
  exportDocumentDocx,
  replaceDocumentComments,
  listComments,
  listActiveReviewChecklists,
  saveReviewChecklistRun,
  decideReviewChecklistItems,
  ReviewChecklistConflictError,
  ReviewChecklistNotFoundError,
  ReviewChecklistValidationError,
  listAgentTranscripts,
  loadAndApplyLlmSettings,
  readLlmSettingsStore,
  readSkillSettings,
  disabledSkillNames,
  setSkillMode,
  recordModelUsage,
  activeProfile,
  saveLlmSettings,
  publicLlmSettings,
  assertNotRegisteredDocumentWrite,
  saveAgentSession,
  archiveAgentSession,
  deleteAgentSession,
  listAgentSessions,
  loadAgentSessionEnvelope,
  listDocumentTimeline,
  type PersistedReviewThread,
  type Workspace,
} from "@margin/storage-local";
import {
  CONTEXT_TIER_PRESETS,
  isUserFacingPhase,
  PiLoopFailure,
  createReviewChecklistRuns,
  runBlockScan,
  resolveEngine,
  type ToolAuditEvent,
  type RemoteMcpApprovalRequest,
  type RemoteMcpBridge,
} from "@margin/agent";
import {
  contentHash,
  MAX_SELECTION_BLOCKS,
  type ProposalOperationKind,
  type ProposalTargetLanguage,
  type SelectionBlockRange,
} from "@margin/domain";
import {
  getHarness,
  importWorkspaceSkill,
  listHarnesses,
  listSkillStates,
  removeWorkspaceSkill,
} from "@margin/harness";
import {
  configureRequestPolicy,
  discoverLlmModels,
  testLlmModelConnection,
  translateSelection,
  type LlmProviderProbeInput,
} from "@margin/llm";
import {
  appendConversationNote,
  chatAgentStateFromSession,
  clearChatAgentConversation,
  closeChatAgentDocument,
  compactChatAgentConversation,
  ManualCompactionError,
  isCloseDocumentRequest,
  loadPersistedChatTurns,
  loadPersistedReviewThreads,
  restoreChatAgentState,
  replaceAttachedSources,
  rotateChatSessionWithSummary,
  runChatAgentTurn,
  syncBagFromDocument,
  type ChatAgentState,
} from "./chat-agent.js";
import { applyConversationNote, decisionConversationNote } from "./conversation-notes.js";
import { buildLlmSettingsUpdate } from "./llm-settings-patch.js";
import { ChatMemory } from "./chat-memory.js";
import {
  resolveLlmConnectionInput,
  type LlmConnectionBody,
} from "./llm-connection.js";
import {
  ccSwitchPublicInfo,
  connectCcSwitchRoute,
  type CcSwitchRouteId,
} from "./cc-switch-connect.js";
import { setBoundedMap } from "./run-state.js";
import {
  assertSelectionBlockCount,
  resolveSelectionContextLimit,
  validateProposalSelectionRanges,
} from "./proposal-selection.js";
import { abortOnClientDisconnect } from "./stream-lifecycle.js";
import {
  callEnabledRemoteMcpTool,
  discoverWorkspaceRemoteMcp,
  listEnabledRemoteMcpTools,
  publicRemoteMcpServers,
  REMOTE_MCP_MAX_RESULT_CHARS,
  removeRemoteMcpServer,
  saveRemoteMcpServer,
} from "./mcp-remote.js";
import {
  createMcpApprovalRegistry,
  type McpApprovalAuditEntry,
} from "./mcp-approvals.js";
import { MARGIN_VERSION } from "./version.js";
import { chatSelectionError } from "./chat-selection.js";
import {
  isActiveDocumentRequest,
  parseResolveProposalsInput,
  resolveProposalsAtomically,
} from "./proposal-batch.js";
import { buildQuickEditSourceContext } from "./quick-edit-sources.js";

function llmMode(): "mock" | "byok" {
  if (
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.MARGIN_API_KEY ||
    process.env.MARGIN_BASE_URL
  ) {
    return "byok";
  }
  return "mock";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** One-use per-call remote MCP approvals (60s expiry; denied on cancel/disconnect/supersede). */
const mcpApprovalRegistry = createMcpApprovalRegistry();

/** Remote MCP bridge for the agent tool layer: lists enabled read-only tools from the local store. */
function createRemoteMcpBridge(workspaceRoot: string): RemoteMcpBridge {
  return {
    listCallableTools: () =>
      listEnabledRemoteMcpTools(workspaceRoot).map((tool) => ({
        serverId: tool.serverId,
        serverName: tool.serverName,
        tool: tool.name,
        description: tool.description,
        schema: tool.inputSchema,
      })),
    callTool: async (serverId, tool, args) => {
      try {
        // callEnabledRemoteMcpTool re-lists remote tools and re-checks
        // readOnly/destructive annotations immediately before the call.
        const content = await callEnabledRemoteMcpTool(workspaceRoot, {
          serverId,
          name: tool,
          arguments: args,
        });
        return {
          content,
          truncated: content.length >= REMOTE_MCP_MAX_RESULT_CHARS,
        };
      } catch (error) {
        return {
          content: "",
          truncated: false,
          remoteError: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

type RunState = {
  status: string;
  error?: string;
  proposalIds?: string[];
  commentCount?: number;
  engine?: string;
  preferredEngine?: string;
  notes?: string[];
  citeDisclaimer?: string;
  phase?: string;
  steps?: string[];
  toolAudit?: ToolAuditEvent[];
};

type AppState = {
  token: string;
  workspace: Workspace;
  port: number;
  runs: Map<string, RunState>;
  latestScanRunByDocument: Map<string, string>;
  scanAbortControllers: Map<string, AbortController>;
  chat: ChatMemory;
  agent: ChatAgentState;
  reviewThreads: PersistedReviewThread[];
};

/** Test seam: populated once the server is listening (index-race.test.ts). */
export const runtime: {
  app?: ReturnType<typeof Fastify>;
  state?: AppState;
  enqueueChat?: <T>(fn: () => Promise<T>) => Promise<T>;
} = {};

function requireAuth(state: AppState, header?: string) {
  if (!header || header !== `Bearer ${state.token}`) {
    const err = new Error("unauthorized");
    (err as Error & { statusCode: number }).statusCode = 401;
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => {
    if (arg === "--unlimited") {
      process.env.MARGIN_UNLIMITED = "1";
      return false;
    }
    return true;
  });
  const workspacePath = path.resolve(args[0] ?? process.cwd());
  const port = Number(process.env.MARGIN_PORT ?? 8787);
  const token = randomUUID().replace(/-/g, "");
  const workspace = await openWorkspace(workspacePath);
  configureRequestPolicy({
    version: MARGIN_VERSION,
    onUsage: (entry) => recordModelUsage(workspace, entry),
  });
  await recoverDecidedProposals(workspace);
  await reconcileRegisteredDocxDocuments(workspace);
  loadAndApplyLlmSettings(workspacePath);
  const configuredProfileId = readLlmSettingsStore(workspacePath).harnessId;
  if (configuredProfileId) getHarness(configuredProfileId.trim());

  const llmPublic = () =>
    publicLlmSettings(
      readLlmSettingsStore(workspacePath),
      ccSwitchPublicInfo(),
    );
  const resolveHarnessId = (requested?: string | null) => {
    const configured = readLlmSettingsStore(workspacePath).harnessId;
    const requestedId = typeof requested === "string" ? requested.trim() : "";
    return getHarness(requestedId || configured?.trim() || undefined).id;
  };
  const currentSelectionContextLimit = () => {
    const settings = readLlmSettingsStore(workspacePath);
    return resolveSelectionContextLimit(
      settings.selectionContextChars,
      CONTEXT_TIER_PRESETS[settings.contextTier ?? "standard"].selectionChars,
    );
  };

  /** Structured per-turn Skill ids: unknown / blocked / disabled all fail visibly. */
  const resolveSelectedSkills = (raw: unknown):
    | { ok: true; skills: string[] }
    | { ok: false; error: string } => {
    if (raw === undefined) return { ok: true, skills: [] };
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      return { ok: false, error: "selectedSkills 必须是字符串数组" };
    }
    const names = [...new Set(raw.map((item) => item.trim().toLowerCase()).filter(Boolean))];
    if (names.length > 8) return { ok: false, error: "每轮最多显式选用 8 个 Skill" };
    const store = readSkillSettings(workspacePath);
    const scope = getHarness(resolveHarnessId()).skills.scope;
    const states = new Map(
      listSkillStates(path.join(workspacePath, ".margin", "skills"), scope, disabledSkillNames(store))
        .map((skill) => [skill.name, skill.state] as const),
    );
    for (const name of names) {
      const state = states.get(name);
      if (!state) return { ok: false, error: `未知 Skill: ${name}` };
      if (state === "blocked_by_profile") {
        return { ok: false, error: `当前 Agent 模式无法使用 Skill: ${name}` };
      }
      if (state === "disabled") return { ok: false, error: `Skill 已关闭: ${name}` };
    }
    return { ok: true, skills: names };
  };

  const resolveConnectionDraft = (body: LlmConnectionBody = {}) =>
    resolveLlmConnectionInput(readLlmSettingsStore(workspacePath), body, {
      openai: process.env.OPENAI_API_KEY ?? process.env.MARGIN_API_KEY,
      anthropic:
        process.env.ANTHROPIC_AUTH_TOKEN ??
        process.env.ANTHROPIC_API_KEY ??
        process.env.MARGIN_API_KEY,
    });

  /** Serialize chat turns so concurrent requests don't corrupt bag/memory. */
  let chatTail: Promise<unknown> = Promise.resolve();
  const enqueueChat = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chatTail.then(fn, fn);
    chatTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const agent = restoreChatAgentState(workspace);
  const state: AppState = {
    token,
    workspace,
    port,
    runs: new Map(),
    latestScanRunByDocument: new Map(),
    scanAbortControllers: new Map(),
    chat: new ChatMemory(),
    agent,
    reviewThreads: loadPersistedReviewThreads(workspace).filter(
      (thread) => thread.documentId === agent.bag.documentId,
    ),
  };
  state.chat.hydrate(loadPersistedChatTurns(workspace));
  const persistSession = () =>
    saveAgentSession(workspace, {
      sessionId: state.agent.sessionId,
      documentId: state.agent.bag.documentId,
      messages: state.agent.agentMessages,
      clarificationRounds: state.agent.clarificationRounds,
      chatTurns: state.chat.list(),
      threads: state.reviewThreads,
      sourcePaths: state.agent.sourcePaths,
      evidenceCache: state.agent.evidenceCache,
      task: state.agent.task,
    });
  /** GET /api/v1/session payload — also returned by session new/switch so the web reuses one hydrate path. */
  const sessionPayload = () => {
    const harness = getHarness(resolveHarnessId());
    const opened = state.agent.bag.documentId
      ? {
          document: getDocument(workspace, state.agent.bag.documentId),
          blocks: listBlocks(workspace, state.agent.bag.documentId),
        }
      : undefined;
    return {
      token,
      workspace: workspacePath,
      port,
      llmMode: llmMode(),
      engine: resolveEngine(),
      llm: llmPublic(),
      harness: { id: harness.id, title: harness.title },
      clarificationRounds: state.agent.clarificationRounds ?? 0,
      sourcePaths: state.agent.sourcePaths,
      task: state.agent.task,
      opened,
      chat: {
        turns: state.chat.list(),
        maxTurns: 80,
      },
      review: {
        threads: state.reviewThreads.filter(
          (thread) => thread.documentId === state.agent.bag.documentId,
        ),
      },
    };
  };

  /** Snapshot the active conversation into history when it holds any content. */
  const archiveCurrentSession = () => {
    const hasContent =
      state.agent.agentMessages.length > 0 ||
      state.chat.list().length > 0 ||
      Boolean(state.agent.task);
    if (hasContent) archiveAgentSession(workspace, state.agent.sessionId);
  };

  const sourceExcerptCache = new Map<string, {
    versionHash: string;
    relativePath: string;
    text: string;
    contentHash: string;
  }>();
  const readSourceExcerpt = async (relativePath: string) => {
    const cacheKey = relativePath.replace(/\\/g, "/").toLocaleLowerCase();
    const version = readWorkspaceSourceVersion(workspace, relativePath);
    const cached = sourceExcerptCache.get(cacheKey);
    if (cached?.versionHash === version.versionHash) return cached;
    const source = await readWorkspaceSource(workspace, relativePath);
    const entry = {
      versionHash: source.versionHash,
      relativePath: source.relativePath.replace(/\\/g, "/"),
      text: source.text,
      contentHash: contentHash(source.text),
    };
    setBoundedMap(sourceExcerptCache, cacheKey, entry, 6);
    return entry;
  };

  const persistScan = async (
    runId: string,
    documentId: string,
    blockIds: string[],
    opts?: {
      harnessId?: string;
      instruction?: string;
      selectionText?: string;
      selectionStart?: number;
      selectionRanges?: SelectionBlockRange[];
      selectionContextChars?: number;
      operation?: ProposalOperationKind;
      targetLanguage?: ProposalTargetLanguage;
      tableCell?: { row: number; column: number; address: string; before: string };
      sourcePaths?: string[];
      preferSimple?: boolean;
      selectedSkills?: string[];
    },
    signal?: AbortSignal,
  ) => {
    const doc = getDocument(workspace, documentId);
    const blocks = listBlocks(workspace, documentId);
    const patch = (partial: Partial<RunState>) => {
      const cur = state.runs.get(runId) ?? { status: "running" };
      if (cur.status === "cancelled" && partial.status !== "cancelled") return;
      setBoundedMap(state.runs, runId, { ...cur, ...partial });
    };
    try {
      const sourceContext = await buildQuickEditSourceContext(
        opts?.sourcePaths ?? [],
        readSourceExcerpt,
      );
      const scanLlmStore = readLlmSettingsStore(workspacePath);
      const scan = await runBlockScan(
        {
          reasoningMode: scanLlmStore.reasoningMode,
          reasoningOptIn: activeProfile(scanLlmStore).reasoningOptIn,
          timeoutMs: scanLlmStore.agentTimeoutMs,
          documentId,
          revision: doc.revision,
          blocks,
          harnessId: resolveHarnessId(opts?.harnessId),
          instruction: opts?.instruction,
          selectionText: opts?.selectionText,
          selectionStart: opts?.selectionStart,
          selectionRanges: opts?.selectionRanges,
          selectionContextChars: opts?.selectionContextChars,
          operation: opts?.operation,
          targetLanguage: opts?.targetLanguage,
          tableCell: opts?.tableCell,
          sourceContext,
          skillsRoot: path.join(workspace.root, ".margin", "skills"),
          disabledSkills: disabledSkillNames(readSkillSettings(workspacePath)),
          selectedSkills: opts?.selectedSkills,
          signal,
          preferSimple: opts?.preferSimple ?? false,
        },
        blockIds,
        (ev) => {
          const cur = state.runs.get(runId);
          const steps = [...(cur?.steps ?? []), ev.phase].slice(-24);
          patch({ status: "running", phase: ev.phase, steps });
        },
      );
      if (state.runs.get(runId)?.status === "cancelled") return;
      if (state.latestScanRunByDocument.get(documentId) !== runId) {
        patch({ status: "superseded", phase: "已被较新的任务替代" });
        return;
      }
      if (!isActiveDocumentRequest(state.agent.bag.documentId, documentId)) {
        patch({ status: "superseded", phase: "文稿已切换，结果未写入" });
        return;
      }
      const proposalIds: string[] = [];
      for (const draft of scan.proposals) {
        if (state.runs.get(runId)?.status === "cancelled") return;
        const proposal = {
          ...draft,
          id: randomUUID(),
          status: "proposed" as const,
          createdAt: new Date().toISOString(),
        };
        const targetBlock = blocks.find((block) => block.id === draft.blockId);
        if (!targetBlock || targetBlock.contentHash !== draft.baseHash) {
          throw new Error("block hash mismatch");
        }
        saveProposal(workspace, proposal);
        proposalIds.push(proposal.id);
      }
      replaceDocumentComments(
        workspace,
        documentId,
        (scan.comments ?? []).map((c) => ({
          id: c.id,
          blockId: c.blockId,
          text: c.text,
          severity: c.severity,
          runId,
          source: c.source,
        })),
      );
      const checklistByChecker = new Map(
        (scan.reviewChecklists ?? []).map((checklist) => [checklist.run.checker, checklist]),
      );
      const scannedBlocks = blocks.filter((block) => blockIds.includes(block.id));
      for (const checklist of createReviewChecklistRuns(documentId, scannedBlocks)) {
        if (!checklistByChecker.has(checklist.run.checker)) {
          checklistByChecker.set(checklist.run.checker, checklist);
        }
      }
      for (const checklist of checklistByChecker.values()) {
        saveReviewChecklistRun(workspace, checklist);
      }
      patch({
        status: "done",
        proposalIds,
        commentCount: scan.comments?.length ?? 0,
        engine: scan.engine,
        preferredEngine: "pi",
        notes: scan.notes,
        phase: scan.steps?.at(-1) ?? "完成",
        steps: scan.steps,
        toolAudit: scan.toolAudit,
        citeDisclaimer:
          "形态学通过 ≠ 文献真实存在。此检查不验证文献真实性、存在性，也不验证引文是否支持正文主张。",
      });
    } catch (e) {
      if (state.runs.get(runId)?.status === "cancelled") return;
      if (state.latestScanRunByDocument.get(documentId) !== runId) {
        patch({ status: "superseded", phase: "已被较新的任务替代" });
        return;
      }
      patch({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        phase: "失败",
        ...(e instanceof PiLoopFailure
          ? { notes: e.notes, toolAudit: e.toolAudit }
          : {}),
      });
    }
  };

  const startScanRun = (
    documentId: string,
    blockIds: string[],
    opts?: {
      harnessId?: string;
      instruction?: string;
      selectionText?: string;
      selectionStart?: number;
      selectionRanges?: SelectionBlockRange[];
      selectionContextChars?: number;
      operation?: ProposalOperationKind;
      targetLanguage?: ProposalTargetLanguage;
      tableCell?: { row: number; column: number; address: string; before: string };
      sourcePaths?: string[];
      preferSimple?: boolean;
      selectedSkills?: string[];
    },
  ) => {
    // Selection rewrite keeps prior pending proposals on other blocks.
    if (!opts?.instruction && blockIds.length > 2) {
      supersedeOpenProposals(workspace, documentId);
    }
    const runId = randomUUID();
    const previousRunId = state.latestScanRunByDocument.get(documentId);
    if (previousRunId) {
      state.scanAbortControllers.get(previousRunId)?.abort();
      const previous = state.runs.get(previousRunId);
      if (previous?.status === "running") {
        setBoundedMap(state.runs, previousRunId, {
          ...previous,
          status: "superseded",
          phase: "已被较新的任务替代",
        });
      }
    }
    const controller = new AbortController();
    state.scanAbortControllers.set(runId, controller);
    state.latestScanRunByDocument.set(documentId, runId);
    setBoundedMap(state.runs, runId, {
      status: "running",
      phase: "排队中",
      steps: [],
    });
    void persistScan(runId, documentId, blockIds, opts, controller.signal).finally(() => {
      state.scanAbortControllers.delete(runId);
    });
    return runId;
  };

  const app = Fastify({ logger: false, forceCloseConnections: true });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const raw = typeof body === "string" ? body : "";
        done(null, raw.trim().length ? JSON.parse(raw) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
  app.addContentTypeParser(
    ["application/octet-stream", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    { parseAs: "buffer", bodyLimit: 50 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      try {
        const u = new URL(origin);
        const ok =
          (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
          (u.port === String(port) || u.port === "5173");
        cb(null, ok);
      } catch {
        cb(null, false);
      }
    },
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    if (!req.url.startsWith("/api/")) return;
    const host = req.headers.host ?? "";
    let hostname = "";
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      /* rejected below */
    }
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      return reply.code(403).send({ error: "invalid host" });
    }
  });

  app.get("/api/v1/capabilities", async () => ({
    mode: "local",
    version: MARGIN_VERSION,
    mvp: true,
    features: {
      workspace: true,
      agentFileTools: true,
      byok: true,
      simplePropose: true,
      piEngine: true,
      paperAgent: true,
      paperWorkspaceUi: true,
      docxImportExport: true,
      nativeDocxEditor: true,
      docxLossReport: true,
      agentComments: true,
      tipTap: true,
      legacyBatchUi: true,
      chatStream: true,
      scanProgress: true,
      chatMemory: true,
      sessionAgent: true,
      llmSettings: true,
      llmModelDiscovery: true,
    },
    llmMode: llmMode(),
    preferredEngine: "pi",
    engine: resolveEngine(),
    authHeader: "Authorization: Bearer <token>",
  }));

  app.get("/api/v1/session", async (req) => {
    requireAuth(state, req.headers.authorization);
    return sessionPayload();
  });

  app.get("/api/v1/settings/llm", async (req) => {
    requireAuth(state, req.headers.authorization);
    return llmPublic();
  });

  app.put<{
    Body: {
      clearApiKey?: boolean;
      /** Active provider patch, or legacy string "openai"|"anthropic". */
      provider?:
        | "openai"
        | "anthropic"
        | {
            id?: string;
            name?: string;
            apiFormat?: "openai" | "anthropic";
            model?: string;
            apiKey?: string;
            baseURL?: string;
            authStyle?: "bearer" | "apikey";
            reasoningOptIn?: boolean;
          };
      model?: string;
      apiKey?: string;
      baseURL?: string;
      authStyle?: "bearer" | "apikey";
      reasoningOptIn?: boolean;
      reasoningMode?: "auto" | "fast" | "standard" | "deep" | null;
      harnessId?: string | null;
      agentTimeoutMs?: number | null;
      contextTier?: "eco" | "standard" | "max" | null;
      selectionContextChars?: number | null;
      /** Automatic context compaction toggle; null clears back to default. */
      compactionAuto?: boolean | null;
    };
  }>("/api/v1/settings/llm", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const body = req.body ?? {};
    try {
      if (typeof body.harnessId === "string" && body.harnessId.trim()) {
        getHarness(body.harnessId.trim());
      }
      const current = activeProfile(readLlmSettingsStore(workspacePath));
      await saveLlmSettings(workspacePath, buildLlmSettingsUpdate(body, current.id));
      return llmPublic();
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Body: LlmConnectionBody }>("/api/v1/settings/llm/models", async (req) => {
    requireAuth(state, req.headers.authorization);
    const input: LlmProviderProbeInput = resolveConnectionDraft(req.body ?? {});
    const result = await discoverLlmModels(input);
    return {
      ...result,
      models: result.models.map((model) => model.id),
    };
  });

  app.post<{ Body: LlmConnectionBody }>("/api/v1/settings/llm/test", async (req) => {
    requireAuth(state, req.headers.authorization);
    const result = await testLlmModelConnection(resolveConnectionDraft(req.body ?? {}));
    return {
      ok: result.ok,
      latencyMs: result.latencyMs,
      detail: result.detail,
      resolvedBaseURL: result.resolvedBaseURL,
    };
  });

  app.get("/api/v1/settings/llm/cc-switch", async (req) => {
    requireAuth(state, req.headers.authorization);
    return ccSwitchPublicInfo();
  });

  app.post<{ Body: { route?: string } }>(
    "/api/v1/settings/llm/cc-switch/connect",
    async (req, reply) => {
      requireAuth(state, req.headers.authorization);
      const route = req.body?.route;
      if (route !== "claude" && route !== "codex") {
        return reply.code(400).send({ error: "route 必须是 claude 或 codex" });
      }
      try {
        await connectCcSwitchRoute(workspacePath, route as CcSwitchRouteId);
        return llmPublic();
      } catch (e) {
        return reply
          .code(502)
          .send({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  app.get("/api/v1/harnesses", async (req) => {
    requireAuth(state, req.headers.authorization);
    return {
      harnesses: listHarnesses().map((h) => ({
        id: h.id,
        title: h.title,
        capabilities: h.capabilities,
        skills: h.skills,
        limits: h.limits,
        approvals: h.approvals,
      })),
      defaultId: getHarness().id,
    };
  });

  app.get("/api/v1/workspace/files", async (req) => {
    requireAuth(state, req.headers.authorization);
    return { files: listWorkspaceSourceFiles(workspace) };
  });

  app.post<{ Body: { relativePath: string } }>("/api/v1/workspace/read", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const relativePath = req.body?.relativePath?.trim();
    if (!relativePath) return reply.code(400).send({ error: "relativePath required" });
    try {
      return readWorkspaceText(workspace, relativePath);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Body: { relativePath: string; content: string } }>(
    "/api/v1/workspace/write",
    async (req, reply) => {
      requireAuth(state, req.headers.authorization);
      const relativePath = req.body?.relativePath?.trim();
      if (!relativePath) return reply.code(400).send({ error: "relativePath required" });
      if (typeof req.body?.content !== "string") {
        return reply.code(400).send({ error: "content required" });
      }
      try {
        assertNotRegisteredDocumentWrite(workspace, relativePath);
        return await writeWorkspaceText(workspace, relativePath, req.body.content);
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  app.post<{
    Body: {
      relativePath: string;
      expectedDocument?: { id?: string; revision?: number } | null;
    };
  }>("/api/v1/documents/open", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const relativePath = req.body?.relativePath;
    if (!relativePath) return reply.code(400).send({ error: "relativePath required" });
    const hasExpectedDocument = Boolean(
      req.body && Object.prototype.hasOwnProperty.call(req.body, "expectedDocument"),
    );
    const expectedDocument = req.body?.expectedDocument;
    if (
      hasExpectedDocument &&
      expectedDocument !== null &&
      (
        !expectedDocument ||
        typeof expectedDocument.id !== "string" ||
        !expectedDocument.id.trim() ||
        !Number.isSafeInteger(expectedDocument.revision) ||
        Number(expectedDocument.revision) < 0
      )
    ) {
      return reply.code(400).send({ error: "expectedDocument must be { id, revision } or null" });
    }
    try {
      return await enqueueChat(async () => {
        if (hasExpectedDocument) {
          const activeDocumentId = state.agent.bag.documentId;
          const activeRevision = state.agent.bag.revision;
          const matchesExpectedDocument = expectedDocument === null
            ? activeDocumentId === undefined
            : activeDocumentId === expectedDocument?.id && activeRevision === expectedDocument?.revision;
          if (!matchesExpectedDocument) {
            return reply.code(409).send({ ok: false, reason: "document_mismatch" });
          }
        }
        const doc = await openDocumentFile(workspace, relativePath);
        const blocks = listBlocks(workspace, doc.id);
        const switched = syncBagFromDocument(state.agent, doc, blocks);
        if (switched) {
          state.chat.clear();
          state.reviewThreads = [];
        }
        persistSession();
        return { document: doc, blocks };
      });
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{
    Body: {
      relativePath: string;
      expectedDocument?: { id?: string; revision?: number } | null;
    };
  }>("/api/v1/documents/import-docx", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const relativePath = req.body?.relativePath;
    if (!relativePath) return reply.code(400).send({ error: "relativePath required" });
    const expectedDocument = req.body?.expectedDocument;
    if (
      expectedDocument !== null &&
      (
        !expectedDocument ||
        typeof expectedDocument.id !== "string" ||
        !expectedDocument.id.trim() ||
        !Number.isSafeInteger(expectedDocument.revision) ||
        Number(expectedDocument.revision) < 0
      )
    ) {
      return reply.code(400).send({ error: "expectedDocument must be { id, revision } or null" });
    }
    try {
      return await enqueueChat(async () => {
        const activeDocumentId = state.agent.bag.documentId;
        const activeRevision = state.agent.bag.revision;
        const matchesExpectedDocument = expectedDocument === null
          ? activeDocumentId === undefined
          : activeDocumentId === expectedDocument.id && activeRevision === expectedDocument.revision;
        if (!matchesExpectedDocument) {
          return reply.code(409).send({ ok: false, reason: "document_mismatch" });
        }
        const { document, report } = await importDocxDocument(workspace, relativePath);
        const blocks = listBlocks(workspace, document.id);
        const switched = syncBagFromDocument(state.agent, document, blocks);
        if (switched) {
          state.chat.clear();
          state.reviewThreads = [];
        }
        persistSession();
        return { document, blocks, report };
      });
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { relativePath?: string };
  }>("/api/v1/documents/:id/export-docx", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    try {
      const result = await exportDocumentDocx(
        workspace,
        req.params.id,
        req.body?.relativePath,
      );
      return result;
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/:id", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    try {
      return { document: getDocument(workspace, req.params.id) };
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/:id/blocks", async (req) => {
    requireAuth(state, req.headers.authorization);
    return { blocks: listBlocks(workspace, req.params.id) };
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    "/api/v1/documents/:id/proposals",
    async (req) => {
      requireAuth(state, req.headers.authorization);
      return {
        proposals: listProposals(workspace, req.params.id, req.query.status),
      };
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/documents/:id/comments", async (req) => {
    requireAuth(state, req.headers.authorization);
    return {
      comments: listComments(workspace, req.params.id),
      citeDisclaimer:
        "形态学通过 ≠ 文献真实存在。此检查不验证文献真实性、存在性，也不验证引文是否支持正文主张。",
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/documents/:id/checklists",
    async (req, reply) => {
      requireAuth(state, req.headers.authorization);
      try {
        getDocument(workspace, req.params.id);
        return { runs: listActiveReviewChecklists(workspace, req.params.id) };
      } catch (error) {
        if (error instanceof ReviewChecklistNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        return reply.code(404).send({ error: "not found" });
      }
    },
  );

  app.post<{
    Params: { runId: string };
    Body: { itemIds?: string[]; kind?: "resolve" | "dismiss" };
  }>("/api/v1/checklists/:runId/decisions", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    if (!Array.isArray(req.body?.itemIds) || !req.body?.kind) {
      return reply.code(400).send({ error: "itemIds and kind are required" });
    }
    try {
      const result = decideReviewChecklistItems(
        workspace,
        req.params.runId,
        req.body.itemIds,
        req.body.kind,
      );
      return { decision: result.decision, run: result.checklist };
    } catch (error) {
      if (error instanceof ReviewChecklistConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof ReviewChecklistNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      if (error instanceof ReviewChecklistValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{
    Body: { text?: string; targetLanguage?: "zh-CN" | "en" };
  }>("/api/v1/translate", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (text.length > 100_000) {
      return reply.code(413).send({ error: "translation text is too long" });
    }
    try {
      loadAndApplyLlmSettings(workspacePath);
      const translation = await translateSelection({
        text,
        targetLanguage: req.body?.targetLanguage === "en" ? "en" : "zh-CN",
        timeoutMs: readLlmSettingsStore(workspacePath).agentTimeoutMs,
      });
      return { translation };
    } catch (error) {
      return reply.code(500).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      blockIds?: string[];
      harnessId?: string;
      instruction?: string;
      selectionText?: string;
      selectionStart?: number;
      selectionRanges?: unknown;
      operation?: ProposalOperationKind;
      targetLanguage?: ProposalTargetLanguage;
      tableCell?: { row: number; column: number; address: string; before: string };
      sourcePaths?: string[];
      preferSimple?: boolean;
      selectedSkills?: string[];
    };
  }>("/api/v1/documents/:id/proposal-runs", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    if (!isActiveDocumentRequest(state.agent.bag.documentId, req.params.id)) {
      return reply.code(409).send({ ok: false, reason: "document_mismatch" });
    }
    const selectedSkillsResult = resolveSelectedSkills(req.body?.selectedSkills);
    if (!selectedSkillsResult.ok) {
      return reply.code(400).send({ error: selectedSkillsResult.error });
    }
    const documentId = req.params.id;
    const blocks = listBlocks(workspace, documentId);
    const requestedBlockIds = req.body?.blockIds?.length ? req.body.blockIds : undefined;
    try {
      if (requestedBlockIds) assertSelectionBlockCount(requestedBlockIds);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const selected =
      requestedBlockIds
        ? blocks.filter((b) => requestedBlockIds.includes(b.id))
        : blocks.slice(0, MAX_SELECTION_BLOCKS);
    if (!selected.length) return reply.code(400).send({ error: "no blocks" });
    if (selected.length > MAX_SELECTION_BLOCKS) {
      return reply.code(400).send({ error: `select at most ${MAX_SELECTION_BLOCKS} blocks per scan` });
    }

    const instruction =
      typeof req.body?.instruction === "string"
        ? req.body.instruction.trim().slice(0, 600)
        : undefined;
    const selectionText = typeof req.body?.selectionText === "string"
      ? req.body.selectionText
      : undefined;
    const selectionContextChars = currentSelectionContextLimit();
    if (selectionText && selectionText.length > selectionContextChars) {
      return reply.code(413).send({
        error: `选区超过当前上限 ${selectionContextChars} 字符，请在 Agent 设置中提高“选区上下文”，或缩小选区后重试；Margin 不会静默截断正文。`,
      });
    }
    const selectionStart = Number.isInteger(req.body?.selectionStart) && req.body!.selectionStart! >= 0
      ? req.body!.selectionStart
      : undefined;
    let selectionRanges: SelectionBlockRange[] | undefined;
    try {
      selectionRanges = validateProposalSelectionRanges({
        selected,
        selectionText,
        selectionStart,
        selectionRanges: req.body?.selectionRanges,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const operation = req.body?.operation;
    if (operation && !["rewrite", "translate", "polish"].includes(operation)) {
      return reply.code(400).send({ error: "invalid selection operation" });
    }
    const targetLanguage = req.body?.targetLanguage;
    if (targetLanguage && !["zh-CN", "en"].includes(targetLanguage)) {
      return reply.code(400).send({ error: "invalid target language" });
    }
    let tableCell: { row: number; column: number; address: string; before: string } | undefined;
    if (req.body?.tableCell) {
      if (selected.length !== 1 || selected[0]?.kind !== "table") {
        return reply.code(400).send({ error: "table cell target requires exactly one table block" });
      }
      const row = Number(req.body.tableCell.row);
      const column = Number(req.body.tableCell.column);
      if (!Number.isInteger(row) || row < 1 || !Number.isInteger(column) || column < 1) {
        return reply.code(400).send({ error: "invalid table cell coordinates" });
      }
      try {
        const current = await readNativeDocxTableCell(workspace, documentId, selected[0].id, row, column);
        if (!current || current.address !== req.body.tableCell.address || current.text !== req.body.tableCell.before) {
          return reply.code(409).send({ error: "table cell selection is stale" });
        }
        tableCell = { row, column, address: current.address, before: current.text };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    } else if (selected.some((block) => block.kind === "table")) {
      return reply.code(400).send({ error: "table edits require an exact cell target" });
    }
    const requestedSourcePaths = Array.isArray(req.body?.sourcePaths)
      ? req.body.sourcePaths.filter((item): item is string => typeof item === "string")
      : [];
    if (requestedSourcePaths.length > 12) {
      return reply.code(400).send({ error: "选区快捷提案最多使用 12 份资料；请缩小挂载范围或改用对话研究任务" });
    }
    const availableSources = new Map(
      listWorkspaceSourceFiles(workspace).map((relativePath) => [relativePath.toLocaleLowerCase(), relativePath]),
    );
    const sourcePaths: string[] = [];
    for (const relativePath of requestedSourcePaths) {
      const normalized = relativePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      const canonical = availableSources.get(normalized.toLocaleLowerCase());
      if (!canonical) return reply.code(400).send({ error: `source file not found or unsupported: ${normalized}` });
      if (!sourcePaths.includes(canonical)) sourcePaths.push(canonical);
    }
    const runId = startScanRun(
      documentId,
      selected.map((b) => b.id),
      {
        harnessId: resolveHarnessId(req.body?.harnessId),
        instruction: instruction || undefined,
        selectionText: selectionText?.trim() ? selectionText : undefined,
        selectionStart,
        selectionRanges,
        selectionContextChars,
        operation,
        targetLanguage,
        tableCell,
        sourcePaths,
        preferSimple: req.body?.preferSimple ?? false,
        selectedSkills: selectedSkillsResult.skills.length
          ? selectedSkillsResult.skills
          : undefined,
      },
    );
    return reply.code(202).send({ runId });
  });

  app.get<{ Params: { runId: string } }>("/api/v1/proposal-runs/:runId", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const run = state.runs.get(req.params.runId);
    if (!run) return reply.code(404).send({ error: "not found" });
    return run;
  });

  app.post<{ Body: { sourceRef: string } }>("/api/v1/workspace/source-chunk", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const sourceRef = req.body?.sourceRef?.trim().replace(/\\/g, "/");
    const match = /^(.+)#(?:sha256=([a-f0-9]+)&)?chars=(\d+)-(\d+)$/i.exec(sourceRef ?? "");
    if (!match) return reply.code(400).send({ error: "invalid sourceRef" });
    const expectedHash = match[2];
    const start = Number(match[3]);
    const end = Number(match[4]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 12_000) {
      return reply.code(400).send({ error: "invalid source range" });
    }
    try {
      const requestedPath = match[1]!.replace(/\\/g, "/");
      const canonicalPath = new Map(
        listWorkspaceSourceFiles(workspace).map((relativePath) => [relativePath.toLocaleLowerCase(), relativePath]),
      ).get(requestedPath.toLocaleLowerCase());
      if (!canonicalPath) return reply.code(400).send({ error: "source file not found or unsupported" });
      const source = await readSourceExcerpt(canonicalPath);
      if (expectedHash && source.contentHash !== expectedHash) {
        return reply.code(409).send({ error: "sourceRef is stale because the source content changed" });
      }
      if (end > source.text.length) return reply.code(409).send({ error: "sourceRef is stale" });
      const excerptStart = Math.max(0, start - 320);
      const excerptEnd = Math.min(source.text.length, end + 320);
      return {
        sourceRef,
        relativePath: source.relativePath,
        excerpt: source.text.slice(excerptStart, excerptEnd),
        selectionStart: start - excerptStart,
        selectionEnd: end - excerptStart,
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{
    Body: { documentId?: string | null; sourcePaths?: string[] };
  }>("/api/v1/session/sources", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const hasDocumentId = Boolean(
      req.body && Object.prototype.hasOwnProperty.call(req.body, "documentId"),
    );
    const requestedDocumentId = req.body?.documentId;
    if (
      !hasDocumentId ||
      (
        requestedDocumentId !== null &&
        (
          typeof requestedDocumentId !== "string" ||
          !requestedDocumentId.trim() ||
          requestedDocumentId !== requestedDocumentId.trim()
        )
      )
    ) {
      return reply.code(400).send({ error: "documentId must be a non-empty string or null" });
    }
    try {
      return await enqueueChat(async () => {
        if ((state.agent.bag.documentId ?? null) !== requestedDocumentId) {
          return reply.code(409).send({ ok: false, reason: "document_mismatch" });
        }
        replaceAttachedSources(state.agent, workspace, req.body?.sourcePaths ?? []);
        persistSession();
        return { sourcePaths: state.agent.sourcePaths };
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{
    Body: {
      documentId?: string;
      threads?: Array<Omit<PersistedReviewThread, "documentId"> & { documentId?: string }>;
    };
  }>("/api/v1/session/threads", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const documentId = req.body?.documentId?.trim();
    if (!documentId) return reply.code(400).send({ error: "documentId required" });
    if (!Array.isArray(req.body?.threads)) {
      return reply.code(400).send({ error: "threads must be an array" });
    }
    return enqueueChat(async () => {
      if (documentId !== state.agent.bag.documentId) {
        return reply.code(409).send({ error: "文稿状态已变化，请刷新页面后重试" });
      }
      state.reviewThreads = req.body.threads!.map((thread) => ({
        ...thread,
        documentId,
      }));
      const saved = persistSession();
      state.reviewThreads = saved.threads.filter((thread) => thread.documentId === documentId);
      return { threads: state.reviewThreads };
    });
  });

  app.delete<{ Params: { runId: string } }>("/api/v1/proposal-runs/:runId", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const run = state.runs.get(req.params.runId);
    if (!run) return reply.code(404).send({ error: "not found" });
    if (["done", "error", "superseded", "cancelled"].includes(run.status)) {
      return { ok: true, status: run.status };
    }
    setBoundedMap(state.runs, req.params.runId, {
      ...run,
      status: "cancelled",
      phase: "已停止",
    });
    state.scanAbortControllers.get(req.params.runId)?.abort();
    return { ok: true, status: "cancelled" };
  });

  app.patch<{
    Params: { id: string };
    Body: { kind: "Y" | "N" | "E"; editedText?: string; reason?: string };
  }>("/api/v1/proposals/:id/decision", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    // I1: decision notes + persistSession mutate the chat agent state; serialize with chat turns.
    return enqueueChat(async () => {
      try {
        const proposal = getProposal(workspace, req.params.id);
        if (!isActiveDocumentRequest(state.agent.bag.documentId, proposal.documentId)) {
          return reply.code(409).send({ error: "文稿状态已变化，请刷新页面后重试" });
        }
        const decision = saveDecision(
          workspace,
          req.params.id,
          req.body.kind,
          req.body.editedText,
          req.body.reason,
        );
        appendConversationNote(state.agent, decisionConversationNote(proposal, decision));
        persistSession();
        return { decision };
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });
  });

  app.post<{
    Params: { id: string };
    Body: { expectedRevision: number; expectedHash: string; proposalIds?: string[] };
  }>("/api/v1/documents/:id/apply", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    // I1: apply mutates the bag and appends agent notes; serialize with chat turns.
    return enqueueChat(async () => {
      if (!isActiveDocumentRequest(state.agent.bag.documentId, req.params.id)) {
        return reply.code(409).send({ ok: false, reason: "document_mismatch" });
      }
      if (!Array.isArray(req.body.proposalIds) || req.body.proposalIds.length === 0) {
        return reply.code(400).send({ error: "proposalIds must be a non-empty explicit list" });
      }
      const result = await applyApproved(
        workspace,
        req.params.id,
        req.body.expectedRevision,
        req.body.expectedHash,
        Array.isArray(req.body.proposalIds)
          ? req.body.proposalIds.filter((id): id is string => typeof id === "string").slice(0, 100)
          : undefined,
      );
      if (!result.ok) return reply.code(409).send(result);
      syncBagFromDocument(state.agent, result.document, result.blocks);
      const requestedApplyIds = new Set(req.body.proposalIds);
      const appliedProposals = listProposals(workspace, req.params.id).filter(
        (proposal) =>
          requestedApplyIds.has(proposal.id) &&
          ["Y", "E"].includes(getLatestDecision(workspace, proposal.id)?.kind ?? ""),
      );
      if (appliedProposals.length) {
        appendConversationNote(state.agent, applyConversationNote(appliedProposals));
      }
      persistSession();
      return result;
    });
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/:id/exports", async (req) => {
    requireAuth(state, req.headers.authorization);
    return exportPacket(workspace, req.params.id);
  });

  app.get("/api/v1/chat/history", async (req) => {
    requireAuth(state, req.headers.authorization);
    return {
      turns: state.chat.list(),
      maxTurns: 80,
      clarificationRounds: state.agent.clarificationRounds ?? 0,
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/v1/chat/transcripts", async (req) => {
    requireAuth(state, req.headers.authorization);
    return { transcripts: listAgentTranscripts(workspace, Number(req.query.limit ?? 20)) };
  });

  app.post("/api/v1/chat/clear", async (req) => {
    requireAuth(state, req.headers.authorization);
    await enqueueChat(async () => {
      const clearedSessionId = state.agent.sessionId;
      state.chat.clear();
      clearChatAgentConversation(state.agent);
      persistSession();
      // A cleared session must not linger in the history list.
      deleteAgentSession(workspace, clearedSessionId);
    });
    return {
      ok: true,
      documentId: state.agent.bag.documentId,
      sourcePaths: state.agent.sourcePaths,
    };
  });

  app.get("/api/v1/sessions", async (req) => {
    requireAuth(state, req.headers.authorization);
    return {
      sessions: listAgentSessions(workspace),
      currentSessionId: state.agent.sessionId,
    };
  });

  app.post("/api/v1/sessions/new", async (req) => {
    requireAuth(state, req.headers.authorization);
    await enqueueChat(async () => {
      mcpApprovalRegistry.denyAllForSession(state.agent.sessionId, "session-switch");
      rotateChatSessionWithSummary(workspace, state.agent, state.chat.list().length > 0);
      state.chat.clear();
      persistSession();
    });
    return sessionPayload();
  });

  /** Manual context compaction: force-summarize the current transcript. */
  app.post("/api/v1/sessions/compact", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    try {
      return await enqueueChat(async () => {
        const result = await compactChatAgentConversation({
          workspace,
          agentState: state.agent,
          chat: state.chat,
          harnessId: resolveHarnessId(),
        });
        persistSession();
        return result;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof ManualCompactionError ? 409 : 500;
      return reply.code(status).send({ error: message });
    }
  });

  app.post<{ Body: { sessionId?: string } }>("/api/v1/sessions/switch", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    if (!sessionId || sessionId.length > 200) {
      return reply.code(400).send({ error: "sessionId required" });
    }
    if (sessionId === state.agent.sessionId) return sessionPayload();
    const envelope = loadAgentSessionEnvelope(workspace, sessionId);
    if (!envelope) return reply.code(404).send({ error: "未知会话" });
    await enqueueChat(async () => {
      mcpApprovalRegistry.denyAllForSession(state.agent.sessionId, "session-switch");
      archiveCurrentSession();
      state.agent = chatAgentStateFromSession(workspace, envelope);
      state.chat.hydrate(envelope.chatTurns);
      state.reviewThreads = envelope.threads.filter(
        (thread) => thread.documentId === state.agent.bag.documentId,
      );
      persistSession();
    });
    return sessionPayload();
  });

  app.delete<{ Params: { id: string } }>("/api/v1/sessions/:id", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const sessionId = req.params.id?.trim();
    if (!sessionId) return reply.code(400).send({ error: "sessionId required" });
    if (sessionId === state.agent.sessionId) {
      return reply.code(409).send({ error: "不能删除当前会话" });
    }
    deleteAgentSession(workspace, sessionId);
    return { ok: true };
  });

  app.get("/api/v1/extensions/skills", async (req) => {
    requireAuth(state, req.headers.authorization);
    const skillsRoot = path.join(workspacePath, ".margin", "skills");
    const store = readSkillSettings(workspacePath);
    const scope = getHarness(resolveHarnessId()).skills.scope;
    return {
      skills: listSkillStates(skillsRoot, scope, disabledSkillNames(store)).map((skill) => ({
        name: skill.name,
        description: skill.description,
        contentHash: skill.contentHash,
        source: skill.source ?? "bundled",
        state: skill.state,
        preference: store.skills[skill.name] ?? "auto",
        overridesBundled: skill.overridesBundled,
      })),
    };
  });

  app.put<{ Params: { name: string }; Body: { mode?: string } }>(
    "/api/v1/extensions/skills/:name",
    async (req, reply) => {
      requireAuth(state, req.headers.authorization);
      const mode = req.body?.mode;
      if (mode !== "off" && mode !== "auto") {
        return reply.code(400).send({ error: "mode 必须是 off 或 auto" });
      }
      const skillsRoot = path.join(workspacePath, ".margin", "skills");
      const store = readSkillSettings(workspacePath);
      const scope = getHarness(resolveHarnessId()).skills.scope;
      const skill = listSkillStates(skillsRoot, scope, disabledSkillNames(store))
        .find((entry) => entry.name === req.params.name);
      if (!skill) return reply.code(404).send({ error: `未知 Skill: ${req.params.name}` });
      // Profile scope is a hard upper bound: cannot re-enable what it forbids.
      if (mode === "auto" && skill.state === "blocked_by_profile") {
        return reply.code(409).send({ error: `当前 Agent 模式无法使用 Skill: ${skill.name}` });
      }
      await setSkillMode(workspacePath, skill.name, mode);
      return {
        ok: true,
        skill: {
          name: skill.name,
          preference: mode,
          state: mode === "off"
            ? "disabled"
            : skill.state === "blocked_by_profile"
              ? "blocked_by_profile"
              : "enabled",
        },
      };
    },
  );

  app.post<{ Body: { content?: string } }>("/api/v1/extensions/skills", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    if (typeof req.body?.content !== "string" || !req.body.content.trim()) {
      return reply.code(400).send({ error: "SKILL.md content required" });
    }
    try {
      const skill = await importWorkspaceSkill(
        path.join(workspacePath, ".margin", "skills"),
        req.body.content,
      );
      return {
        ok: true,
        skill: {
          name: skill.name,
          description: skill.description,
          contentHash: skill.contentHash,
          source: "workspace",
        },
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { name: string } }>("/api/v1/extensions/skills/:name", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    try {
      await removeWorkspaceSkill(
        path.join(workspacePath, ".margin", "skills"),
        req.params.name,
      );
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/v1/extensions/mcp", async (req) => {
    requireAuth(state, req.headers.authorization);
    return { servers: publicRemoteMcpServers(workspacePath) };
  });

  app.post<{ Body: { url?: string; token?: string; serverId?: string } }>(
    "/api/v1/extensions/mcp/discover",
    async (req, reply) => {
      requireAuth(state, req.headers.authorization);
      try {
        return await discoverWorkspaceRemoteMcp(workspacePath, {
          url: String(req.body?.url ?? ""),
          token: req.body?.token,
          serverId: req.body?.serverId,
        });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.put<{
    Body: { name?: string; url?: string; token?: string; clearToken?: boolean; enabledTools?: string[] };
  }>("/api/v1/extensions/mcp", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    try {
      const server = await saveRemoteMcpServer(workspacePath, {
        name: req.body?.name,
        url: String(req.body?.url ?? ""),
        token: req.body?.token,
        clearToken: req.body?.clearToken === true,
        enabledTools: Array.isArray(req.body?.enabledTools) ? req.body.enabledTools : [],
      });
      return {
        ok: true,
        server: publicRemoteMcpServers(workspacePath).find((item) => item.id === server.id),
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/extensions/mcp/:id", async (req) => {
    requireAuth(state, req.headers.authorization);
    await removeRemoteMcpServer(workspacePath, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { approvalId: string }; Body: { decision?: string } }>(
    "/api/v1/extensions/mcp/approvals/:approvalId",
    async (req, reply) => {
      requireAuth(state, req.headers.authorization);
      const decision = req.body?.decision;
      if (decision !== "allow" && decision !== "deny") {
        return reply.code(400).send({ error: "decision must be allow or deny" });
      }
      const result = mcpApprovalRegistry.resolve(req.params.approvalId, decision);
      if (result.status === "expired") {
        return reply.code(410).send({ error: "审批已超时失效" });
      }
      if (result.status === "unknown") {
        return reply.code(404).send({ error: "审批不存在或已被处理" });
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/documents/:id/resolve-proposals",
    async (req, reply) => {
      requireAuth(state, req.headers.authorization);
      let input: ReturnType<typeof parseResolveProposalsInput>;
      try {
        input = parseResolveProposalsInput(req.body);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
      return enqueueChat(async () => {
        if (!isActiveDocumentRequest(state.agent.bag.documentId, req.params.id)) {
          return reply.code(409).send({ ok: false, reason: "document_mismatch" });
        }
        try {
          const result = await resolveProposalsAtomically(workspace, req.params.id, input);
          if (!result.ok) return reply.code(409).send(result);
          syncBagFromDocument(state.agent, result.document, result.blocks);
          if (!result.replayed) {
            for (let index = 0; index < result.proposals.length; index += 1) {
              appendConversationNote(
                state.agent,
                decisionConversationNote(result.proposals[index]!, result.decisions[index]!),
              );
            }
            appendConversationNote(state.agent, applyConversationNote(result.proposals));
          }
          persistSession();
          return {
            ok: true,
            document: result.document,
            blocks: result.blocks,
            decisions: result.decisions,
            ...(result.replayed ? { replayed: true } : {}),
          };
        } catch (error) {
          return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      kind: "Y" | "N" | "E";
      editedText?: string;
      reason?: string;
      expectedRevision: number;
      expectedHash: string;
      documentId: string;
    };
  }>("/api/v1/proposals/:id/resolve", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    // I1: resolve mutates the bag, appends agent notes and persists; serialize with chat turns.
    return enqueueChat(async () => {
      let claimed = false;
      let applied = false;
      try {
        const proposal = getProposal(workspace, req.params.id);
        if (req.body.documentId !== proposal.documentId) {
          return reply.code(409).send({ ok: false, reason: "document_mismatch" });
        }
        if (!isActiveDocumentRequest(state.agent.bag.documentId, proposal.documentId)) {
          return reply.code(409).send({ ok: false, reason: "document_mismatch" });
        }
        if (proposal.status !== "proposed") {
          const previousDecision = getLatestDecision(workspace, proposal.id);
          const previousApply = getLatestProposalApplyEvent(workspace, proposal.id);
          const sameDecision = previousDecision?.kind === req.body.kind &&
            (req.body.kind !== "E" || previousDecision.editedText === req.body.editedText);
          if (sameDecision && req.body.kind === "N" && proposal.status === "superseded") {
            return { ok: true, rejected: true, decision: previousDecision, replayed: true };
          }
          if (
            sameDecision &&
            previousApply?.ok &&
            previousApply.decisionId === previousDecision?.id
          ) {
            return {
              ok: true,
              document: getDocument(workspace, proposal.documentId),
              blocks: listBlocks(workspace, proposal.documentId),
              decision: previousDecision,
              replayed: true,
            };
          }
          return reply.code(409).send({
            ok: false,
            reason: proposal.status === "decided" ? "proposal_resolving" : "proposal_already_resolved",
          });
        }
        const decision = saveDecision(
          workspace,
          proposal.id,
          req.body.kind,
          req.body.editedText,
          req.body.reason,
        );
        claimed = true;
        if (decision.kind === "N") {
          rejectProposal(workspace, proposal, decision);
          appendConversationNote(state.agent, decisionConversationNote(proposal, decision));
          persistSession();
          return { ok: true, rejected: true, decision };
        }
        const result = await applyApproved(
          workspace,
          proposal.documentId,
          req.body.expectedRevision,
          req.body.expectedHash,
          [proposal.id],
        );
        if (!result.ok) {
          reopenProposal(workspace, proposal.id);
          claimed = false;
          return reply.code(409).send(result);
        }
        applied = true;
        syncBagFromDocument(state.agent, result.document, result.blocks);
        appendConversationNote(state.agent, decisionConversationNote(proposal, decision));
        appendConversationNote(state.agent, applyConversationNote([proposal]));
        persistSession();
        return { ...result, decision };
      } catch (error) {
        if (claimed && !applied) reopenProposal(workspace, req.params.id);
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  app.delete("/api/v1/session/document", async (req) => {
    requireAuth(state, req.headers.authorization);
    const closed = await enqueueChat(async () => {
      const documentId = state.agent.bag.documentId;
      closeChatAgentDocument(state.agent);
      state.reviewThreads = [];
      persistSession();
      return documentId;
    });
    return { ok: true, closedDocumentId: closed };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/v1/documents/:id/timeline",
    async (req) => {
      requireAuth(state, req.headers.authorization);
      return {
        entries: listDocumentTimeline(
          workspace,
          req.params.id,
          Number(req.query.limit ?? 50),
        ),
      };
    },
  );

  /** Full session agent — workspace + paper tools (not intent router). */
  app.post<{
    Body: {
      message: string;
      documentId?: string;
      selectionBlockIds?: string[];
      selectionText?: string;
      selectionStart?: number;
      cascadeBlockIds?: string[];
      sourcePaths?: string[];
      chatMode?: "direct" | "socratic";
      threadId?: string;
      harnessId?: string;
      selectedSkills?: string[];
    };
  }>("/api/v1/chat", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const selectedSkillsResult = resolveSelectedSkills(req.body?.selectedSkills);
    if (!selectedSkillsResult.ok) {
      return reply.code(400).send({ error: selectedSkillsResult.error });
    }
    const message = (req.body?.message ?? "").trim();
    if (!message) return reply.code(400).send({ error: "message required" });
    const threadId = req.body?.threadId?.trim();
    if (req.body?.threadId !== undefined && (!threadId || threadId.length > 200)) {
      return reply.code(400).send({ error: "invalid threadId" });
    }
    const clearRequested = /^(清空对话|清除对话|新会话|reset\s*chat)(?:。|！|!)?$/i.test(message);
    const closeRequested = isCloseDocumentRequest(message);
    if (!clearRequested && !closeRequested) {
      const selectionError = chatSelectionError(
        req.body?.selectionText,
        currentSelectionContextLimit(),
      );
      if (selectionError) {
        return reply.code(selectionError.statusCode).send({ error: selectionError.error });
      }
    }

    try {
      const outcome = await enqueueChat(async () => {
        if (clearRequested) {
          const clearedSessionId = state.agent.sessionId;
          state.chat.clear();
          clearChatAgentConversation(state.agent);
          persistSession();
          deleteAgentSession(workspace, clearedSessionId);
          return { cleared: true as const, closed: false as const };
        }
        if (closeRequested) {
          const hadDocument = Boolean(state.agent.bag.documentId);
          closeChatAgentDocument(state.agent);
          state.reviewThreads = [];
          const response = hadDocument ? "已关闭当前文稿。" : "当前没有打开的文稿。";
          state.chat.remember("user", message);
          state.chat.remember("assistant", response);
          persistSession();
          return { cleared: false as const, closed: true as const, hadDocument };
        }
        let switchedDocument = false;
        if (req.body.documentId && req.body.documentId !== state.agent.bag.documentId) {
          if (state.agent.bag.documentId) {
            throw new Error("文稿状态已变化，请刷新页面后重试");
          }
          try {
            const document = getDocument(workspace, req.body.documentId);
            const blocks = listBlocks(workspace, document.id);
            switchedDocument = syncBagFromDocument(state.agent, document, blocks);
          } catch (error) {
            throw new Error(
              `无法恢复请求中的文稿：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const previousDocumentId = state.agent.bag.documentId;
        const turn = await runChatAgentTurn({
          workspace,
          chat: state.chat,
          agentState: state.agent,
          message,
          selectionText: req.body.selectionText,
          selectionStart: req.body.selectionStart,
          selectionBlockIds: req.body.selectionBlockIds,
          cascadeBlockIds: req.body.cascadeBlockIds,
          sourcePaths: switchedDocument ? [] : req.body.sourcePaths,
          chatMode: req.body.chatMode === "socratic" ? "socratic" : "direct",
          harnessId: resolveHarnessId(req.body.harnessId),
          selectedSkills: selectedSkillsResult.skills.length
            ? selectedSkillsResult.skills
            : undefined,
          threadId,
        });
        if (previousDocumentId && state.agent.bag.documentId !== previousDocumentId) {
          state.reviewThreads = [];
          persistSession();
        }
        return { cleared: false as const, closed: false as const, turn };
      });
      if (outcome.cleared) return { reply: "对话已清空，当前文稿保持打开。" };
      if (outcome.closed) {
        return {
          reply: outcome.hadDocument ? "已关闭当前文稿。" : "当前没有打开的文稿。",
          closed: true,
          sourcePaths: [],
          clarificationRounds: 0,
        };
      }
      const { turn } = outcome;
      return {
        reply: turn.reply,
        opened: turn.opened,
        engine: turn.engine,
        steps: turn.steps,
        proposalCount: turn.proposalCount,
        clarificationRounds: turn.clarificationRounds,
        sourcePaths: turn.sourcePaths,
        cascadeOffer: turn.cascadeOffer,
        notes: turn.notes,
        loadedSkills: turn.loadedSkills,
        task: turn.task,
      };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** NDJSON stream of session-agent progress + reply. */
  app.post<{
    Body: {
      message: string;
      documentId?: string;
      selectionBlockIds?: string[];
      selectionText?: string;
      selectionStart?: number;
      cascadeBlockIds?: string[];
      sourcePaths?: string[];
      chatMode?: "direct" | "socratic";
      threadId?: string;
      harnessId?: string;
      selectedSkills?: string[];
    };
  }>("/api/v1/chat/stream", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const selectedSkillsResult = resolveSelectedSkills(req.body?.selectedSkills);
    if (!selectedSkillsResult.ok) {
      return reply.code(400).send({ error: selectedSkillsResult.error });
    }
    const message = (req.body?.message ?? "").trim();
    if (!message) return reply.code(400).send({ error: "message required" });
    const threadId = req.body?.threadId?.trim();
    if (req.body?.threadId !== undefined && (!threadId || threadId.length > 200)) {
      return reply.code(400).send({ error: "invalid threadId" });
    }
    const clearRequested = /^(清空对话|清除对话|新会话|reset\s*chat)(?:。|！|!)?$/i.test(message);
    const closeRequested = isCloseDocumentRequest(message);
    if (!clearRequested && !closeRequested) {
      const selectionError = chatSelectionError(
        req.body?.selectionText,
        currentSelectionContextLimit(),
      );
      if (selectionError) {
        return reply.code(selectionError.statusCode).send({ error: selectionError.error });
      }
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const ac = new AbortController();
    const stopWatchingDisconnect = abortOnClientDisconnect(req.raw, reply.raw, ac);
    const send = (obj: Record<string, unknown>) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`${JSON.stringify(obj)}\n`);
    };

    const runId = randomUUID();
    const mcpApprovalAudit: McpApprovalAuditEntry[] = [];
    // A new run supersedes any still-pending approvals of this session.
    mcpApprovalRegistry.denyAllForSession(state.agent.sessionId, "superseded");
    ac.signal.addEventListener("abort", () => {
      for (const audit of mcpApprovalRegistry.denyAllForRun(runId, "run-cancelled")) {
        mcpApprovalAudit.push(audit);
      }
    });
    const remoteMcp = {
      bridge: createRemoteMcpBridge(workspacePath),
      requestApproval: async (request: RemoteMcpApprovalRequest): Promise<"allow" | "deny"> => {
        const { approvalId, wait } = mcpApprovalRegistry.request({
          workspaceRoot: workspacePath,
          sessionId: state.agent.sessionId,
          runId,
          toolCallId: request.toolCallId,
          serverId: request.serverId,
          serverName: request.serverName,
          tool: request.tool,
          args: request.args,
        });
        send({
          type: "approval_request",
          approvalId,
          server: { id: request.serverId, name: request.serverName },
          tool: request.tool,
          args: request.args,
        });
        const { outcome, audit } = await wait;
        mcpApprovalAudit.push(audit);
        return outcome.decision;
      },
    };

    try {
      if (!clearRequested) send({ type: "status", text: "正在处理…" });
      let streamed = false;
      const outcome = await enqueueChat(async () => {
        if (ac.signal.aborted) return { disconnected: true as const };
        if (clearRequested) {
          const clearedSessionId = state.agent.sessionId;
          state.chat.clear();
          clearChatAgentConversation(state.agent);
          persistSession();
          deleteAgentSession(workspace, clearedSessionId);
          return { cleared: true as const, closed: false as const };
        }
        if (closeRequested) {
          const hadDocument = Boolean(state.agent.bag.documentId);
          closeChatAgentDocument(state.agent);
          state.reviewThreads = [];
          const response = hadDocument ? "已关闭当前文稿。" : "当前没有打开的文稿。";
          state.chat.remember("user", message);
          state.chat.remember("assistant", response);
          persistSession();
          return { cleared: false as const, closed: true as const, hadDocument };
        }
        let switchedDocument = false;
        if (req.body.documentId && req.body.documentId !== state.agent.bag.documentId) {
          if (state.agent.bag.documentId) {
            throw new Error("文稿状态已变化，请刷新页面后重试");
          }
          try {
            const document = getDocument(workspace, req.body.documentId);
            const blocks = listBlocks(workspace, document.id);
            switchedDocument = syncBagFromDocument(state.agent, document, blocks);
          } catch (error) {
            throw new Error(
              `无法恢复请求中的文稿：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const previousDocumentId = state.agent.bag.documentId;
        const turn = await runChatAgentTurn({
          workspace,
          chat: state.chat,
          agentState: state.agent,
          message,
          selectionText: req.body.selectionText,
          selectionStart: req.body.selectionStart,
          selectionBlockIds: req.body.selectionBlockIds,
          cascadeBlockIds: req.body.cascadeBlockIds,
          sourcePaths: switchedDocument ? [] : req.body.sourcePaths,
          chatMode: req.body.chatMode === "socratic" ? "socratic" : "direct",
          harnessId: resolveHarnessId(req.body.harnessId),
          selectedSkills: selectedSkillsResult.skills.length
            ? selectedSkillsResult.skills
            : undefined,
          threadId,
          signal: ac.signal,
          remoteMcp,
          mcpApprovalAudit,
          onProgress: (phase) => {
            if (isUserFacingPhase(phase)) send({ type: "status", text: phase });
          },
          onDelta: (chunk) => {
            if (!chunk) return;
            streamed = true;
            send({ type: "delta", text: chunk });
          },
        });
        if (previousDocumentId && state.agent.bag.documentId !== previousDocumentId) {
          state.reviewThreads = [];
          persistSession();
        }
        return { cleared: false as const, closed: false as const, turn };
      });
      if (outcome.disconnected) return;
      if (outcome.cleared) {
        const text = "对话已清空，当前文稿保持打开。";
        send({ type: "delta", text });
        send({ type: "done", reply: text });
        reply.raw.end();
        return;
      }
      if (outcome.closed) {
        const text = outcome.hadDocument ? "已关闭当前文稿。" : "当前没有打开的文稿。";
        send({ type: "delta", text });
        send({
          type: "done",
          reply: text,
          closed: true,
          clarificationRounds: 0,
          sourcePaths: [],
        });
        reply.raw.end();
        return;
      }
      const { turn } = outcome;
      if (ac.signal.aborted) return;
      if (!streamed && turn.reply) send({ type: "delta", text: turn.reply });
      send({
        type: "done",
        reply: turn.reply,
        opened: turn.opened,
        engine: turn.engine,
        steps: (turn.steps ?? []).filter(isUserFacingPhase),
        proposalCount: turn.proposalCount,
        clarificationRounds: turn.clarificationRounds,
        sourcePaths: turn.sourcePaths,
        cascadeOffer: turn.cascadeOffer,
        notes: turn.notes,
        loadedSkills: turn.loadedSkills,
        task: turn.task,
      });
      reply.raw.end();
    } catch (e) {
      if (!ac.signal.aborted && !reply.raw.destroyed && !reply.raw.writableEnded) {
        send({ type: "error", error: e instanceof Error ? e.message : String(e) });
        reply.raw.end();
      }
    } finally {
      stopWatchingDisconnect();
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/documents/:id/native-docx",
    async (req, reply) => {
      requireAuth(state, req.headers.authorization);
      try {
        const document = getDocument(workspace, req.params.id);
        const buffer = readNativeDocx(workspace, document.id);
        return reply
          .type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
          .header("Content-Length", String(buffer.byteLength))
          .header("Cache-Control", "no-store")
          .send(buffer);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: Buffer }>(
    "/api/v1/documents/:id/native-docx",
    async (req, reply) => {
      requireAuth(state, req.headers.authorization);
      const expectedRevision = Number(req.headers["x-margin-revision"]);
      const expectedHash = String(req.headers["x-margin-hash"] ?? "");
      const saveMode = req.headers["x-margin-save-mode"] === "rebuild" ? "rebuild" : "preserve";
      const changedBlockIds = String(req.headers["x-margin-changed-blocks"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || !expectedHash) {
        return reply.code(400).send({ error: "revision and hash headers required" });
      }
      if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
        return reply.code(400).send({ error: "DOCX body required" });
      }
      try {
        return await enqueueChat(async () => {
          if (!isActiveDocumentRequest(state.agent.bag.documentId, req.params.id)) {
            return reply.code(409).send({ ok: false, reason: "document_mismatch" });
          }
          const result = await saveNativeDocx(
            workspace,
            req.params.id,
            expectedRevision,
            expectedHash,
            req.body,
            saveMode,
            changedBlockIds.length ? new Set(changedBlockIds) : undefined,
          );
          if (!result.ok) return reply.code(409).send(result);
          syncBagFromDocument(state.agent, result.document, result.blocks);
          return result;
        });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  const webDistCandidates = [
    path.resolve(__dirname, "../../web/dist"),
    path.resolve(__dirname, "../web-dist"),
  ];
  const webDist = webDistCandidates.find((candidate) => fs.existsSync(candidate));
  const publicDir = path.resolve(__dirname, "../public");
  const staticRoot = webDist ?? publicDir;
  await app.register(fastifyStatic, {
    root: staticRoot,
    wildcard: false,
    setHeaders(reply, filePath) {
      // Hashed assets may be cached; HTML must not, or upgrades keep serving old UI ("缓存命中").
      if (String(filePath).endsWith(".html")) {
        reply.header("Cache-Control", "no-store");
      }
    },
  });
  // Legacy batch UI (deprecated)
  app.get("/legacy", async (_req, reply) => {
    const legacy = path.join(publicDir, "legacy.html");
    if (fs.existsSync(legacy)) return reply.sendFile("legacy.html", publicDir);
    return reply.code(404).send("legacy UI missing");
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.header("Cache-Control", "no-store").sendFile("index.html", staticRoot);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const closing = app.close();
    await workspace.releaseLock();
    await closing;
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port, host: "127.0.0.1" });
  runtime.app = app;
  runtime.state = state;
  runtime.enqueueChat = enqueueChat;
  const url = `http://127.0.0.1:${port}/#token=${token}`;
  console.log(`Margin Agent (local)`);
  console.log(`  workspace: ${workspacePath}`);
  console.log(`  UI:        ${url}`);
  console.log(`  llm:       ${llmMode()}`);
  console.log(`  engine:    ${resolveEngine()} (preferred=pi)`);
  if (process.env.MARGIN_UNLIMITED === "1") {
    console.log(`  security: unlimited-read ON (external path reads allowed)`);
  }
  console.log(`  keep this terminal open; Ctrl+C to stop`);
  if (llmMode() === "mock") {
    console.log(`  tip:       set OPENAI_API_KEY or MARGIN_BASE_URL for real BYOK`);
  }
  if (llmMode() === "mock") {
    console.log(`  tip:       no key → offline session tool loop (same tools; model schedules with Key)`);
  }
  if (resolveEngine() === "simple") {
    console.log(`  tip:       MARGIN_ENGINE=simple (offline/test); preferred agent engine remains pi`);
  }
  if (process.env.MARGIN_NO_OPEN !== "1") {
    await open(url);
  } else {
    console.log(`  (MARGIN_NO_OPEN=1, browser not launched)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
