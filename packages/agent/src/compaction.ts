/**
 * Context compaction (Round A): usage-triggered prune + LLM summarization.
 * Pure logic only — no storage, no SQLite. See
 * docs/superpowers/specs/2026-07-28-context-compaction.md.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  generateSummary,
  shouldCompact,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model, Models } from "@earendil-works/pi-ai";

export type ContextTierName = "eco" | "standard" | "max";

export type CompactionReason = "threshold" | "overflow" | "manual";

/** Auto-compact when usage exceeds this fraction of the model context window. */
export const COMPACTION_USAGE_RATIO = 0.85;

/** Reserve tokens so shouldCompact fires at COMPACTION_USAGE_RATIO. */
export function reserveTokensForUsageRatio(
  contextWindow: number,
  ratio: number = COMPACTION_USAGE_RATIO,
): number {
  if (!(contextWindow > 0) || !(ratio > 0 && ratio < 1)) {
    return DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  }
  return Math.max(1, Math.floor(contextWindow * (1 - ratio)));
}

export type CompactionEvent = {
  /** Idempotency key minted at compaction time; hosts dedupe settles on it. */
  eventId: string;
  reason: CompactionReason;
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  /** Full transcript snapshot at compaction time (what the archive stores). */
  messagesBefore: AgentMessage[];
  /** [summary head] + kept tail — replaces the messagesBefore prefix. */
  messagesAfter: AgentMessage[];
};

/** Injected so tests can mock; default wraps pi generateSummary. */
export type SummarizerFn = (
  messages: AgentMessage[],
  previousSummary: string | undefined,
  signal?: AbortSignal,
) => Promise<string>;

export const PRUNED_TOOL_OUTPUT_PLACEHOLDER =
  "[旧工具输出已清理属正常。请按 blockId/cursor/sourceRef 按需重读单段/续读；不要因此用 offset 重扫全文]";

function toolNameOf(message: AgentMessage): string {
  return String((message as { toolName?: unknown }).toolName ?? "");
}

/** Keep the exact continuation anchor when pruning bounded read tool output. */
export function prunedToolOutputPlaceholder(
  message: AgentMessage,
  originalText: string,
): string {
  const toolName = toolNameOf(message);
  if (toolName === "read_document_blocks") {
    try {
      const parsed = JSON.parse(originalText) as {
        cursor?: unknown;
        nextCursor?: unknown;
      };
      if (typeof parsed.cursor === "string") {
        const next = parsed.nextCursor == null
          ? "已读到结尾"
          : `继续用 nextCursor=${String(parsed.nextCursor)}`;
        return `[旧工具输出已清理属正常。cursor=${parsed.cursor}；${next}。不要用 offset 重扫全文]`;
      }
    } catch {
      /* fall through to the generic placeholder */
    }
  }
  if (toolName === "read_workspace_file") {
    try {
      const parsed = JSON.parse(originalText) as {
        sourceRef?: unknown;
        nextOffset?: unknown;
      };
      const sourceRef = typeof parsed.sourceRef === "string" ? parsed.sourceRef : "";
      const nextOffset = typeof parsed.nextOffset === "number" ? String(parsed.nextOffset) : "";
      if (sourceRef || nextOffset) {
        const parts = [
          sourceRef ? `sourceRef=${sourceRef}` : "",
          nextOffset ? `nextOffset=${nextOffset}` : "",
        ].filter(Boolean);
        return `[旧工具输出已清理属正常。${parts.join("；")}。需要时再 read_workspace_file 读全文；勿默认 offset 分页]`;
      }
    } catch {
      /* fall through to the generic placeholder */
    }
  }
  return PRUNED_TOOL_OUTPUT_PLACEHOLDER;
}

/** Stage-1 protection window (chars), conservative equivalent of opencode PRUNE_PROTECT. */
export const PRUNE_PROTECT_CHARS = 40_000;
/** Stage-1 minimum reclaim (chars); below this pruning is not executed. */
export const PRUNE_MINIMUM_CHARS = 20_000;

export const MARGIN_COMPACTION_INSTRUCTIONS =
  "必须准确保留：提案 id 及其 Y/N/E 裁决状态、E 编辑后文本要点、待裁决提案、作者明确意图与禁区、当前文档与选区位置。";

const SUMMARY_PREFIX = "此前对话已压缩为以下摘要：\n\n";

/** Exported so the host rebuilds the exact summary message pi-loop writes. */
export const COMPACTION_SUMMARY_PREFIX = SUMMARY_PREFIX;

/** Tier mapping per spec §6: eco never summarizes; standard 20k; max 40k. */
export function keepRecentTokensForTier(tier: ContextTierName): number {
  return tier === "max" ? 40_000 : 20_000;
}

function roleOf(message: AgentMessage): string | undefined {
  return message && typeof message === "object" && "role" in message
    ? String((message as { role?: unknown }).role ?? "")
    : undefined;
}

/** A user message whose content starts with the compaction summary prefix. */
export function isCompactionSummaryMessage(message: AgentMessage): boolean {
  if (roleOf(message) !== "user") return false;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" && content.startsWith(SUMMARY_PREFIX);
}

