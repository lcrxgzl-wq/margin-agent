import { randomUUID } from "node:crypto";
import { type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  TableCellProposalDraftSchema,
  type BlockSnapshot,
  type RiskLevel,
  type TableCellProposalDraft,
} from "@margin/domain";
import {
  assertCanProposeBlock,
  createCascadeGate,
  normalizeCascadeOffer,
  noteCascadePropose,
  type CascadeGate,
  type ProposeScope,
} from "./cascade.js";
import { buildOutline, searchBlocks } from "./outline.js";
import { assemblePaperTools } from "./packs/registry.js";
import type { AgentComment, PaperAgentResult } from "./types.js";

export type Draft = PaperAgentResult["proposals"][number];

const MAX_PROPOSALS = 30;
const MAX_COMMENTS = 40;

export type PaperToolContext = {
  /** Full open document (read tools + propose lookup). */
  getBlocks: () => BlockSnapshot[];
  getDocumentId: () => string;
  getRevision: () => number;
  /** Scan primary targets / session selection / confirmed cascade. */
  proposeScope?: ProposeScope;
  /** Shared gate mutated by outline/search/offer tools. */
  cascadeGate?: CascadeGate;
  /** Host collects offer_cascade results. */
  onCascadeOffer?: (candidates: ReturnType<typeof normalizeCascadeOffer>) => void;
  /** Material paths attached by the host; only these may back proposal evidence. */
  sourcePaths?: string[];
  /** Exact sourceRefs returned by read_workspace_file during this turn. */
  getReadSourceRefs?: () => string[];
  /** Scan loops may stop as soon as every explicitly selected block has one proposal. */
  terminateWhenPrimaryCovered?: boolean;
  /** Host-owned structured lookup. Omit it while table cells are only available as flattened text. */
  getTableCell?: (
    blockId: string,
    row: number,
    column: number,
  ) => { address: string; text: string } | undefined | Promise<{ address: string; text: string } | undefined>;
  /** Host collector for review-only cell patches. These drafts are never added to block proposals. */
  onTableCellProposal?: (proposal: TableCellProposalDraft) => void;
};

function normalizeSourcePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeEvidenceRefs(
  evidence: unknown,
  sourcePaths: string[],
  readSourceRefs?: string[],
): string[] {
  if (evidence == null) return [];
  if (!Array.isArray(evidence)) throw new Error("evidence must be an array");
  const allowed = [...new Set(sourcePaths.map(normalizeSourcePath).filter(Boolean))];
  const refs = evidence
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  const invalid = refs.filter(
    (ref) =>
      !allowed.some(
        (sourcePath) =>
          ref === sourcePath || ref.startsWith(`${sourcePath}#`),
      ),
  );
  if (invalid.length) {
    throw new Error(
      `Evidence must reference an attached sourcePath: ${invalid.join(", ")}`,
    );
  }
  if (readSourceRefs) {
    const read = new Set(readSourceRefs.map((ref) => ref.trim().replace(/\\/g, "/")));
    const unread = refs.filter((ref) => !read.has(ref));
    if (unread.length) {
      throw new Error(
        `Evidence must use a sourceRef returned by read_workspace_file in this turn: ${unread.join(", ")}`,
      );
    }
  }
  return [...new Set(refs)];
}

function scopeOf(ctx: PaperToolContext): ProposeScope {
  return {
    ...ctx.proposeScope,
    gate: ctx.cascadeGate ?? ctx.proposeScope?.gate,
  };
}

function normalizedRisk(value: unknown): RiskLevel | undefined {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return undefined;
  if (["language", "语言", "style", "wording", "clarity"].includes(key)) return "language";
  if (["structure", "结构", "organization", "organisation"].includes(key)) return "structure";
  if (["argument", "论证", "argumentation", "logic", "reasoning", "content"].includes(key)) return "argument";
  if (["fact", "事实", "factual", "citation", "evidence"].includes(key)) return "fact";
  return undefined;
}

