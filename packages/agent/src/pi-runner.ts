import { createHash } from "node:crypto";
import type { Proposal } from "@margin/domain";
import { composeSystemPrompt, getAgentProfile } from "@margin/harness";
import { getHeuristicComments } from "./packs/registry.js";
import { runPiAgentLoop } from "./pi-loop.js";
import { assertPiLoopCompleted } from "./pi-outcome.js";
import { createPaperTools } from "./pi-tools.js";
import {
  effectiveThinkingLevel,
  hasRuntimeCredentials,
  resolveRuntimeModel,
} from "./resolve-model.js";
import type {
  AgentComment,
  PaperAgentContext,
  PaperAgentResult,
  ScanProgressHandler,
} from "./types.js";

export { createPaperTools } from "./pi-tools.js";

function maxTurns(fallback: number): number {
  const n = Number(process.env.MARGIN_PI_MAX_TURNS ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function timeoutMs(fallback: number): number {
  const n = Number(process.env.MARGIN_PI_TIMEOUT_MS ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function runPiBlockScan(
  ctx: PaperAgentContext,
  blockIds?: string[],
  onProgress?: ScanProgressHandler,
): Promise<PaperAgentResult> {
  const profile = getAgentProfile(ctx.harnessId);
  const runtime = resolveRuntimeModel(profile.model);
  const { model, apiKey } = runtime;
  const thinkingLevel = effectiveThinkingLevel(ctx.reasoningMode, runtime, ctx.reasoningOptIn);
  if (!hasRuntimeCredentials()) {
    throw new Error(
      "pi engine requires API key or Base URL (configure in Settings / CC Switch)",
    );
  }

  const selected = blockIds?.length
    ? ctx.blocks.filter((b) => blockIds.includes(b.id))
    : ctx.blocks.slice(0, 20);
  if (!selected.length) {
    return { engine: "pi", proposals: [], comments: [], notes: ["no blocks selected"] };
  }

  const drafts: PaperAgentResult["proposals"] = [];
  const comments: AgentComment[] = [];
  const primaryIds = selected.map((b) => b.id);
  const tools = createPaperTools(
    {
      getBlocks: () => ctx.blocks,
      getDocumentId: () => ctx.documentId,
      getRevision: () => ctx.revision,
      proposeScope: {
        primaryAllowlist: primaryIds,
        enforceCascadeGate: true,
      },
      terminateWhenPrimaryCovered: true,
    },
    drafts,
    comments,
    { harnessId: ctx.harnessId },
  );
  const steps: string[] = [];

  const emit = (phase: string, tool?: string, detail?: string) => {
    steps.push(phase);
    onProgress?.({ phase, tool, detail });
  };
  emit("启动 pi 工具环");

  const targetHint = selected.map((b) => b.id).join(", ");
  const instruction = ctx.instruction?.trim();
  const result = await runPiAgentLoop({
    prompt: instruction
      ? `请按作者指令审阅并提案（块：${targetHint}）。每块最多一份提案，不要重复；完成后立即 finish_turn。\n作者指令：${instruction.slice(0, 600)}`
      : `请审阅这些块；按需要调用工具，为值得修改的块提出提案（可少于全部）。每块最多一份提案，不要重复；完成后立即 finish_turn：${targetHint}`,
    systemPrompt: composeSystemPrompt(ctx.harnessId, "scan"),
    tools,
    messages: [],
    model,
    apiKey,
    thinkingLevel,
    usagePath: "pi-scan",
    // Stable, opaque cache/session key: hash of the document id only (never a path or text).
    sessionId: `pi-scan-${createHash("sha256").update(`margin-scan:${ctx.documentId}`).digest("hex").slice(0, 24)}`,
    maxTurns: maxTurns(profile.limits.maxTurns),
    timeoutMs: ctx.timeoutMs ?? timeoutMs(profile.limits.timeoutMs),
    maxContextMessages: profile.limits.maxContextMessages,
    maxContextChars: profile.limits.maxContextChars,
    allowedToolNames: tools.map((tool) => tool.name),
    onProgress: (phase, tool) => emit(phase, tool),
    signal: ctx.signal,
  });
  assertPiLoopCompleted(result, "pi scan");

  const notes = [...result.notes];
  if (!drafts.length) {
    notes.push("pi finished with zero proposals");
  }

  const merged = [...comments];
  const heuristicComments = getHeuristicComments(undefined, ctx.harnessId);
  if (heuristicComments && merged.length < 3) {
    for (const h of heuristicComments(selected, { max: 8 })) {
      if (merged.length >= 12) break;
      if (merged.some((c) => c.blockId === h.blockId && c.text === h.text)) continue;
      merged.push(h);
    }
  }

  emit(drafts.length ? `完成（${drafts.length} 处提案）` : "完成（无提案）");

  return {
    engine: "pi",
    proposals: drafts,
    comments: merged,
    notes: notes.length ? notes : undefined,
    steps,
    toolAudit: result.toolAudit,
  };
}

export type { Proposal };