function messageTextChars(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
  }
  return chars;
}

/**
 * contextTokens from the last assistant usage strictly later than
 * lastCompactionAt (self-trigger guard: after a compaction, stale usage no
 * longer re-triggers). The latest summary head in the transcript is a
 * self-contained second cutoff: its timestamp is the compaction time, so
 * kept-tail usage predating it (e.g. after a manual compaction) is ignored
 * even without a persisted lastCompactionAt. Undefined when nothing
 * qualifies — callers must not fall back to character estimates for
 * triggering.
 */
export function findLastContextTokens(
  messages: AgentMessage[],
  lastCompactionAt?: number,
): number | undefined {
  let cutoff = lastCompactionAt;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!isCompactionSummaryMessage(message)) continue;
    const headTimestamp = (message as { timestamp?: number }).timestamp ?? 0;
    if (cutoff === undefined || headTimestamp > cutoff) cutoff = headTimestamp;
    break; // only the latest summary head matters
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: string;
      usage?: {
        totalTokens?: number;
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
      timestamp?: number;
    };
    if (message?.role !== "assistant" || !message.usage) continue;
    if (cutoff !== undefined && (message.timestamp ?? 0) <= cutoff) {
      continue;
    }
    const usage = message.usage;
    const tokens =
      usage.totalTokens ??
      (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    return tokens;
  }
  return undefined;
}

/**
 * Stage 1 (zero cost): replace tool-output text older than the protection
 * window with a placeholder. Not executed below the minimum reclaim.
 */
export function pruneToolOutputs(
  messages: AgentMessage[],
  protectChars = PRUNE_PROTECT_CHARS,
  minReclaimChars = PRUNE_MINIMUM_CHARS,
): { messages: AgentMessage[]; reclaimed: number } {
  let windowChars = 0;
  const pruneIndexes: number[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    windowChars += messageTextChars(message);
    if (windowChars <= protectChars) continue;
    if (roleOf(message) === "toolResult") pruneIndexes.push(index);
  }
  let reclaimable = 0;
  for (const index of pruneIndexes) {
    reclaimable += Math.max(0, messageTextChars(messages[index]!) - PRUNED_TOOL_OUTPUT_PLACEHOLDER.length);
  }
  if (reclaimable < minReclaimChars) return { messages, reclaimed: 0 };
  const pruned = [...messages];
  let reclaimed = 0;
  for (const index of pruneIndexes) {
    const message = pruned[index] as { content?: unknown };
    if (!Array.isArray(message.content)) continue;
    const content = (message.content as Array<Record<string, unknown>>).map((block) => {
      if (block?.type === "text" && typeof block.text === "string") {
        const replacement = prunedToolOutputPlaceholder(message as AgentMessage, block.text);
        reclaimed += Math.max(0, block.text.length - replacement.length);
        return { ...block, text: replacement };
      }
      return block;
    });
    pruned[index] = { ...message, content } as unknown as AgentMessage;
  }
  return { messages: pruned, reclaimed };
}

/**
 * Pick the cut point (index of the first kept message) keeping approximately
 * keepRecentTokens of tail (mirrors pi findCutPoint: accumulate from the
 * tail past the budget, then move the cut toward the tail to a legal
 * boundary). The cut must land on a user-message boundary — which
 * structurally can never split an assistant toolCall from its toolResult —
 * and must never eat the latest user turn. When the budget is exhausted
 * inside the latest turn, the whole latest turn is kept. Undefined when no
 * legal cut exists (soft fail, retried next round).
 */
export function findSafeCutIndex(
  messages: AgentMessage[],
  keepRecentTokens: number,
): number | undefined {
  if (messages.length < 2) return undefined;
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (roleOf(messages[index]!) === "user") {
      lastUserIndex = index;
      break;
    }
  }
  // Dropping anything would eat the latest (or only) user turn.
  if (lastUserIndex < 1) return undefined;
  let tokens = 0;
  let reached = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    tokens += estimateTokens(messages[index]!);
    if (tokens >= keepRecentTokens) {
      reached = index;
      break;
    }
  }
  for (let cut = Math.max(1, reached); cut <= lastUserIndex; cut += 1) {
    if (roleOf(messages[cut]!) === "user") return cut;
  }
  return lastUserIndex;
}

export type CompactionSkipReason =
  | "eco_tier"
  | "below_threshold"
  | "no_usage"
  | "no_safe_cut"
  | "not_beneficial";

export type CompactionOutcome =
  | {
      kind: "compacted";
      /** Idempotency key for the host-side settle (archive + transcript swap). */
      eventId: string;
      messages: AgentMessage[];
      summary: string;
      tokensBefore: number;
      tokensAfter: number;
      /** Compacted-away prefix; kept for observability, not for slicing. */
      droppedMessages: AgentMessage[];
      reclaimed: number;
    }
  | { kind: "skipped"; reason: CompactionSkipReason; messages: AgentMessage[]; reclaimed: number }
  | { kind: "failed"; error: string; fallback: "trim"; messages: AgentMessage[]; reclaimed: number };

