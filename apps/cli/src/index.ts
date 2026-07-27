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
  listAgentTranscripts,
  loadAndApplyLlmSettings,
  readLlmSettingsStore,
  activeProfile,
  saveLlmSettings,
  publicLlmSettings,
  assertNotRegisteredDocumentWrite,
  saveAgentSession,
  listDocumentTimeline,
  type PersistedReviewThread,
  type Workspace,
} from "@margin/storage-local";
import { isUserFacingPhase, runBlockScan, resolveEngine } from "@margin/agent";
import {
  contentHash,
  type ProposalOperationKind,
  type ProposalTargetLanguage,
} from "@margin/domain";
import {
  getHarness,
  importWorkspaceSkill,
  listAvailableSkills,
  listHarnesses,
  removeWorkspaceSkill,
} from "@margin/harness";
import {
  discoverLlmModels,
  testLlmModelConnection,
  type LlmProviderProbeInput,
} from "@margin/llm";
import {
  clearChatAgentConversation,
  closeChatAgentDocument,
  isCloseDocumentRequest,
  loadPersistedChatTurns,
  loadPersistedReviewThreads,
  restoreChatAgentState,
  replaceAttachedSources,
  runChatAgentTurn,
  syncBagFromDocument,
  type ChatAgentState,
} from "./chat-agent.js";
import { buildLlmSettingsUpdate } from "./llm-settings-patch.js";
import { ChatMemory } from "./chat-memory.js";
import {
  resolveLlmConnectionInput,
  type LlmConnectionBody,
} from "./llm-connection.js";
import { setBoundedMap } from "./run-state.js";
import { abortOnClientDisconnect } from "./stream-lifecycle.js";
import {
  discoverWorkspaceRemoteMcp,
  publicRemoteMcpServers,
  removeRemoteMcpServer,
  saveRemoteMcpServer,
} from "./mcp-remote.js";
import { MARGIN_VERSION } from "./version.js";

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

