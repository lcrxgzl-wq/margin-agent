/**
 * Writing agent runtime: pi-agent-core tool loop (default) + explicit offline mode.
 * Uses pi as a generic agent shell — not a coding agent fork.
 * Never forks pi-coding-agent; no bash / arbitrary FS / apply tools.
 */
import { randomUUID } from "node:crypto";
import type { BlockSnapshot, SelectionBlockRange } from "@margin/domain";
import { contentHash, MAX_SELECTION_BLOCKS } from "@margin/domain";
import { generateProposal } from "@margin/llm";
import { getHarness } from "@margin/harness";
import { getHeuristicComments } from "./packs/registry.js";
import { generateDirectProposal } from "./direct-proposal.js";
import { runPiBlockScan } from "./pi-runner.js";
import { hasRuntimeCredentials } from "./resolve-model.js";
import type {
  PaperAgentContext,
  PaperAgentResult,
  ScanProgressHandler,
} from "./types.js";

export type {
  PaperAgentContext,
  PaperAgentResult,
  AgentComment,
  ScanProgressEvent,
  ScanProgressHandler,
  AgentWorkReport,
} from "./types.js";
export { runPiBlockScan, createPaperTools } from "./pi-runner.js";
export { citeCheck, styleLint, heuristicComments } from "./packs/academic.js";
export { academicPack } from "./packs/academic.js";
export { dataAnalysisPack } from "./packs/data-analysis.js";
export {
  assemblePaperTools,
  getHeuristicComments,
  getPack,
} from "./packs/registry.js";
export type { MarginPack, PackExtras } from "./packs/types.js";
export {
  inspectCsv,
  parseCsv,
  runAnalysis,
  formatResultValue,
  parseResultRef,
} from "./data/tabular.js";
export { AnalysisRunStore } from "./data/store.js";
export { buildOutline, searchBlocks } from "./outline.js";
export { toolPhaseLabel, isUserFacingPhase } from "./progress.js";
export { runPiAgentLoop } from "./pi-loop.js";
export { stripLiteralThinkingBlocks } from "./assistant-text.js";
export {
  COMPACTION_SUMMARY_PREFIX,
  createPiSummarizer,
  findLastContextTokens,
  findSafeCutIndex,
  keepRecentTokensForTier,
  orchestrateCompaction,
  pruneToolOutputs,
  PRUNED_TOOL_OUTPUT_PLACEHOLDER,
} from "./compaction.js";
export type {
  CompactionEvent,
  CompactionOutcome,
  CompactionReason,
  ContextTierName,
  SummarizerFn,
} from "./compaction.js";
export { PiLoopFailure } from "./pi-outcome.js";
export type {
  PiLoopOptions,
  PiLoopOutcome,
  PiLoopResult,
  ToolAuditEvent,
} from "./pi-loop.js";
export {
  decideRoute,
  type PolicyDecision,
  type PolicyInput,
} from "./policy/router.js";
export {
  parseOpenIntent,
  parseReadIntent,
  resolveOpenPath,
  unwrapPathToken,
  type OpenIntent,
} from "./policy/open-intent-rule.js";
export {
  runSessionTurn,
  runPiSessionTurn,
  runOfflineSessionTurn,
} from "./session-runner.js";
export { createSessionTools } from "./session-tools.js";
export {
  createRemoteMcpTools,
  namespaceRemoteMcpToolNames,
  boundApprovalArgs,
} from "./mcp-tools.js";
export type {
  RemoteMcpApprovalDecision,
  RemoteMcpApprovalFn,
  RemoteMcpApprovalRequest,
  RemoteMcpBridge,
  RemoteMcpCallableTool,
  RemoteMcpCallResult,
} from "./mcp-tools.js";
export type { SessionTurnResult, SessionTurnInput } from "./session-runner.js";
export { CONTEXT_TIER_PRESETS } from "./session-runner.js";
export type { WorkspaceBridge, SessionDocBag } from "./session-tools.js";
export {
  MAX_CLARIFICATION_ROUNDS,
  buildClarificationHint,
  isEditOrRewriteIntent,
  nextClarificationRound,
  clampClarificationRound,
} from "./clarification.js";
export {
  MAX_CASCADE_CANDIDATES,
  MAX_CASCADE_PROPOSALS_PER_TURN,
  assertCanProposeBlock,
  createCascadeGate,
  formatOutlineHint,
  normalizeCascadeOffer,
} from "./cascade.js";
export type { CascadeCandidate, CascadeGate, ProposeScope } from "./cascade.js";
export { resolveBlockSnapshot, unknownBlockIdError } from "./pi-tools.js";
export type { AgentMessage } from "@earendil-works/pi-agent-core";
export {
  resolveRuntimeModel,
  hasRuntimeCredentials,
  resolveRuntimeApiKey,
} from "./resolve-model.js";

