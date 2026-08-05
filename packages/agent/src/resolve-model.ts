/**
 * Resolve pi Model from Margin env (CC Switch–style baseURL + model id).
 */
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { canonicalizeProviderBaseURL } from "@margin/llm";
import type { ReasoningMode } from "./types.js";

type AnyModel = {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  thinkingLevelMap?: Record<string, string | null | undefined>;
  compat?: unknown;
};

export type ResolvedRuntimeModel = {
  provider: string;
  model: AnyModel;
  /**
   * Passed to Agent getApiKey. OpenAI always needs this (SDK auth).
   * Anthropic bearer leaves it undefined so only Authorization is sent
   * (avoids a conflicting x-api-key); streamFn must forward model.headers.
   */
  apiKey?: string;
  authStyle: "bearer" | "apikey";
  baseURL?: string;
  /** True when the model id resolved to a pi builtin (provider-known capabilities). */
  isBuiltin: boolean;
};

function apiFormat(): "openai" | "anthropic" {
  const v = (
    process.env.MARGIN_API_FORMAT ||
    process.env.MARGIN_PROVIDER ||
    "openai"
  ).toLowerCase();
  return v === "anthropic" ? "anthropic" : "openai";
}

function authStyle(): "bearer" | "apikey" {
  const v = (process.env.MARGIN_AUTH_STYLE || "").toLowerCase();
  if (v === "bearer" || v === "apikey") return v;
  return "apikey";
}

export function resolveRuntimeApiKey(format: "openai" | "anthropic"): string | undefined {
  if (format === "anthropic") {
    return (
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.MARGIN_API_KEY ||
      undefined
    );
  }
  return (
    process.env.OPENAI_API_KEY ||
    process.env.MARGIN_API_KEY ||
    undefined
  );
}

function tryBuiltin(provider: "anthropic" | "openai", id: string): AnyModel | undefined {
  try {
    const m = getBuiltinModel(provider, id as never) as unknown as AnyModel | undefined;
    return m ?? undefined;
  } catch {
    return undefined;
  }
}

function templateAnthropic(): AnyModel {
  for (const id of ["claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-4-5"]) {
    const m = tryBuiltin("anthropic", id);
    if (m) return m;
  }
  throw new Error("no anthropic builtin model template");
}

function templateOpenAI(): AnyModel {
  for (const id of ["gpt-4o-mini", "gpt-4o"]) {
    const m = tryBuiltin("openai", id);
    if (m) return m;
  }
  throw new Error("no openai builtin model template");
}

function bareModelId(modelId: string): string {
  return modelId.replace(/\[[^\]]*\]/g, "").trim();
}

function runtimeBaseURL(
  format: "openai" | "anthropic",
): string | undefined {
  const value = process.env.MARGIN_BASE_URL?.trim();
  if (!value) return undefined;
  return canonicalizeProviderBaseURL(value, format);
}

export function resolveRuntimeModel(modelOverride?: string): ResolvedRuntimeModel {
  const format = apiFormat();
  const style = authStyle();
  const modelId =
    modelOverride?.trim() ||
    process.env.MARGIN_MODEL?.trim() ||
    (format === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini");
  const baseURL = runtimeBaseURL(format);
  const key = resolveRuntimeApiKey(format);

  const builtin = format === "anthropic"
    ? tryBuiltin("anthropic", bareModelId(modelId))
    : tryBuiltin("openai", bareModelId(modelId));
  const template = builtin || (format === "anthropic" ? templateAnthropic() : templateOpenAI());

  const model: AnyModel = {
    ...template,
    id: modelId,
    name: modelId,
    provider: format === "anthropic" ? "anthropic" : "openai",
    api: format === "anthropic" ? "anthropic-messages" : "openai-completions",
    baseUrl: baseURL || template.baseUrl,
  };
  if (!builtin) {
    model.reasoning = false;
    model.input = ["text"];
    // Custom / OpenAI-compatible gateways often expose 200k–256k windows; keep a
    // hard ceiling so compaction and fit-first budgets stay honest.
    model.contextWindow = Math.min(template.contextWindow || 256_000, 256_000);
    model.maxTokens = Math.min(template.maxTokens || 8_192, 8_192);
    model.thinkingLevelMap = undefined;
    model.compat = undefined;
  }

  if (style === "bearer" && key) {
    model.headers = {
      ...(model.headers ?? {}),
      Authorization: `Bearer ${key}`,
    };
    return {
      provider: format,
      model,
      isBuiltin: !!builtin,
      // pi-ai checks options.apiKey / options.headers, not model.headers alone.
      // OpenAI: pass the key. Anthropic bearer: header-only (no x-api-key).
      apiKey: format === "openai" ? key : undefined,
      authStyle: style,
      baseURL,
    };
  }

  return {
    provider: format,
    model,
    isBuiltin: !!builtin,
    apiKey: key,
    authStyle: style,
    baseURL,
  };
}

function isLoopbackBaseURL(value: string): boolean {
  try {
    const host = new URL(value.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1") return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

export function hasRuntimeCredentials(): boolean {
  if (resolveRuntimeApiKey(apiFormat())) return true;
  // Remote Base URLs alone are not credentials (would boot pi with an empty key).
  const base = process.env.MARGIN_BASE_URL?.trim();
  return !!(base && isLoopbackBaseURL(base));
}


/**
 * Map the product reasoning mode to a Pi thinking level.
 * Explicit modes apply only to reasoning-capable builtins, or to custom
 * (non-builtin) providers that explicitly opted in. Anything else omits
 * provider-specific reasoning controls entirely.
 */
export function effectiveThinkingLevel(
  mode: ReasoningMode | undefined,
  resolved: { model: { reasoning?: boolean }; isBuiltin: boolean },
  reasoningOptIn?: boolean,
): "low" | "medium" | "high" | undefined {
  if (!mode || mode === "auto") return undefined;
  const level = mode === "fast" ? "low" : mode === "standard" ? "medium" : "high";
  if (resolved.model.reasoning === true) return level;
  if (!resolved.isBuiltin && reasoningOptIn === true) return level;
  return undefined;
}