type RunState = {
  status: string;
  error?: string;
  proposalIds?: string[];
  commentCount?: number;
  engine?: string;
  preferredEngine?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  notes?: string[];
  citeDisclaimer?: string;
  phase?: string;
  steps?: string[];
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
  await recoverDecidedProposals(workspace);
  await reconcileRegisteredDocxDocuments(workspace);
  loadAndApplyLlmSettings(workspacePath);

  const llmPublic = () => publicLlmSettings(readLlmSettingsStore(workspacePath));

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
      task: state.agent.task,
    });
  const sourceExcerptCache = new Map<string, {
    mtimeMs: number;
    size: number;
    relativePath: string;
    text: string;
    contentHash: string;
  }>();
  const readSourceExcerpt = async (relativePath: string) => {
    const absolutePath = path.join(workspace.root, relativePath);
    const stat = fs.statSync(absolutePath);
    const cacheKey = relativePath.replace(/\\/g, "/").toLocaleLowerCase();
    const cached = sourceExcerptCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    const source = await readWorkspaceSource(workspace, relativePath);
    const entry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
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
      operation?: ProposalOperationKind;
      targetLanguage?: ProposalTargetLanguage;
      tableCell?: { row: number; column: number; address: string; before: string };
      sourcePaths?: string[];
      preferSimple?: boolean;
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
      const sourceContext = [] as Array<{ sourceRef: string; text: string }>;
      let remainingSourceChars = 24_000;
      for (const relativePath of opts?.sourcePaths ?? []) {
        if (remainingSourceChars <= 0) break;
        const source = await readSourceExcerpt(relativePath);
        const end = Math.min(source.text.length, 4_000, remainingSourceChars);
        if (end <= 0) continue;
        sourceContext.push({
          sourceRef: `${source.relativePath}#sha256=${source.contentHash}&chars=0-${end}`,
          text: source.text.slice(0, end),
        });
        remainingSourceChars -= end;
      }
      const scan = await runBlockScan(
        {
          documentId,
          revision: doc.revision,
          blocks,
          harnessId: opts?.harnessId,
          instruction: opts?.instruction,
          selectionText: opts?.selectionText,
          selectionStart: opts?.selectionStart,
          operation: opts?.operation,
          targetLanguage: opts?.targetLanguage,
          tableCell: opts?.tableCell,
          sourceContext,
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
      patch({
        status: "done",
        proposalIds,
        commentCount: scan.comments?.length ?? 0,
        engine: scan.engine,
        preferredEngine: "pi",
        fallbackFrom: scan.fallbackFrom,
        fallbackReason: scan.fallbackReason,
        notes: scan.notes,
        phase: scan.steps?.at(-1) ?? "完成",
        steps: scan.steps,
        citeDisclaimer:
          "cite_check 仅检查引用形态，未验证文献存在性、真实性或内容支持关系。",
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
      operation?: ProposalOperationKind;
      targetLanguage?: ProposalTargetLanguage;
      tableCell?: { row: number; column: number; address: string; before: string };
      sourcePaths?: string[];
      preferSimple?: boolean;
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
    const harness = getHarness();
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
        maxTurns: 12,
      },
      review: {
        threads: state.reviewThreads.filter(
          (thread) => thread.documentId === state.agent.bag.documentId,
        ),
      },
    };
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
          };
      model?: string;
      apiKey?: string;
      baseURL?: string;
      authStyle?: "bearer" | "apikey";
      harnessId?: string | null;
    };
  }>("/api/v1/settings/llm", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const body = req.body ?? {};
    try {
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

  app.get("/api/v1/harnesses", async (req) => {
    requireAuth(state, req.headers.authorization);
    return {
      harnesses: listHarnesses().map((h) => ({ id: h.id, title: h.title })),
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

  app.post<{ Body: { relativePath: string } }>("/api/v1/documents/open", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const relativePath = req.body?.relativePath;
    if (!relativePath) return reply.code(400).send({ error: "relativePath required" });
    try {
      return await enqueueChat(async () => {
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

  app.post<{ Body: { relativePath: string } }>("/api/v1/documents/import-docx", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const relativePath = req.body?.relativePath;
    if (!relativePath) return reply.code(400).send({ error: "relativePath required" });
    try {
      return await enqueueChat(async () => {
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
        "cite_check 仅检查引用形态，未验证文献存在性、真实性或内容支持关系。",
    };
  });

  app.post<{
    Params: { id: string };
    Body: {
      blockIds?: string[];
      harnessId?: string;
      instruction?: string;
      selectionText?: string;
      selectionStart?: number;
      operation?: ProposalOperationKind;
      targetLanguage?: ProposalTargetLanguage;
      tableCell?: { row: number; column: number; address: string; before: string };
      sourcePaths?: string[];
      preferSimple?: boolean;
    };
  }>("/api/v1/documents/:id/proposal-runs", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const documentId = req.params.id;
    const blocks = listBlocks(workspace, documentId);
    const selected =
      req.body?.blockIds?.length
        ? blocks.filter((b) => req.body.blockIds!.includes(b.id))
        : blocks.slice(0, 8);
    if (!selected.length) return reply.code(400).send({ error: "no blocks" });
    if (selected.length > 12) {
      return reply.code(400).send({ error: "select at most 12 blocks per scan" });
    }

    const instruction =
      typeof req.body?.instruction === "string"
        ? req.body.instruction.trim().slice(0, 600)
        : undefined;
    const selectionText = typeof req.body?.selectionText === "string"
      ? req.body.selectionText
      : undefined;
    if (selectionText && selectionText.length > 6_000) {
      return reply.code(413).send({ error: "选区超过 6000 字符，请缩小选区后重试；Margin 不会静默截断正文。" });
    }
    const selectionStart = Number.isInteger(req.body?.selectionStart) && req.body!.selectionStart! >= 0
      ? req.body!.selectionStart
      : undefined;
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
        harnessId: req.body?.harnessId,
        instruction: instruction || undefined,
        selectionText: selectionText?.trim() ? selectionText : undefined,
        selectionStart,
        operation,
        targetLanguage,
        tableCell,
        sourcePaths,
        preferSimple: req.body?.preferSimple ?? false,
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

  app.put<{ Body: { sourcePaths?: string[] } }>("/api/v1/session/sources", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    try {
      await enqueueChat(async () => {
        replaceAttachedSources(state.agent, workspace, req.body?.sourcePaths ?? []);
        persistSession();
      });
      return { sourcePaths: state.agent.sourcePaths };
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
    try {
      getProposal(workspace, req.params.id);
      const decision = saveDecision(
        workspace,
        req.params.id,
        req.body.kind,
        req.body.editedText,
        req.body.reason,
      );
      return { decision };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { expectedRevision: number; expectedHash: string; proposalIds?: string[] };
  }>("/api/v1/documents/:id/apply", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
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
    persistSession();
    return result;
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/:id/exports", async (req) => {
    requireAuth(state, req.headers.authorization);
    return exportPacket(workspace, req.params.id);
  });

  app.get("/api/v1/chat/history", async (req) => {
    requireAuth(state, req.headers.authorization);
    return {
      turns: state.chat.list(),
      maxTurns: 12,
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
      state.chat.clear();
      clearChatAgentConversation(state.agent);
      persistSession();
    });
    return {
      ok: true,
      documentId: state.agent.bag.documentId,
      sourcePaths: state.agent.sourcePaths,
    };
  });

  app.get("/api/v1/extensions/skills", async (req) => {
    requireAuth(state, req.headers.authorization);
    const skillsRoot = path.join(workspacePath, ".margin", "skills");
    return {
      skills: listAvailableSkills(skillsRoot).map((skill) => ({
        name: skill.name,
        description: skill.description,
        contentHash: skill.contentHash,
        source: skill.source ?? "bundled",
      })),
    };
  });

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
    let claimed = false;
    let applied = false;
    try {
      const proposal = getProposal(workspace, req.params.id);
      if (req.body.documentId !== proposal.documentId) {
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
      persistSession();
      return { ...result, decision };
    } catch (error) {
      if (claimed && !applied) reopenProposal(workspace, req.params.id);
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
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
    };
  }>("/api/v1/chat", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const message = (req.body?.message ?? "").trim();
    if (!message) return reply.code(400).send({ error: "message required" });
    const threadId = req.body?.threadId?.trim();
    if (req.body?.threadId !== undefined && (!threadId || threadId.length > 200)) {
      return reply.code(400).send({ error: "invalid threadId" });
    }
    const clearRequested = /^(清空对话|清除对话|新会话|reset\s*chat)(?:。|！|!)?$/i.test(message);
    const closeRequested = isCloseDocumentRequest(message);

    try {
      const outcome = await enqueueChat(async () => {
        if (clearRequested) {
          state.chat.clear();
          clearChatAgentConversation(state.agent);
          persistSession();
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
          harnessId: req.body.harnessId,
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
        fallbackFrom: turn.fallbackFrom,
        notes: turn.notes,
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
    };
  }>("/api/v1/chat/stream", async (req, reply) => {
    requireAuth(state, req.headers.authorization);
    const message = (req.body?.message ?? "").trim();
    if (!message) return reply.code(400).send({ error: "message required" });
    const threadId = req.body?.threadId?.trim();
    if (req.body?.threadId !== undefined && (!threadId || threadId.length > 200)) {
      return reply.code(400).send({ error: "invalid threadId" });
    }
    const clearRequested = /^(清空对话|清除对话|新会话|reset\s*chat)(?:。|！|!)?$/i.test(message);
    const closeRequested = isCloseDocumentRequest(message);

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

    try {
      if (!clearRequested) send({ type: "status", text: "正在处理…" });
      let streamed = false;
      const outcome = await enqueueChat(async () => {
        if (ac.signal.aborted) return { disconnected: true as const };
        if (clearRequested) {
          state.chat.clear();
          clearChatAgentConversation(state.agent);
          persistSession();
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
          harnessId: req.body.harnessId,
          threadId,
          signal: ac.signal,
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
        fallbackFrom: turn.fallbackFrom,
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
    return reply.sendFile("index.html", staticRoot);
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