/** Preferred agent engine is always pi; env may force simple. */
export function preferredEngine(): "pi" {
  return "pi";
}

/**
 * Resolve requested engine.
 * Default: pi (agent-first). Explicit MARGIN_ENGINE=simple for tests/offline.
 */
export function resolveEngine(): "pi" | "simple" {
  const v = (process.env.MARGIN_ENGINE ?? "pi").toLowerCase();
  return v === "simple" ? "simple" : "pi";
}

export async function runBlockScan(
  ctx: PaperAgentContext,
  blockIds?: string[],
  onProgress?: ScanProgressHandler,
): Promise<PaperAgentResult> {
  // Explicit one-turn Skill selections are only honored by the single-shot
  // direct path (skills are inlined there); never silently dropped by pi scan.
  if (ctx.preferSimple || ctx.selectedSkills?.length) {
    return runDirectBlockProposal(ctx, blockIds, onProgress);
  }
  const engine = resolveEngine();
  // Decide offline before starting Pi. Once Pi starts, failures are never replayed.
  if (engine !== "simple") {
    if (!hasRuntimeCredentials()) return runSimpleBlockScan(ctx, blockIds, onProgress);
    return runPiBlockScan(ctx, blockIds, onProgress);
  }
  return runSimpleBlockScan(ctx, blockIds, onProgress);
}

async function runDirectBlockProposal(
  ctx: PaperAgentContext,
  blockIds?: string[],
  onProgress?: ScanProgressHandler,
): Promise<PaperAgentResult> {
  const selected = blockIds?.length
    ? ctx.blocks.filter((block) => blockIds.includes(block.id))
    : [];
  if (!selected.length) {
    throw new Error("direct proposal requires at least one selected block");
  }
  if (selected.length > MAX_SELECTION_BLOCKS) {
    throw new Error(`direct proposal supports at most ${MAX_SELECTION_BLOCKS} blocks`);
  }
  const selectionRanges = validateSelectionRanges(ctx, selected);
  if (selected.length > 1) {
    return runDirectMultiBlockProposal(ctx, selected, selectionRanges, onProgress);
  }

  const block = selected[0]!;
  if (block.kind === "table" && !ctx.tableCell) {
    throw new Error("direct table replacement is unsupported; use a Host-backed table cell proposal");
  }
  const steps: string[] = [];
  const emit = (phase: string, detail?: string) => {
    steps.push(phase);
    onProgress?.({ phase, detail });
  };
  emit("读取选中段落", block.id);
  const index = ctx.blocks.findIndex((candidate) => candidate.id === block.id);
  const targetBlock = ctx.tableCell
    ? { ...block, kind: "paragraph" as const, text: ctx.tableCell.before, contentHash: contentHash(ctx.tableCell.before) }
    : block;
  const selectionRange = selectionRanges.get(block.id);
  const output = await generateDirectProposal({
    block: targetBlock,
    neighbors: ctx.blocks.slice(Math.max(0, index - 1), index + 2),
    harnessId: ctx.harnessId,
    instruction: ctx.instruction,
    selectionText: selectionRange?.before ?? ctx.selectionText,
    selectionStart: selectionRange?.start ?? ctx.selectionStart,
    operation: ctx.operation,
    targetLanguage: ctx.targetLanguage,
    sourceContext: ctx.sourceContext,
    workspaceSkillsRoot: ctx.skillsRoot,
    disabledSkills: ctx.disabledSkills,
    selectedSkills: ctx.selectedSkills,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });
  emit("生成修订提案", block.id);

  const proposal: PaperAgentResult["proposals"][number] = {
    schemaVersion: 1,
    documentId: ctx.documentId,
    blockId: block.id,
    baseRevision: ctx.revision,
    baseHash: block.contentHash,
    before: ctx.tableCell?.before ?? block.text,
    after: output.after,
    rationale: output.rationale,
    risk: output.risk,
    evidence: output.evidence,
    operation: ctx.tableCell ? undefined : output.operation,
    tableCell: ctx.tableCell ? { ...ctx.tableCell, after: output.after } : undefined,
  };
  const comments = getHeuristicComments(undefined, ctx.harnessId)?.([block]) ?? [];
  emit("完成（1 处提案）");
  const notes = ctx.selectedSkills?.length && !hasRuntimeCredentials()
    ? [`explicit skills not applied offline (configure a model): ${ctx.selectedSkills.join(", ")}`]
    : undefined;
  return { engine: "simple", proposals: [proposal], comments, steps, notes };
}

