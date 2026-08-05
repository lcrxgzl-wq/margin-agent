import type { SaveLlmSettingsInput } from "@margin/storage-local";

export type LlmSettingsPutBody = {
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
  /** Pi session timeout in ms; null clears back to the default. */
  agentTimeoutMs?: number | null;
  /** Total transient-error attempts; null clears back to 5. */
  retryAttempts?: number | null;
  /** Fixed transient-error delay in ms; null clears back to 30000. */
  retryDelayMs?: number | null;
  /** Inline selection cap in chars; null follows the context tier. */
  selectionContextChars?: number | null;
  /** Context budget tier; null clears back to the default (standard). */
  contextTier?: "eco" | "standard" | "max" | null;
  /** Automatic context compaction; null clears back to the default (on). */
  compactionAuto?: boolean | null;
  /** Unlimited external reads; null clears back to the default (off). */
  unlimitedRead?: boolean | null;
};

/**
 * Build the saveLlmSettings input for PUT /api/v1/settings/llm.
 *
 * A provider patch is only constructed when the body actually carries
 * provider fields — a harnessId-only request must leave the active
 * provider untouched: keys explicitly set to undefined would otherwise
 * be spread over the stored profile and reset it to defaults.
 */
export function buildLlmSettingsUpdate(
  body: LlmSettingsPutBody,
  activeProviderId: string,
): SaveLlmSettingsInput {
  const harnessId = typeof body.harnessId === "string"
    ? body.harnessId.trim() || null
    : body.harnessId;
  const obj = typeof body.provider === "object" && body.provider ? body.provider : {};
  const { id: _ignoredId, ...profilePatch } = obj;
  const merged = {
    ...profilePatch,
    apiFormat: typeof body.provider === "string" ? body.provider : obj.apiFormat,
    model: body.model ?? obj.model,
    apiKey: body.apiKey ?? obj.apiKey,
    baseURL: body.baseURL ?? obj.baseURL,
    authStyle: body.authStyle ?? obj.authStyle,
    reasoningOptIn: body.reasoningOptIn ?? obj.reasoningOptIn,
  };
  const defined = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  );
  return {
    clearApiKey: !!body.clearApiKey,
    harnessId,
    reasoningMode: body.reasoningMode,
    agentTimeoutMs: body.agentTimeoutMs,
    retryAttempts: body.retryAttempts,
    retryDelayMs: body.retryDelayMs,
    selectionContextChars: body.selectionContextChars,
    contextTier: body.contextTier,
    compactionAuto: body.compactionAuto,
    unlimitedRead: body.unlimitedRead,
    provider: Object.keys(defined).length
      ? { ...defined, id: activeProviderId }
      : undefined,
  };
}