function normalizedSeverity(value: unknown): "info" | "warn" | undefined {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return undefined;
  if (["warn", "warning", "error", "high", "警告", "风险"].includes(key)) return "warn";
  if (["info", "note", "suggestion", "low", "提示", "建议"].includes(key)) return "info";
  return undefined;
}

function parseOoxmlBodyAddress(blockId: string): { kind: "p" | "t"; bodyIndex: number } | null {
  const match = /^ooxml-([pt])-(\d+)-/.exec(blockId);
  if (!match) return null;
  return { kind: match[1] as "p" | "t", bodyIndex: Number(match[2]) };
}

function blocksAtOoxmlBodyIndex(
  blocks: BlockSnapshot[],
  kind: "p" | "t",
  bodyIndex: number,
): BlockSnapshot[] {
  const prefix = `ooxml-${kind}-${bodyIndex}-`;
  return blocks.filter((block) => block.id.startsWith(prefix));
}

function nearestOoxmlBlockIds(
  blocks: BlockSnapshot[],
  kind: "p" | "t",
  bodyIndex: number,
  limit = 5,
): string[] {
  const scored = blocks
    .map((block) => {
      const address = parseOoxmlBodyAddress(block.id);
      if (!address || address.kind !== kind) return null;
      return { id: block.id, dist: Math.abs(address.bodyIndex - bodyIndex) };
    })
    .filter((row): row is { id: string; dist: number } => row != null)
    .sort((a, b) => a.dist - b.dist || a.id.localeCompare(b.id));
  const ids: string[] = [];
  for (const row of scored) {
    if (!ids.includes(row.id)) ids.push(row.id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/** Exact id, else unique ooxml-{p|t}-{bodyIndex}-* remap when hash suffix went stale. */
export function resolveBlockSnapshot(
  blocks: BlockSnapshot[],
  blockId: string,
  opts?: { remapByBodyIndex?: boolean; byId?: Map<string, BlockSnapshot> },
): { block: BlockSnapshot; remappedFrom?: string } {
  const exact = opts?.byId?.get(blockId) ?? blocks.find((block) => block.id === blockId);
  if (exact) return { block: exact };
  const remap = opts?.remapByBodyIndex !== false;
  const address = parseOoxmlBodyAddress(blockId);
  if (remap && address) {
    const matches = blocksAtOoxmlBodyIndex(blocks, address.kind, address.bodyIndex);
    if (matches.length === 1) {
      return { block: matches[0]!, remappedFrom: blockId };
    }
  }
  throw unknownBlockIdError(blocks, blockId);
}

export function unknownBlockIdError(blocks: BlockSnapshot[], blockId: string): Error {
  const address = parseOoxmlBodyAddress(blockId);
  let hint = "Call list_blocks or search_blocks for current ids; do not invent ooxml-* ids.";
  if (address) {
    const matches = blocksAtOoxmlBodyIndex(blocks, address.kind, address.bodyIndex);
    if (matches.length === 1) {
      hint = `Current id at body index ${address.bodyIndex} is ${matches[0]!.id}. ${hint}`;
    } else if (matches.length > 1) {
      hint = `Ambiguous body index ${address.bodyIndex}: ${matches.map((block) => block.id).join(", ")}. ${hint}`;
    } else {
      const near = nearestOoxmlBlockIds(blocks, address.kind, address.bodyIndex);
      hint = near.length
        ? `No current block at ooxml-${address.kind}-${address.bodyIndex}-*. Nearest: ${near.join(", ")}. ${hint}`
        : `No ooxml-${address.kind}-* blocks in the open document. ${hint}`;
    }
  } else if (blocks.length) {
    const sample = blocks.slice(0, 5).map((block) => block.id).join(", ");
    hint = `Sample current ids: ${sample}. ${hint}`;
  }
  return new Error(`Unknown blockId: ${blockId}. ${hint}`);
}

/**
 * Paper tools only — no bash / arbitrary FS / apply / persist.
 * Drafts/comments stay in-memory until host persists.
 */
export function createCorePaperTools(
  ctx: PaperToolContext,
  drafts: Draft[],
  comments: AgentComment[],
): AgentTool[] {
  let indexedBlocks: BlockSnapshot[] | null = null;
  let indexedFingerprint = "";
  let blockById = new Map<string, BlockSnapshot>();
  const blocksFingerprint = (blocks: BlockSnapshot[]): string =>
    `${blocks.length}:${blocks[0]?.id ?? ""}:${blocks[blocks.length - 1]?.id ?? ""}:${blocks[0]?.contentHash ?? ""}`;
  const getBlockIndex = (blocks: BlockSnapshot[]): Map<string, BlockSnapshot> => {
    const fingerprint = blocksFingerprint(blocks);
    // bag.blocks is source of truth; rebuild when the array is replaced OR reindexed in place.
    if (indexedBlocks !== blocks || indexedFingerprint !== fingerprint) {
      indexedBlocks = blocks;
      indexedFingerprint = fingerprint;
      blockById = new Map(blocks.map((block) => [block.id, block]));
    }
    return blockById;
  };
  const requireDoc = () => {
    const blocks = ctx.getBlocks();
    const documentId = ctx.getDocumentId();
    if (!documentId || !blocks.length) {
      throw new Error("No document open. Call open_document first.");
    }
    return { blocks, documentId, revision: ctx.getRevision() };
  };

  const outlineTool: AgentTool = {
    name: "get_document_outline",
    label: "Document Outline",
    description: "Heading outline with blockId, level, title. Read-only. Full document.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => {
      const { blocks } = requireDoc();
      if (ctx.cascadeGate) ctx.cascadeGate.outlineCalled = true;
      const outline = buildOutline(blocks);
      return {
        content: [{ type: "text", text: JSON.stringify(outline) }],
        details: { count: outline.length },
      };
    },
  };

  const listBlocksTool: AgentTool = {
    name: "list_blocks",
    label: "List Blocks",
    description: "List blocks with id, kind, short preview. Read-only. Full document.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => {
      const { blocks } = requireDoc();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              blocks.map((b) => ({
                id: b.id,
                kind: b.kind,
                preview: b.text.slice(0, 160),
              })),
            ),
          },
        ],
        details: { count: blocks.length },
      };
    },
  };

  const getBlockTool: AgentTool = {
    name: "get_block",
    label: "Get Block",
    description:
      "Full text of one block. Read-only. Stale ooxml-*-{bodyIndex}-* ids remap to the unique current block at that body index.",
    parameters: Type.Object({
      blockId: Type.String({ description: "Block id from list_blocks / outline (current open document)" }),
    }),
    executionMode: "sequential",
    execute: async (_id, raw) => {
      const { blocks } = requireDoc();
      const byId = getBlockIndex(blocks);
      const params = raw as { blockId: string };
      const requested = String(params.blockId);
      const { block, remappedFrom } = resolveBlockSnapshot(blocks, requested, { byId });
      const payload = remappedFrom
        ? {
            ...block,
            resolvedFrom: remappedFrom,
            note: "Stale blockId remapped by body index; use id for subsequent tools.",
          }
        : block;
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: { blockId: block.id, remappedFrom: remappedFrom ?? null },
      };
    },
  };

  const searchTool: AgentTool = {
    name: "search_blocks",
    label: "Search Blocks",
    description:
      "Case-sensitive substring search across the full document. Returns up to limit hits (default 20, max 50). Read-only.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    executionMode: "sequential",
    execute: async (_id, raw) => {
      const { blocks } = requireDoc();
      if (ctx.cascadeGate) ctx.cascadeGate.searchCalled = true;
      const params = raw as { query: string; limit?: number };
      const hits = searchBlocks(blocks, String(params.query ?? ""), params.limit ?? 20);
      return {
        content: [{ type: "text", text: JSON.stringify(hits) }],
        details: { count: hits.length },
      };
    },
  };

  const offerCascadeTool: AgentTool = {
    name: "offer_cascade",
    label: "Offer Cascade Targets",
    description:
      "After outline+search, list up to 5 related blocks that may need consistency edits. Does not propose; host asks the user to confirm.",
    parameters: Type.Object({
      candidates: Type.Array(
        Type.Object({
          blockId: Type.String(),
          reason: Type.String({ description: "One Chinese sentence why related" }),
          query: Type.Optional(Type.String()),
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_id, raw) => {
      const { blocks } = requireDoc();
      const params = raw as { candidates?: unknown };
      const candidates = normalizeCascadeOffer(params.candidates, blocks);
      if (ctx.cascadeGate) ctx.cascadeGate.offered = candidates;
      ctx.onCascadeOffer?.(candidates);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              count: candidates.length,
              candidates,
              hint: "等待用户确认「一并改」或「仅本地」；确认前不要对选区外 block 调用 propose_*。",
            }),
          },
        ],
        details: { count: candidates.length },
      };
    },
  };

  const proposeTool: AgentTool = {
    name: "propose_block_edit",
    label: "Propose Block Edit",
    description:
      "Propose full replacement for one existing block (session draft only; does not apply or persist). Out-of-selection requires user-confirmed cascade targets. Evidence may only use attached source paths/sourceRef values returned by read_workspace_file.",
    parameters: Type.Object({
      blockId: Type.String(),
      after: Type.String({ description: "Full replacement markdown" }),
      rationale: Type.String({ description: "One Chinese sentence" }),
      risk: Type.Optional(
        Type.Union([
          Type.Literal("language"),
          Type.Literal("structure"),
          Type.Literal("argument"),
          Type.Literal("fact"),
        ]),
      ),
      evidence: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Exact sourceRef returned by read_workspace_file in this turn",
          }),
        ),
      ),
    }),
    prepareArguments: (raw) => {
      const params = raw && typeof raw === "object" ? { ...raw as Record<string, unknown> } : {};
      const risk = normalizedRisk(params.risk);
      if (risk) params.risk = risk;
      else delete params.risk;
      return params as never;
    },
    executionMode: "sequential",
    execute: async (_id, raw) => {
      const { blocks, documentId, revision } = requireDoc();
      const byId = getBlockIndex(blocks);
      const params = raw as {
        blockId: string;
        after: string;
        rationale: string;
        risk?: RiskLevel;
        evidence?: string[];
      };
      if (drafts.length >= MAX_PROPOSALS) {
        throw new Error(`proposal cap ${MAX_PROPOSALS} reached`);
      }
      const requestedBlockId = String(params.blockId);
      const resolved = resolveBlockSnapshot(blocks, requestedBlockId, { byId });
      const block = resolved.block;
      const blockId = block.id;
      if (block.kind === "table") {
        throw new Error("Full-table text replacement is forbidden; use propose_table_cell_edit with a Host cell resolver");
      }
      assertCanProposeBlock(blockId, scopeOf(ctx));
      const after = String(params.after ?? "").trim();
      const rationale = String(params.rationale ?? "").trim();
      if (!after) throw new Error("after is empty");
      if (!rationale) throw new Error("rationale is empty");
      const existing = drafts.find((draft) => draft.blockId === blockId);
      const primaryTargets = ctx.proposeScope?.primaryAllowlist ?? [];
      const primaryCovered = () =>
        !!ctx.terminateWhenPrimaryCovered &&
        primaryTargets.length > 0 &&
        primaryTargets.every((target) => drafts.some((draft) => draft.blockId === target));
      if (existing) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              duplicate: true,
              blockId,
              proposalCount: drafts.length,
              hint: "该块已有提案；请改审其他块，或调用 finish_turn。",
            }),
          }],
          details: { blockId, duplicate: true },
          terminate: primaryCovered(),
        };
      }
      drafts.push({
        schemaVersion: 1,
        documentId,
        blockId,
        baseRevision: revision,
        baseHash: block.contentHash,
        before: block.text,
        after,
        rationale,
        risk: normalizedRisk(params.risk) ?? "language",
        evidence: normalizeEvidenceRefs(
          params.evidence,
          ctx.sourcePaths ?? [],
          ctx.getReadSourceRefs?.(),
        ),
      });
      noteCascadePropose(scopeOf(ctx), blockId);
      const terminate = primaryCovered();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, blockId, proposalCount: drafts.length }),
          },
        ],
        details: { blockId },
        terminate,
      };
    },
  };

  const proposedTableCells = new Set<string>();
  const tableCellTool: AgentTool | null = ctx.getTableCell && ctx.onTableCellProposal
    ? {
        name: "propose_table_cell_edit",
        label: "Propose Table Cell Edit",
        description:
          "Propose one review-only table cell patch. Requires exact A1 address, one-based row/column, and current cell text. Never replaces the flattened table block and never applies or persists by itself.",
        parameters: Type.Object({
          blockId: Type.String(),
          address: Type.String({ description: "A1 address, for example B3" }),
          row: Type.Integer({ minimum: 1, description: "One-based row" }),
          column: Type.Integer({ minimum: 1, description: "One-based column" }),
          before: Type.String({ description: "Exact current cell text" }),
          after: Type.String({ description: "Proposed replacement for this cell only" }),
          rationale: Type.String({ description: "One Chinese sentence" }),
          risk: Type.Optional(Type.Union([
            Type.Literal("language"),
            Type.Literal("structure"),
            Type.Literal("argument"),
            Type.Literal("fact"),
          ])),
          evidence: Type.Optional(Type.Array(Type.String())),
        }),
        prepareArguments: (raw) => {
          const params = raw && typeof raw === "object" ? { ...raw as Record<string, unknown> } : {};
          const risk = normalizedRisk(params.risk);
          if (risk) params.risk = risk;
          else delete params.risk;
          return params as never;
        },
        executionMode: "sequential",
        execute: async (_id, raw) => {
          const { blocks, documentId, revision } = requireDoc();
          const params = raw as {
            blockId: string;
            address: string;
            row: number;
            column: number;
            before: string;
            after: string;
            rationale: string;
            risk?: RiskLevel;
            evidence?: string[];
          };
          if (drafts.length + proposedTableCells.size >= MAX_PROPOSALS) {
            throw new Error(`proposal cap ${MAX_PROPOSALS} reached`);
          }
          const byId = getBlockIndex(blocks);
          const requestedBlockId = String(params.blockId);
          const resolved = resolveBlockSnapshot(blocks, requestedBlockId, { byId });
          const block = resolved.block;
          const blockId = block.id;
          if (block.kind !== "table") throw new Error("propose_table_cell_edit requires a table block");
          assertCanProposeBlock(blockId, scopeOf(ctx));
          const row = Number(params.row);
          const column = Number(params.column);
          const address = String(params.address ?? "").trim().toUpperCase();
          const current = await ctx.getTableCell!(blockId, row, column);
          if (!current) throw new Error(`Unknown table cell: ${address || `${row}:${column}`}`);
          if (current.address.toUpperCase() !== address) {
            throw new Error("table cell address does not match Host row and column");
          }
          const before = String(params.before ?? "");
          if (current.text !== before) throw new Error("table cell before text is stale");
          const after = String(params.after ?? "");
          if (!after.trim()) throw new Error("table cell after is empty");
          const rationale = String(params.rationale ?? "").trim();
          if (!rationale) throw new Error("rationale is empty");
          const key = `${blockId}:${address}`;
          if (proposedTableCells.has(key)) throw new Error("table cell already has a proposal this turn");
          const proposal = TableCellProposalDraftSchema.parse({
            schemaVersion: 1,
            documentId,
            blockId,
            baseRevision: revision,
            baseHash: block.contentHash,
            applyMode: "host_table_cell_patch",
            cell: { address, row, column, before, after },
            rationale,
            risk: normalizedRisk(params.risk) ?? "language",
            evidence: normalizeEvidenceRefs(
              params.evidence,
              ctx.sourcePaths ?? [],
              ctx.getReadSourceRefs?.(),
            ),
          });
          ctx.onTableCellProposal!(proposal);
          proposedTableCells.add(key);
          noteCascadePropose(scopeOf(ctx), blockId);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                proposal,
                applied: false,
                persisted: false,
                requiresHostReview: true,
              }),
            }],
            details: { blockId, address, applyMode: proposal.applyMode },
          };
        },
      }
    : null;

  const commentTool: AgentTool = {
    name: "propose_block_comment",
    label: "Propose Block Comment",
    description:
      "Add an ephemeral review comment for a block in this run only (host may persist).",
    parameters: Type.Object({
      blockId: Type.String(),
      text: Type.String(),
      severity: Type.Optional(
        Type.Union([Type.Literal("info"), Type.Literal("warn")]),
      ),
    }),
    prepareArguments: (raw) => {
      const params = raw && typeof raw === "object" ? { ...raw as Record<string, unknown> } : {};
      const severity = normalizedSeverity(params.severity);
      if (severity) params.severity = severity;
      else delete params.severity;
      return params as never;
    },
    executionMode: "sequential",
    execute: async (_id, raw) => {
      const { blocks } = requireDoc();
      const byId = getBlockIndex(blocks);
      const params = raw as {
        blockId: string;
        text: string;
        severity?: "info" | "warn";
      };
      if (comments.length >= MAX_COMMENTS) {
        throw new Error(`comment cap ${MAX_COMMENTS} reached`);
      }
      const requestedBlockId = String(params.blockId);
      const resolved = resolveBlockSnapshot(blocks, requestedBlockId, { byId });
      const block = resolved.block;
      const blockId = block.id;
      const text = String(params.text ?? "").trim();
      if (!text) throw new Error("text is empty");
      const comment: AgentComment = {
        id: randomUUID(),
        blockId,
        text,
        severity: normalizedSeverity(params.severity) ?? "info",
        source: "agent",
        ephemeral: true,
      };
      comments.push(comment);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, comment }) }],
        details: { commentId: comment.id },
      };
    },
  };

  const finishTool: AgentTool = {
    name: "finish_turn",
    label: "Finish Turn",
    description:
      "End this agent turn after tools. Optional summary becomes part of the user-visible reply. Host persists proposals.",
    parameters: Type.Object({
      summary: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    execute: async (_id, raw) => {
      const params = raw as { summary?: string };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              summary: params.summary ?? "",
              proposalCount: drafts.length + proposedTableCells.size,
              commentCount: comments.length,
            }),
          },
        ],
        details: { summary: params.summary ?? "" },
        terminate: true,
      };
    },
  };

  return [
    outlineTool,
    listBlocksTool,
    getBlockTool,
    searchTool,
    offerCascadeTool,
    proposeTool,
    ...(tableCellTool ? [tableCellTool] : []),
    commentTool,
    finishTool,
  ];
}

export function createPaperTools(
  ctx: PaperToolContext,
  drafts: Draft[],
  comments: AgentComment[],
  opts?: {
    harnessId?: string;
    packId?: string;
    extras?: import("./packs/types.js").PackExtras;
  },
): AgentTool[] {
  const gate = ctx.cascadeGate ?? createCascadeGate();
  const withGate: PaperToolContext = {
    ...ctx,
    cascadeGate: gate,
    proposeScope: {
      ...ctx.proposeScope,
      gate,
    },
  };
  return assemblePaperTools(withGate, drafts, comments, opts);
}

/** @deprecated alias — finish_scan maps to finish_turn for old scan prompts */
export function createScanTools(
  blocks: BlockSnapshot[],
  drafts: Draft[],
  comments: AgentComment[],
  documentId: string,
  revision: number,
): AgentTool[] {
  return createPaperTools(
    {
      getBlocks: () => blocks,
      getDocumentId: () => documentId,
      getRevision: () => revision,
    },
    drafts,
    comments,
  );
}

export { createCascadeGate, assertCanProposeBlock } from "./cascade.js";
export type { CascadeCandidate, CascadeGate, ProposeScope } from "./cascade.js";