function validateSelectionRanges(
  ctx: PaperAgentContext,
  selected: BlockSnapshot[],
): Map<string, SelectionBlockRange> {
  const ranges = ctx.selectionRanges;
  if (!ranges?.length) {
    if (selected.length > 1 && ctx.selectionText?.trim()) {
      throw new Error("cross-block selection requires exact per-block ranges");
    }
    return new Map();
  }
  if (!ctx.selectionText?.length) {
    throw new Error("selection ranges require the exact selected text");
  }
  if (ranges.length !== selected.length) {
    throw new Error("selection ranges must cover every selected block");
  }
  const byId = new Map<string, SelectionBlockRange>();
  for (const [index, block] of selected.entries()) {
    const range = ranges[index];
    if (!range || range.blockId !== block.id || byId.has(range.blockId)) {
      throw new Error("selection ranges must match selected blocks in document order");
    }
    if (
      range.end !== range.start + range.before.length ||
      block.text.slice(range.start, range.end) !== range.before
    ) {
      throw new Error(`selection range does not match immutable block ${block.id}`);
    }
    if (selected.length > 1) {
      const isFirst = index === 0;
      const isLast = index === selected.length - 1;
      if (isFirst && range.end !== block.text.length) {
        throw new Error("the first cross-block range must end at the block boundary");
      }
      if (isLast && range.start !== 0) {
        throw new Error("the last cross-block range must start at the block boundary");
      }
      if (!isFirst && !isLast && (range.start !== 0 || range.end !== block.text.length)) {
        throw new Error("middle cross-block ranges must cover their whole blocks");
      }
    }
    byId.set(range.blockId, range);
  }
  if (ranges.map((range) => range.before).join("") !== ctx.selectionText) {
    throw new Error("selection ranges do not reproduce the exact selected text");
  }
  return byId;
}

/** Cross-paragraph selection: partial edge blocks use precise selection proposals;
 *  fully covered middle blocks may use whole-block proposals. */
