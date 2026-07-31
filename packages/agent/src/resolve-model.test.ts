import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { effectiveThinkingLevel, hasRuntimeCredentials, resolveRuntimeApiKey, resolveRuntimeModel } from "./resolve-model.js";

const KEYS = [
  "MARGIN_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "MARGIN_API_FORMAT",
  "MARGIN_AUTH_STYLE",
  "MARGIN_BASE_URL",
  "MARGIN_MODEL",
] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});

afterAll(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveRuntimeApiKey", () => {
  it("does not send an Anthropic key to an OpenAI endpoint", () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-only";
    expect(resolveRuntimeApiKey("openai")).toBeUndefined();
  });

  it("uses only the selected provider key or the generic Margin key", () => {
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";
    expect(resolveRuntimeApiKey("openai")).toBe("openai-key");
    expect(resolveRuntimeApiKey("anthropic")).toBe("anthropic-key");

    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.MARGIN_API_KEY = "generic-key";
    expect(resolveRuntimeApiKey("openai")).toBe("generic-key");
    expect(resolveRuntimeApiKey("anthropic")).toBe("generic-key");
  });

  it("removes a trailing /v1 before handing Anthropic base URLs to the SDK", () => {
    process.env.MARGIN_API_FORMAT = "anthropic";
    process.env.MARGIN_BASE_URL = "https://provider.test/proxy/v1/";
    process.env.MARGIN_MODEL = "claude-sonnet-4-6";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";

    const resolved = resolveRuntimeModel();
    expect(resolved.baseURL).toBe("https://provider.test/proxy");
    expect(resolved.model.baseUrl).toBe("https://provider.test/proxy");
  });

  it("uses chat completions and the canonical Base URL for OpenAI-compatible APIs", () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/proxy/v1/chat/completions";
    process.env.MARGIN_MODEL = "custom-chat-model";
    process.env.OPENAI_API_KEY = "openai-key";

    const resolved = resolveRuntimeModel();
    expect(resolved.baseURL).toBe("https://provider.test/proxy/v1");
    expect(resolved.model.baseUrl).toBe("https://provider.test/proxy/v1");
    expect(resolved.model.api).toBe("openai-completions");
  });

  it("uses conservative capabilities for an unknown Anthropic-compatible model", () => {
    process.env.MARGIN_API_FORMAT = "anthropic";
    process.env.MARGIN_BASE_URL = "https://provider.test";
    process.env.MARGIN_MODEL = "deepseek-thinking-model";
    process.env.MARGIN_API_KEY = "key";

    const resolved = resolveRuntimeModel();

    expect(resolved.model.reasoning).toBe(false);
    expect(resolved.model.thinkingLevelMap).toBeUndefined();
    expect(resolved.model.compat).toBeUndefined();
    expect(resolved.model.maxTokens).toBeLessThanOrEqual(8_192);
    expect(resolved.authStyle).toBe("apikey");
  });

  it("passes the OpenAI key through under Bearer auth (pi requires options.apiKey)", () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_AUTH_STYLE = "bearer";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_MODEL = "custom-model";
    process.env.MARGIN_API_KEY = "sk-proxy";

    const resolved = resolveRuntimeModel();
    expect(resolved.authStyle).toBe("bearer");
    expect(resolved.apiKey).toBe("sk-proxy");
    expect(resolved.model.headers?.Authorization).toBe("Bearer sk-proxy");
  });

  it("keeps Anthropic Bearer header-owned so x-api-key is not sent", () => {
    process.env.MARGIN_API_FORMAT = "anthropic";
    process.env.MARGIN_AUTH_STYLE = "bearer";
    process.env.MARGIN_BASE_URL = "https://provider.test";
    process.env.MARGIN_MODEL = "claude-proxy";
    process.env.MARGIN_API_KEY = "proxy-token";

    const resolved = resolveRuntimeModel();
    expect(resolved.authStyle).toBe("bearer");
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.model.headers?.Authorization).toBe("Bearer proxy-token");
  });
});

describe("hasRuntimeCredentials", () => {
  it("does not treat a remote Base URL alone as credentials", () => {
    process.env.MARGIN_API_FORMAT = "anthropic";
    process.env.MARGIN_BASE_URL = "https://api.deepseek.com/anthropic";
    expect(hasRuntimeCredentials()).toBe(false);
  });

  it("accepts loopback Base URL without a key (local proxy)", () => {
    process.env.MARGIN_BASE_URL = "http://127.0.0.1:15721";
    expect(hasRuntimeCredentials()).toBe(true);
  });

  it("accepts a configured API key", () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://api.deepseek.com/v1";
    process.env.MARGIN_API_KEY = "sk-test";
    expect(hasRuntimeCredentials()).toBe(true);
  });
});

describe("effectiveThinkingLevel", () => {
  it("omits reasoning controls in auto mode", () => {
    expect(effectiveThinkingLevel("auto", { model: { reasoning: true }, isBuiltin: true }))
      .toBeUndefined();
    expect(effectiveThinkingLevel(undefined, { model: { reasoning: true }, isBuiltin: true }))
      .toBeUndefined();
  });

  it("maps explicit modes for reasoning-capable builtin models", () => {
    const resolved = { model: { reasoning: true }, isBuiltin: true };
    expect(effectiveThinkingLevel("fast", resolved)).toBe("low");
    expect(effectiveThinkingLevel("standard", resolved)).toBe("medium");
    expect(effectiveThinkingLevel("deep", resolved)).toBe("high");
  });

  it("never leaks reasoning levels to non-compatible models", () => {
    const builtinNoReasoning = { model: { reasoning: false }, isBuiltin: true };
    expect(effectiveThinkingLevel("deep", builtinNoReasoning)).toBeUndefined();
    const custom = { model: { reasoning: false }, isBuiltin: false };
    expect(effectiveThinkingLevel("deep", custom)).toBeUndefined();
    expect(effectiveThinkingLevel("deep", custom, false)).toBeUndefined();
  });

  it("honors an explicit custom-provider opt-in", () => {
    const custom = { model: { reasoning: false }, isBuiltin: false };
    expect(effectiveThinkingLevel("fast", custom, true)).toBe("low");
    expect(effectiveThinkingLevel("deep", custom, true)).toBe("high");
    expect(effectiveThinkingLevel("auto", custom, true)).toBeUndefined();
  });
});
