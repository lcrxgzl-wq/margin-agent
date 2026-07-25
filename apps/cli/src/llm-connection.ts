import {
  canonicalizeProviderBaseURL,
  type LlmModelProbeInput,
} from "@margin/llm";
import type { LlmSettingsStore } from "@margin/storage-local";

export type LlmConnectionBody = {
  apiFormat?: "openai" | "anthropic";
  baseURL?: string;
  apiKey?: string;
  authStyle?: "bearer" | "apikey";
  model?: string;
  reuseStoredKey?: boolean;
};

type RuntimeKeys = Partial<Record<"openai" | "anthropic", string>>;

function normalizedTarget(
  value: string,
  apiFormat: "openai" | "anthropic",
): string {
  try {
    const canonical = canonicalizeProviderBaseURL(value, apiFormat);
    if (apiFormat !== "openai") return canonical;
    const url = new URL(canonical);
    url.pathname = url.pathname.replace(/\/v1$/i, "") || "/";
    return url.pathname === "/" ? url.origin : url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

export function resolveLlmConnectionInput(
  store: LlmSettingsStore,
  body: LlmConnectionBody = {},
  runtimeKeys: RuntimeKeys = {},
): LlmModelProbeInput {
  const saved = store.providers.find((provider) => provider.id === store.activeId)!;
  const apiFormat = body.apiFormat ?? saved.apiFormat;
  const authStyle = body.authStyle ?? saved.authStyle;
  const baseURL = body.baseURL?.trim() ?? saved.baseURL;
  const sameTarget =
    apiFormat === saved.apiFormat &&
    authStyle === saved.authStyle &&
    normalizedTarget(baseURL, apiFormat) ===
      normalizedTarget(saved.baseURL, saved.apiFormat);
  const runtimeKey = runtimeKeys[apiFormat];
  const mayReuseSavedKey = body.reuseStoredKey === true && sameTarget;

  return {
    apiFormat,
    authStyle,
    baseURL,
    apiKey:
      body.apiKey?.trim() ||
      (mayReuseSavedKey ? saved.apiKey?.trim() || runtimeKey : undefined),
    model: body.model?.trim() || saved.model,
  };
}