export type OrchestrateCompactionInput = {
  messages: AgentMessage[];
  model: Model<never>;
  contextWindow: number;
  tier: ContextTierName;
  /** Fixed 16384 per spec §1. */
  reserveTokens?: number;
  /** Defaults to the tier mapping (standard 20k / max 40k). */
  keepRecentTokens?: number;
  summarizer?: SummarizerFn;
  previousSummary?: string;
  /** Synthetic user message appended to the messages sent to summarization. */
  domainSnapshot?: string;
  /** Usage at or before this timestamp is ignored (self-trigger guard). */
  lastCompactionAt?: number;
  /** Overflow/manual path: skip the usage trigger and threshold checks. */
  force?: boolean;
  signal?: AbortSignal;
};

/** Default summarizer: pi generateSummary, thinking off, Margin instructions. */
export function createPiSummarizer(opts: {
  model: Model<never>;
  apiKey?: string;
  headers?: Record<string, string>;
  reserveTokens?: number;
}): SummarizerFn {
  // generateSummary only uses models.completeSimple; a minimal dispatch shim
  // keeps Margin's apiKey/identity headers on the summarization request.
  const models = {
    completeSimple: (model: Model<never>, context: never, options?: Record<string, unknown>) =>
      completeSimple(model, context, {
        ...(options ?? {}),
        apiKey: (options?.apiKey as string | undefined) ?? opts.apiKey,
        headers: { ...(opts.headers ?? {}), ...((options?.headers as object) ?? {}) },
      } as never),
  } as unknown as Models;
  return async (messages, previousSummary, signal) => {
    const result = await generateSummary(
      messages,
      models,
      opts.model,
      opts.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      signal,
      MARGIN_COMPACTION_INSTRUCTIONS,
      previousSummary,
      "off",
    );
    if (!result.ok) throw result.error;
    return result.value;
  };
}

/**
 * Two-stage compaction: prune → (trigger) summarize → assemble
 * `[user: prefix + summary] + verbatim tail`, with guards (summarizer failure
 * falls back to the trim ladder; a non-shrinking result is abandoned).
 */
export async function orchestrateCompaction(
  input: OrchestrateCompactionInput,
): Promise<CompactionOutcome> {
  const reserveTokens = input.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const thresholdReserve = input.reserveTokens ?? reserveTokensForUsageRatio(input.contextWindow);
  const keepRecentTokens = input.keepRecentTokens ?? keepRecentTokensForTier(input.tier);
  const { messages: pruned, reclaimed } = pruneToolOutputs(input.messages);

  if (input.tier === "eco") {
    return { kind: "skipped", reason: "eco_tier", messages: pruned, reclaimed };
  }

  if (!input.force) {
    const contextTokens = findLastContextTokens(pruned, input.lastCompactionAt);
    if (contextTokens === undefined) {
      return { kind: "skipped", reason: "no_usage", messages: pruned, reclaimed };
    }
    if (
      !shouldCompact(contextTokens, input.contextWindow, {
        enabled: true,
        reserveTokens: thresholdReserve,
        keepRecentTokens,
      })
    ) {
      return { kind: "skipped", reason: "below_threshold", messages: pruned, reclaimed };
    }
  }

  const cut = findSafeCutIndex(pruned, keepRecentTokens);
  if (cut === undefined) {
    return { kind: "skipped", reason: "no_safe_cut", messages: pruned, reclaimed };
  }

  const toSummarize = pruned.slice(0, cut);
  // I2b: a previous summary head is already represented by previousSummary —
  // do not re-feed it to the summarizer. It is still compacted away (the new
  // summary head replaces it) since it stays inside toSummarize.
  const summarizees =
    toSummarize.length > 0 && isCompactionSummaryMessage(toSummarize[0]!)
      ? toSummarize.slice(1)
      : toSummarize;
  const summarizerInput = input.domainSnapshot?.trim()
    ? [
        ...summarizees,
        {
          role: "user",
          content: input.domainSnapshot.trim(),
          timestamp: Date.now(),
        } as AgentMessage,
      ]
    : summarizees;

  const summarizer =
    input.summarizer ?? createPiSummarizer({ model: input.model, reserveTokens });
  let summary: string;
  try {
    summary = await summarizer(summarizerInput, input.previousSummary, input.signal);
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
      fallback: "trim",
      messages: pruned,
      reclaimed,
    };
  }

  const summaryMessage = {
    role: "user",
    content: `${SUMMARY_PREFIX}${summary}`,
    timestamp: Date.now(),
  } as AgentMessage;
  const compacted = [summaryMessage, ...pruned.slice(cut)];

  const tokensBefore = estimateContextTokens(pruned).tokens;
  const tokensAfter = estimateContextTokens(compacted).tokens;
  if (tokensAfter >= tokensBefore) {
    return { kind: "skipped", reason: "not_beneficial", messages: pruned, reclaimed };
  }

  return {
    kind: "compacted",
    eventId: randomUUID(),
    messages: compacted,
    summary,
    tokensBefore,
    tokensAfter,
    droppedMessages: toSummarize,
    reclaimed,
  };
}
