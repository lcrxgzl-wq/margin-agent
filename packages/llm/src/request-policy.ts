import { randomUUID } from "node:crypto";

/** The five outbound model request paths covered by the shared request policy. */
export type ModelRequestPath = "pi-chat" | "pi-scan" | "quick-edit" | "legacy" | "probe";

export type ModelUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelUsageEntry = ModelUsage & {
  path: ModelRequestPath;
  model: string;
  /** Matches the X-Client-Request-Id header sent with the request. */
  requestId: string;
};

let policyVersion = "dev";
let usageRecorder: ((entry: ModelUsageEntry) => void) | undefined;

/**
 * Configure the shared request policy once at host startup. Safe to call
 * again (e.g. to attach the usage recorder after the workspace opens);
 * omitted fields keep their previous values.
 */
export function configureRequestPolicy(init: {
  version?: string;
  onUsage?: (entry: ModelUsageEntry) => void;
}): void {
  if (typeof init.version === "string" && init.version.trim()) {
    policyVersion = init.version.trim();
  }
  if ("onUsage" in init) {
    usageRecorder = init.onUsage;
  }
}

/** Policy headers for one outbound request; a fresh request id per call. */
export function marginRequestHeaders(): Record<string, string> {
  return {
    "User-Agent": `margin-agent/${policyVersion}`,
    "X-Client-Request-Id": randomUUID(),
  };
}

/** Best-effort local usage recording; never fails the request that produced it. */
export function reportModelUsage(entry: ModelUsageEntry): void {
  try {
    usageRecorder?.(entry);
  } catch {
    // recording is diagnostic only
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Extract token usage from a raw provider response; undefined when absent. */
export function extractUsage(
  apiFormat: "openai" | "anthropic",
  payload: unknown,
): ModelUsage | undefined {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) return undefined;
  if (apiFormat === "anthropic") {
    return {
      input: tokenCount(usage.input_tokens),
      output: tokenCount(usage.output_tokens),
      cacheRead: tokenCount(usage.cache_read_input_tokens),
      cacheWrite: tokenCount(usage.cache_creation_input_tokens),
    };
  }
  return {
    input: tokenCount(usage.prompt_tokens),
    output: tokenCount(usage.completion_tokens),
    cacheRead: tokenCount(asRecord(usage.prompt_tokens_details)?.cached_tokens),
    cacheWrite: 0,
  };
}
