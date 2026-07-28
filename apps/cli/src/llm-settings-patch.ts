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
    provider: Object.keys(defined).length
      ? { ...defined, id: activeProviderId }
      : undefined,
  };
}
