import { type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  contentHash,
  type BlockSnapshot,
  type DocumentMeta,
  type EvidenceCacheEntry,
  type ReviewChecklistRunDraft,
  type TableCellProposalDraft,
} from "@margin/domain";
import {
  getHarness,
  hasCapability,
  loadAvailableSkill,
  type AgentCapability,
} from "@margin/harness";
import { AnalysisRunStore } from "./data/store.js";
import { createCascadeGate, type CascadeCandidate } from "./cascade.js";
import {
  mergeEvidenceCacheEntry,
  normalizeAttachedEvidenceCache,
  removeEvidenceCacheRefs,
} from "./evidence-cache.js";
import {
  createRemoteMcpTools,
  type RemoteMcpApprovalFn,
  type RemoteMcpBridge,
} from "./mcp-tools.js";
import { createPaperTools, type Draft } from "./pi-tools.js";
import type { AgentComment } from "./types.js";

export type SessionDocBag = {
  documentId?: string;
  revision: number;
  relativePath?: string;
  blocks: BlockSnapshot[];
};

export type WorkspaceBridge = {
  skillsRoot?: string;
  listSourceFiles: () => string[];
  readText: (relativePath: string) => Promise<{
    relativePath: string;
    text: string;
    bytes: number;
    versionHash: string;
  }> | {
    relativePath: string;
    text: string;
    bytes: number;
    versionHash: string;
  };
  readVersion: (relativePath: string) => Promise<{
    relativePath: string;
    bytes: number;
    versionHash: string;
  }> | {
    relativePath: string;
    bytes: number;
    versionHash: string;
  };
  writeText: (
    relativePath: string,
    content: string,
  ) => Promise<{ relativePath: string; bytes: number; created: boolean }>;
  openDocument: (relativePath: string) => Promise<{
    document: DocumentMeta;
    blocks: BlockSnapshot[];
  }> | {
    document: DocumentMeta;
    blocks: BlockSnapshot[];
  };
  /** Paths of review-store documents that must not be overwritten via write_workspace_file. */
  listProtectedDocumentPaths?: () => string[];
  readTableCell?: (
    documentId: string,
    blockId: string,
    row: number,
    column: number,
  ) => Promise<{ address: string; text: string } | undefined>;
};

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isProtectedDocumentPath(
  relativePath: string,
  bag: SessionDocBag,
  bridge: WorkspaceBridge,
): boolean {
  const rel = normalizeRel(relativePath);
  if (bag.relativePath && normalizeRel(bag.relativePath) === rel) return true;
  const registered = bridge.listProtectedDocumentPaths?.() ?? [];
  return registered.some((p) => normalizeRel(p) === rel);
}

export type SessionSideEffects = {
  opened?: { document: DocumentMeta; blocks: BlockSnapshot[] };
  written?: { relativePath: string; created: boolean };
  readPath?: string;
  readSourceRefs?: string[];
  loadedSkills?: Array<{ name: string; contentHash: string }>;
  cascadeOffer?: CascadeCandidate[];
  tableCellProposals?: TableCellProposalDraft[];
  reviewChecklists?: ReviewChecklistRunDraft[];
  /** Visible closing text from finish_turn.summary. */
  finishSummary?: string;
};

export type SessionToolOptions = {
  harnessId?: string;
  selectionBlockIds?: string[];
  cascadeConfirmedIds?: string[];
  /** When selection is non-empty, gate out-of-selection proposes. */
  enforceCascadeGate?: boolean;
  /** Confirmed cascade follow-up: skip re-scout for confirmed ids. */
  cascadeUnlocked?: boolean;
  /** Read-only materials explicitly attached to this session turn. */
  sourcePaths?: string[];
  /** Host-owned evidence read cache carried across turns in this session. */
  evidenceCache?: EvidenceCacheEntry[];
  /** Persist the bounded cache after reads or invalidation. */
  onEvidenceCacheChange?: (entries: EvidenceCacheEntry[]) => void;
  /** Apply the selected profile as a hard tool boundary (Pi only). */
  enforceProfile?: boolean;
  /** Exact relative paths explicitly approved by the user for this turn. */
  workspaceWriteApprovedPaths?: string[];
  /** Persistently disabled Skills: load_skill rejects them visibly. */
  disabledSkills?: string[];
  /** Remote MCP bridge + per-call approval (chat path only; scan passes none). */
  remoteMcp?: { bridge: RemoteMcpBridge; requestApproval: RemoteMcpApprovalFn };
};

const DEFAULT_SOURCE_CHUNK_CHARS = 6_000;
const MAX_SOURCE_CHUNK_CHARS = 12_000;

function normalizeSourcePath(relativePath: string): string {
  return normalizeRel(relativePath.trim());
}