async function runDirectMultiBlockProposal(
  ctx: PaperAgentContext,
  selected: BlockSnapshot[],
  selectionRanges: Map<string, SelectionBlockRange>,
  onProgress?: ScanProgressHandler,
): Promise<PaperAgentResult> {
  if (ctx.tableCell) {
    throw new Error("table cell proposals require exactly one table block");
  }
  const steps: string[] = [];
  const emit = (phase: string, detail?: string) => {
    steps.push(phase);
    onProgress?.({ phase, detail });
  };
  emit("读取跨段落选区", `${selected.length} blocks`);
  const proposals: PaperAgentResult["proposals"] = [];
  for (const [i, block] of selected.entries()) {
    if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (block.kind === "table") {
      emit(`跳过表格 ${i + 1}/${selected.length}`, block.id);
      continue;
    }
    emit(`生成修订提案 ${i + 1}/${selected.length}`, block.id);
    const index = ctx.blocks.findIndex((candidate) => candidate.id === block.id);
    const range = selectionRanges.get(block.id);
    const partialRange = range && (range.start !== 0 || range.end !== block.text.length)
      ? range
      : undefined;
    const output = await generateDirectProposal({
      block,
      neighbors: ctx.blocks.slice(Math.max(0, index - 1), index + 2),
      harnessId: ctx.harnessId,
      instruction: ctx.instruction,
      selectionText: partialRange?.before,
      selectionStart: partialRange?.start,
      selectionContext: ctx.selectionText,
      selectionContextChars: ctx.selectionContextChars,
      operation: ctx.operation,
      targetLanguage: ctx.targetLanguage,
      sourceContext: ctx.sourceContext,
      workspaceSkillsRoot: ctx.skillsRoot,
      disabledSkills: ctx.disabledSkills,
      selectedSkills: ctx.selectedSkills,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    proposals.push({
      schemaVersion: 1,
      documentId: ctx.documentId,
      blockId: block.id,
      baseRevision: ctx.revision,
      baseHash: block.contentHash,
      before: block.text,
      after: output.after,
      rationale: output.rationale,
      risk: output.risk,
      evidence: output.evidence,
      operation: output.operation,
    });
  }
  const comments = getHeuristicComments(undefined, ctx.harnessId)?.(selected) ?? [];
  emit(`完成（${proposals.length} 处提案）`);
  const notes = ctx.selectedSkills?.length && !hasRuntimeCredentials()
    ? [`explicit skills not applied offline (configure a model): ${ctx.selectedSkills.join(", ")}`]
    : undefined;
  return { engine: "simple", proposals, comments, steps, notes };
}

export async function runSimpleBlockScan(
  ctx: PaperAgentContext,
  blockIds?: string[],
  onProgress?: ScanProgressHandler,
): Promise<PaperAgentResult> {
  if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const harness = getHarness(ctx.harnessId);
  const selected = blockIds?.length
    ? ctx.blocks.filter((b) => blockIds.includes(b.id))
    : ctx.blocks.slice(0, 20);

  const steps: string[] = [];
  const emit = (phase: string, detail?: string) => {
    steps.push(phase);
    onProgress?.({ phase, detail });
  };
  emit("读取段落");

  const proposals: PaperAgentResult["proposals"] = [];
  for (const [i, block] of selected.entries()) {
    if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (block.kind === "table") {
      emit(`跳过表格 ${i + 1}/${selected.length}`, block.id);
      continue;
    }
    emit(`生成修订草案 ${i + 1}/${selected.length}`, block.id);
    const idx = ctx.blocks.findIndex((b) => b.id === block.id);
    const neighbors = ctx.blocks.slice(Math.max(0, idx - 1), idx + 2);
    const out = await generateProposal({
      block,
      neighbors,
      harnessId: harness.id,
      styleHint: harness.styleHint,
      instruction: ctx.instruction,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    proposals.push({
      schemaVersion: 1,
      documentId: ctx.documentId,
      blockId: block.id,
      baseRevision: ctx.revision,
      baseHash: block.contentHash,
      before: block.text,
      after: out.after,
      rationale: out.rationale,
      risk: out.risk,
      evidence: out.evidence,
    });
  }

  emit("整理侧注");
  const comments = getHeuristicComments(undefined, ctx.harnessId)?.(selected) ?? [];
  emit(`完成（${proposals.length} 处提案）`);

  return { engine: "simple", proposals, comments, steps };
}

export function createPaperAgentAdapter() {
  return {
    id: "margin-paper-agent",
    version: "0.1.0",
    notes:
      "Agent-first: one pi tool loop; missing credentials or MARGIN_ENGINE=simple selects offline before execution.",
    newRunId: () => randomUUID(),
    runBlockScan,
    hash: contentHash,
    resolveEngine,
    preferredEngine,
  };
}

export { getHarness, listHarnesses } from "@margin/harness";
export type { BlockSnapshot };
