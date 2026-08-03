import { COMPACTION_SUMMARY_PREFIX, type AgentMessage } from "@margin/agent";

export type ContextUsage = {
  contextWindowTokens: number;
  usedTokens: number;
  usageEstimated: boolean;
};

function serializedTokenEstimate(messages: AgentMessage[]): number {
  if (!messages.length) return 0;
  try {
    return Math.ceil(JSON.stringify(messages).length / 4);
  } catch {
    return 0;
  }
}

function isCompactionSummary(message: AgentMessage): boolean {
  const value = message as { role?: string; content?: unknown };
  return value.role === "user" &&
    typeof value.content === "string" &&
    value.content.startsWith(COMPACTION_SUMMARY_PREFIX);
}

function reportedUsage(message: AgentMessage): number | undefined {
  const value = message as {
    role?: string;
    stopReason?: string;
    usage?: {
      totalTokens?: number;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
  if (
    value.role !== "assistant" ||
    value.stopReason === "error" ||
    value.stopReason === "aborted" ||
    !value.usage
  ) return undefined;
  const total = value.usage.totalTokens;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
  const parts = [
    value.usage.input,
    value.usage.output,
    value.usage.cacheRead,
    value.usage.cacheWrite,
  ];
  const sum = parts.reduce<number>(
    (current, part) => current + (typeof part === "number" && Number.isFinite(part) ? part : 0),
    0,
  );
  return sum > 0 ? sum : undefined;
}

/** Prefer provider usage, then estimate transcript messages added after it. */
export function buildContextUsage(
  messages: AgentMessage[],
  contextWindowTokens: number,
): ContextUsage {
  let summaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCompactionSummary(messages[index]!)) {
      summaryIndex = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > summaryIndex; index -= 1) {
    const exactTokens = reportedUsage(messages[index]!);
    if (exactTokens === undefined) continue;
    const trailing = messages.slice(index + 1);
    return {
      contextWindowTokens,
      usedTokens: exactTokens + serializedTokenEstimate(trailing),
      usageEstimated: trailing.length > 0,
    };
  }
  return {
    contextWindowTokens,
    usedTokens: serializedTokenEstimate(messages),
    usageEstimated: true,
  };
}