/** Full Margin agent tool surface: workspace + paper (no apply). */
export function createSessionTools(
  bridge: WorkspaceBridge,
  bag: SessionDocBag,
  drafts: Draft[],
  comments: AgentComment[],
  effects: SessionSideEffects,
  harnessIdOrOpts?: string | SessionToolOptions,
): AgentTool[] {
  const opts: SessionToolOptions =
    typeof harnessIdOrOpts === "string" || harnessIdOrOpts == null
      ? { harnessId: harnessIdOrOpts }
      : harnessIdOrOpts;
  const harnessId = opts.harnessId;
  const profile = getHarness(harnessId);
  const permits = (capability: AgentCapability) =>
    !opts.enforceProfile || hasCapability(profile, capability);
  const selectionBlockIds = (opts.selectionBlockIds ?? []).filter(Boolean);
  const cascadeConfirmedIds = (opts.cascadeConfirmedIds ?? []).filter(Boolean);
  const enforceCascadeGate =
    opts.enforceCascadeGate ?? (selectionBlockIds.length > 0 || cascadeConfirmedIds.length > 0);
  const cascadeUnlocked = opts.cascadeUnlocked ?? cascadeConfirmedIds.length > 0;
  const sourcePaths = [
    ...new Set((opts.sourcePaths ?? []).map(normalizeSourcePath).filter(Boolean)),
  ];
  let evidenceCache = normalizeAttachedEvidenceCache(opts.evidenceCache ?? [], sourcePaths);
  const publishEvidenceCache = (entries: EvidenceCacheEntry[]) => {
    evidenceCache = entries;
    opts.onEvidenceCacheChange?.([...entries]);
  };
  const invalidateEvidencePath = (relativePath: string) => {
    const refs = evidenceCache
      .filter((entry) => entry.relativePath === relativePath)
      .map((entry) => entry.sourceRef);
    publishEvidenceCache(removeEvidenceCacheRefs(evidenceCache, refs));
  };
  const validateEvidenceRefs = async (refs: string[]) => {
    const currentTurnRefs = new Set(effects.readSourceRefs ?? []);
    const probedVersions = new Map<string, string>();
    for (const ref of refs) {
      if (currentTurnRefs.has(ref)) continue;
      const entry = evidenceCache.find((candidate) => candidate.sourceRef === ref);
      if (!entry) {
        throw new Error(
          "Evidence must use a sourceRef returned by read_workspace_file in this turn or retained in this session: " + ref,
        );
      }
      try {
        let currentVersion = probedVersions.get(entry.relativePath);
        if (!currentVersion) {
          const current = await bridge.readVersion(entry.relativePath);
          if (normalizeSourcePath(current.relativePath) !== entry.relativePath) {
            throw new Error("source path changed");
          }
          currentVersion = current.versionHash;
          probedVersions.set(entry.relativePath, currentVersion);
        }
        if (currentVersion !== entry.versionHash) {
          throw new Error("source bytes changed");
        }
      } catch {
        invalidateEvidencePath(entry.relativePath);
        throw new Error("Evidence sourceRef is stale; read_workspace_file again: " + ref);
      }
    }
  };
  const approvedWritePaths = new Set(
    (opts.workspaceWriteApprovedPaths ?? []).map((item) => normalizeRel(item.trim())),
  );
  const cascadeGate = createCascadeGate();
  const readCache = new Map<
    string,
    { relativePath: string; text: string; bytes: number; versionHash: string }
  >();
  const sourceHashCache = new Map<string, string>();
  const listFiles: AgentTool = {
    name: "list_workspace_files",
    label: "List Workspace Files",
    description:
      "List Markdown, text, CSV, PDF, and DOCX material files in the local workspace. Read-only. Also returns the currently attached sourcePaths.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => {
      const files = bridge.listSourceFiles();
      return {
        content: [
          { type: "text", text: JSON.stringify({ files, sourcePaths }) },
        ],
        details: { count: files.length },
      };
    },
  };

  const readFile: AgentTool = {
    name: "read_workspace_file",
    label: "Read Workspace File",
    description:
      "Read one bounded extracted-text chunk from md/txt/json/csv/pdf/docx inside the workspace. Prefer this for attached sources (pdf/csv) or closed files. For an already-open document, prefer get_document_outline + get_block/search_blocks instead of paging the whole file by offset. Read-only. Continue with nextOffset while hasMore is true; use sourceRef verbatim in propose_block_edit / propose_text_patch evidence.",
    parameters: Type.Object({
      relativePath: Type.String(),
      offset: Type.Optional(
        Type.Number({ description: "Character offset, default 0" }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Maximum characters for this chunk, default ${DEFAULT_SOURCE_CHUNK_CHARS}, capped at ${MAX_SOURCE_CHUNK_CHARS}`,
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_id, raw) => {
      const params = raw as {
        relativePath: string;
        offset?: number;
        limit?: number;
      };
      const requestedPath = normalizeSourcePath(String(params.relativePath));
      let file = readCache.get(requestedPath);
      if (!file) {
        file = await bridge.readText(requestedPath);
        readCache.set(requestedPath, file);
        readCache.set(normalizeSourcePath(file.relativePath), file);
      }
      const canonicalPath = normalizeSourcePath(file.relativePath);
      let sourceHash = sourceHashCache.get(canonicalPath);
      if (!sourceHash) {
        sourceHash = contentHash(file.text);
        sourceHashCache.set(canonicalPath, sourceHash);
      }
      const rawOffset = Number(params.offset ?? 0);
      if (!Number.isFinite(rawOffset) || rawOffset < 0) {
        throw new Error("offset must be a non-negative number");
      }
      const offset = Math.floor(rawOffset);
      if (offset > file.text.length) {
        throw new Error(`offset ${offset} exceeds file length ${file.text.length}`);
      }
      const rawLimit = Number(params.limit ?? DEFAULT_SOURCE_CHUNK_CHARS);
      if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
        throw new Error("limit must be a positive number");
      }
      const limit = Math.min(MAX_SOURCE_CHUNK_CHARS, Math.floor(rawLimit));
      const nextOffset = Math.min(file.text.length, offset + limit);
      const hasMore = nextOffset < file.text.length;
      const text = file.text.slice(offset, nextOffset);
      const sourceRef = nextOffset > offset
        ? `${canonicalPath}#sha256=${sourceHash}&chars=${offset}-${nextOffset}`
        : undefined;
      if (sourceRef && sourcePaths.includes(canonicalPath)) {
        publishEvidenceCache(mergeEvidenceCacheEntry(evidenceCache, {
          sourceRef,
          relativePath: canonicalPath,
          start: offset,
          end: nextOffset,
          extractedHash: sourceHash,
          versionHash: file.versionHash,
          preview: text.slice(0, 800),
          readAt: new Date().toISOString(),
        }));
      }
      effects.readPath = file.relativePath;
      if (sourceRef) {
        effects.readSourceRefs = [
          ...(effects.readSourceRefs ?? []),
          sourceRef,
        ];
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              relativePath: file.relativePath,
              bytes: file.bytes,
              offset,
              nextOffset,
              hasMore,
              sourceRef: sourceRef ?? null,
              attached: sourcePaths.includes(normalizeSourcePath(file.relativePath)),
              text,
            }),
          },
        ],
        details: { relativePath: file.relativePath },
      };
    },
  };

  const writeFile: AgentTool = {
    name: "write_workspace_file",
    label: "Write Workspace File",
    description:
      "Create a new text file (md/txt/json/csv) or overwrite non-canonical notes/data. Cannot overwrite the open document or any registered paper — use propose_block_edit for those.",
    parameters: Type.Object({
      relativePath: Type.String(),
      content: Type.String(),
    }),
    executionMode: "sequential",
    execute: async (_id, raw) => {
      const params = raw as { relativePath: string; content: string };
      const relativePath = String(params.relativePath);
      if (opts.enforceProfile && !approvedWritePaths.has(normalizeRel(relativePath))) {
        throw new Error(`Workspace write was not approved for "${normalizeRel(relativePath)}"`);
      }
      if (isProtectedDocumentPath(relativePath, bag, bridge)) {
        throw new Error(
          `Refused to overwrite canonical document "${normalizeRel(relativePath)}". Use propose_block_edit; Host Accept applies.`,
        );
      }
      const result = await bridge.writeText(
        relativePath,
        String(params.content ?? ""),
      );
      const canonicalWritten = normalizeSourcePath(result.relativePath);
      readCache.delete(canonicalWritten);
      readCache.delete(normalizeSourcePath(relativePath));
      sourceHashCache.delete(canonicalWritten);
      invalidateEvidencePath(canonicalWritten);
      effects.written = {
        relativePath: canonicalWritten,
        created: result.created,
      };
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }) }],
        details: result,
      };
    },
  };

  const openDoc: AgentTool = {
    name: "open_document",
    label: "Open Document",
    description:
      "Open a Markdown or DOCX document into the editor session so paper tools can run. Does not apply edits.",
    parameters: Type.Object({
      relativePath: Type.String(),
    }),
    executionMode: "sequential",
    execute: async (_id, raw) => {
      const params = raw as { relativePath: string };
      const opened = await bridge.openDocument(String(params.relativePath));
      bag.documentId = opened.document.id;
      bag.revision = opened.document.revision;
      bag.relativePath = opened.document.relativePath;
      bag.blocks = opened.blocks;
      const canonicalOpened = normalizeSourcePath(opened.document.relativePath);
      readCache.delete(canonicalOpened);
      readCache.delete(normalizeSourcePath(String(params.relativePath)));
      sourceHashCache.delete(canonicalOpened);
      invalidateEvidencePath(canonicalOpened);
      effects.opened = opened;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              relativePath: opened.document.relativePath,
              documentId: opened.document.id,
              revision: opened.document.revision,
              blockCount: opened.blocks.length,
            }),
          },
        ],
        details: { documentId: opened.document.id },
      };
    },
  };

  const loadSkill: AgentTool = {
    name: "load_skill",
    label: "Load Skill",
    description:
      "Load an available bundled or workspace writing skill by name (full SKILL.md). Use when the task matches its description.",
    parameters: Type.Object({
      name: Type.String(),
    }),
    executionMode: "sequential",
    execute: async (_id, raw) => {
      const params = raw as { name: string };
      const requested = String(params.name).toLowerCase();
      if ((opts.disabledSkills ?? []).includes(requested)) {
        throw new Error(`Skill 已关闭: ${requested}`);
      }
      const skill = loadAvailableSkill(
        String(params.name),
        bridge.skillsRoot,
        getHarness(harnessId).skills.scope,
      );
      effects.loadedSkills = [
        ...(effects.loadedSkills ?? []),
        { name: skill.name, contentHash: skill.contentHash },
      ];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              name: skill.name,
              contentHash: skill.contentHash,
              body: skill.body,
            }),
          },
        ],
        details: { name: skill.name, contentHash: skill.contentHash },
      };
    },
  };

  const analysisStore = new AnalysisRunStore();

  const paper = createPaperTools(
    {
      getBlocks: () => bag.blocks,
      getDocumentId: () => bag.documentId ?? "",
      getRevision: () => bag.revision,
      cascadeGate,
      proposeScope: {
        selectionBlockIds,
        cascadeConfirmedIds,
        enforceCascadeGate,
        cascadeUnlocked,
        gate: cascadeGate,
      },
      onCascadeOffer: (candidates) => {
        effects.cascadeOffer = candidates;
      },
      ...(bridge.readTableCell && bag.documentId
        ? {
            getTableCell: (blockId: string, row: number, column: number) =>
              bridge.readTableCell!(bag.documentId!, blockId, row, column),
            onTableCellProposal: (proposal: TableCellProposalDraft) => {
              effects.tableCellProposals = [...(effects.tableCellProposals ?? []), proposal];
            },
          }
        : {}),
      sourcePaths,
      getReadSourceRefs: () => effects.readSourceRefs ?? [],
      validateEvidenceRefs,
      onFinishSummary: (summary) => {
        effects.finishSummary = summary;
      },
      onReviewChecklistRun: (draft) => {
        const runs = effects.reviewChecklists ?? [];
        const index = runs.findIndex((entry) =>
          entry.run.documentId === draft.run.documentId &&
          entry.run.checker === draft.run.checker,
        );
        if (index < 0) {
          effects.reviewChecklists = [...runs, draft];
          return;
        }
        const current = runs[index]!;
        const itemKey = (item: ReviewChecklistRunDraft["items"][number]) =>
          [item.blockId, item.issueType, item.excerpt, item.detail].join("\u0000");
        const seen = new Set(current.items.map(itemKey));
        const incoming = draft.items
          .filter((item) => !seen.has(itemKey(item)))
          .map((item) => ({
            ...item,
            runId: current.run.id,
            documentId: current.run.documentId,
          }));
        effects.reviewChecklists = runs.map((entry, runIndex) => runIndex === index
          ? { ...current, items: [...current.items, ...incoming] }
          : entry);
      },
    },
    drafts,
    comments,
    {
      harnessId,
      extras: {
        readText: (relativePath) => bridge.readText(relativePath),
        analysisStore,
      },
    },
  );

  const workspaceWriteAllowed = permits("workspace.write") &&
    profile.approvals.workspaceWrite === "explicit" && approvedWritePaths.size > 0;
  return [
    ...(permits("workspace.read") ? [listFiles, readFile] : []),
    ...(workspaceWriteAllowed || !opts.enforceProfile ? [writeFile] : []),
    ...(permits("document.open") ? [openDoc] : []),
    ...(permits("skills.load") ? [loadSkill] : []),
    ...(opts.remoteMcp && permits("remote.mcp") && profile.approvals.remoteMcp === "per-call"
      ? createRemoteMcpTools(opts.remoteMcp)
      : []),
    ...paper,
  ];
}
