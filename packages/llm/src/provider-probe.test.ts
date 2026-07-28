import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeProviderBaseURL,
  discoverLlmModels,
  testLlmModelConnection,
} from "./provider-probe.js";
import { configureRequestPolicy, type ModelUsageEntry } from "./request-policy.js";

function mockFetch(handler: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(handler));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("canonicalizeProviderBaseURL", () => {
  it("strips OpenAI terminal endpoint paths while preserving prefixes", () => {
    expect(
      canonicalizeProviderBaseURL(
        "https://provider.test/gateway/v1/chat/completions/",
        "openai",
      ),
    ).toBe("https://provider.test/gateway/v1");
    expect(
      canonicalizeProviderBaseURL("https://provider.test/gateway/v1/models", "openai"),
    ).toBe("https://provider.test/gateway/v1");
    expect(
      canonicalizeProviderBaseURL("https://provider.test/gateway/v1/responses", "openai"),
    ).toBe("https://provider.test/gateway/v1");
  });

  it("strips Anthropic version and messages paths while preserving prefixes", () => {
    expect(
      canonicalizeProviderBaseURL(
        "https://provider.test/anthropic/v1/messages",
        "anthropic",
      ),
    ).toBe("https://provider.test/anthropic");
    expect(
      canonicalizeProviderBaseURL("https://provider.test/anthropic/v1/models", "anthropic"),
    ).toBe("https://provider.test/anthropic");
    expect(
      canonicalizeProviderBaseURL("https://provider.test/anthropic/v1/", "anthropic"),
    ).toBe("https://provider.test/anthropic");
  });
});

describe("discoverLlmModels", () => {
  it("discovers OpenAI models with bearer auth", async () => {
    mockFetch(async (input, init) => {
      expect(String(input)).toBe("https://provider.test/v1/models");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-secret" });
      return Response.json({
        data: [
          { id: "model-b", name: "Model B" },
          { id: "model-a" },
          { id: "model-a" },
        ],
      });
    });

    const result = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "https://provider.test/v1/",
      apiKey: "sk-secret",
    });

    expect(result.ok).toBe(true);
    expect(result.models).toEqual([
      { id: "model-b", name: "Model B" },
      { id: "model-a", name: "model-a" },
    ]);
    expect(result.resolvedBaseURL).toBe("https://provider.test/v1");
    expect(result.detail).not.toContain("sk-secret");
  });

  it("retries OpenAI discovery under /v1 after a 404", async () => {
    const signals: AbortSignal[] = [];
    mockFetch(async (input, init) => {
      signals.push(init?.signal as AbortSignal);
      if (String(input) === "https://provider.test/models") {
        return new Response(null, { status: 404 });
      }
      expect(String(input)).toBe("https://provider.test/v1/models");
      return Response.json({ data: [{ id: "gpt-test" }] });
    });

    const result = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "https://provider.test",
      apiKey: "secret",
    });

    expect(result.ok).toBe(true);
    expect(result.models).toEqual([{ id: "gpt-test", name: "gpt-test" }]);
    expect(result.resolvedBaseURL).toBe("https://provider.test/v1");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signals[0]).toBe(signals[1]);
  });

  it("discovers Anthropic models with x-api-key auth", async () => {
    mockFetch(async (input, init) => {
      expect(String(input)).toBe("https://provider.test/anthropic/v1/models");
      expect(init?.headers).toMatchObject({
        "x-api-key": "anthropic-secret",
        "anthropic-version": "2023-06-01",
      });
      return Response.json({ data: [{ id: "claude-test", display_name: "Claude Test" }] });
    });

    const result = await discoverLlmModels({
      apiFormat: "anthropic",
      baseURL: "https://provider.test/anthropic",
      apiKey: "anthropic-secret",
      authStyle: "apikey",
    });

    expect(result.ok).toBe(true);
    expect(result.models).toEqual([{ id: "claude-test", name: "Claude Test" }]);
    expect(result.resolvedBaseURL).toBe("https://provider.test/anthropic");
  });

  it("discovers from a pasted full OpenAI endpoint", async () => {
    mockFetch(async (input) => {
      expect(String(input)).toBe("https://provider.test/gateway/v1/models");
      return Response.json({ data: [{ id: "gpt-test" }] });
    });
    const result = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "https://provider.test/gateway/v1/chat/completions",
      apiKey: "secret",
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedBaseURL).toBe("https://provider.test/gateway/v1");
  });

  it("does not treat authentication or redirects as success", async () => {
    mockFetch(async () => new Response("unauthorized", { status: 401 }));
    const denied = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "https://provider.test/v1",
      apiKey: "never-return-this",
    });
    expect(denied).toMatchObject({ ok: false, models: [] });
    expect(denied.detail).toContain("401");
    expect(denied.detail).not.toContain("never-return-this");

    mockFetch(async () => new Response(null, { status: 302, headers: { location: "https://other.test" } }));
    const redirected = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "https://provider.test/v1",
      apiKey: "secret",
    });
    expect(redirected.ok).toBe(false);
    expect(redirected.detail).toContain("302");
  });

  it.each([401, 403, 429, 500, 503])(
    "does not retry OpenAI discovery after HTTP %s",
    async (status) => {
      mockFetch(async () => new Response(null, { status }));
      const result = await discoverLlmModels({
        apiFormat: "openai",
        baseURL: "https://provider.test",
        apiKey: "secret",
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain(String(status));
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a bounded provider error with endpoint path and a redacted key", async () => {
    mockFetch(async () =>
      Response.json(
        {
          error: {
            code: "invalid_api_key",
            message: "Incorrect API key: secret-key",
          },
        },
        { status: 401 },
      ),
    );
    const result = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "https://provider.test/v1",
      apiKey: "secret-key",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("/v1/models");
    expect(result.detail).toContain("invalid_api_key");
    expect(result.detail).toContain("[redacted]");
    expect(result.detail).not.toContain("secret-key");
  });

  it("rejects unsafe URLs before fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const userInfo = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "https://user:pass@provider.test/v1",
      apiKey: "secret",
    });
    const scheme = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "file:///tmp/provider",
      apiKey: "secret",
    });

    expect(userInfo.ok).toBe(false);
    expect(scheme.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("caps response bytes, model count, and model id length", async () => {
    const models = Array.from({ length: 510 }, (_, index) => ({ id: `model-${index}` }));
    models.unshift({ id: "x".repeat(201) });
    mockFetch(async () => Response.json({ data: models }));
    const capped = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "http://127.0.0.1:11434/v1",
    });
    expect(capped.ok).toBe(true);
    expect(capped.models).toHaveLength(500);
    expect(capped.models.every((model) => model.id.length <= 200)).toBe(true);

    let cancelled = false;
    mockFetch(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    }), { headers: { "content-length": String(1024 * 1024 + 1) } }));
    const oversized = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "http://127.0.0.1:11434/v1",
    });
    expect(oversized.ok).toBe(false);
    expect(oversized.detail).toContain("1MiB");
    expect(cancelled).toBe(true);
  });

  it("does not expose keys from network errors", async () => {
    mockFetch(async () => {
      throw new Error("request failed with Authorization: Bearer secret-key");
    });
    const result = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "https://provider.test/v1",
      apiKey: "secret-key",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain("secret-key");
  });

  it("caps streamed responses without a content-length header", async () => {
    mockFetch(async () => new Response("x".repeat(1024 * 1024 + 1)));
    const result = await discoverLlmModels({
      apiFormat: "openai",
      baseURL: "https://provider.test/v1",
      apiKey: "secret-key",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("1MiB");
  });
});

describe("testLlmModelConnection", () => {
  it("tests an OpenAI model through chat completions", async () => {
    mockFetch(async (input, init) => {
      expect(String(input)).toBe("https://provider.test/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-test" });
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    });

    const result = await testLlmModelConnection({
      apiFormat: "openai",
      baseURL: "https://provider.test/v1",
      apiKey: "secret",
      model: "gpt-test",
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.resolvedBaseURL).toBe("https://provider.test/v1");
  });

  it("sends policy headers and records probe usage when present", async () => {
    configureRequestPolicy({ version: "0.2.0-test" });
    const recorded: ModelUsageEntry[] = [];
    configureRequestPolicy({ onUsage: (entry) => recorded.push(entry) });
    let sentHeaders: Headers | undefined;
    mockFetch(async (_input, init) => {
      sentHeaders = new Headers(init?.headers);
      return Response.json({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
    });

    const result = await testLlmModelConnection({
      apiFormat: "openai",
      baseURL: "https://provider.test/v1",
      apiKey: "secret",
      model: "gpt-test",
    });

    expect(result.ok).toBe(true);
    expect(sentHeaders?.get("user-agent")).toBe("margin-agent/0.2.0-test");
    const requestId = sentHeaders?.get("x-client-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recorded).toEqual([{
      path: "probe",
      model: "gpt-test",
      input: 12,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      requestId,
    }]);
    configureRequestPolicy({ onUsage: undefined });
  });

  it("does not record usage when the probe response omits it", async () => {
    const recorded: ModelUsageEntry[] = [];
    configureRequestPolicy({ onUsage: (entry) => recorded.push(entry) });
    mockFetch(async () => Response.json({ choices: [{ message: { content: "ok" } }] }));

    const result = await testLlmModelConnection({
      apiFormat: "openai",
      baseURL: "https://provider.test/v1",
      apiKey: "secret",
      model: "gpt-test",
    });

    expect(result.ok).toBe(true);
    expect(recorded).toEqual([]);
    configureRequestPolicy({ onUsage: undefined });
  });

  it("retries OpenAI chat completions under /v1 after a 405", async () => {
    const signals: AbortSignal[] = [];
    mockFetch(async (input, init) => {
      signals.push(init?.signal as AbortSignal);
      if (String(input) === "https://provider.test/chat/completions") {
        return new Response(null, { status: 405 });
      }
      expect(String(input)).toBe("https://provider.test/v1/chat/completions");
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });

    const result = await testLlmModelConnection({
      apiFormat: "openai",
      baseURL: "https://provider.test",
      apiKey: "secret",
      model: "gpt-test",
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedBaseURL).toBe("https://provider.test/v1");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signals[0]).toBe(signals[1]);
  });

  it("tests an Anthropic model through messages with bearer auth", async () => {
    mockFetch(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:15721/v1/messages");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer proxy-secret",
        "anthropic-version": "2023-06-01",
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-test" });
      return Response.json({ content: [{ type: "text", text: "ok" }] });
    });

    const result = await testLlmModelConnection({
      apiFormat: "anthropic",
      baseURL: "http://127.0.0.1:15721",
      apiKey: "proxy-secret",
      authStyle: "bearer",
      model: "claude-test",
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedBaseURL).toBe("http://127.0.0.1:15721");
  });

  it("rejects an OpenAI reasoning-only response without final text", async () => {
    mockFetch(async () =>
      Response.json({
        choices: [{ message: { content: null, reasoning_content: "internal reasoning" } }],
      }),
    );

    const result = await testLlmModelConnection({
      apiFormat: "openai",
      baseURL: "https://provider.test/v1",
      apiKey: "secret",
      model: "reasoning-test",
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("协议");
  });

  it("rejects an Anthropic thinking-only response without final text", async () => {
    mockFetch(async () =>
      Response.json({ content: [{ type: "thinking", thinking: "internal reasoning" }] }),
    );

    const result = await testLlmModelConnection({
      apiFormat: "anthropic",
      baseURL: "https://provider.test",
      apiKey: "secret",
      authStyle: "apikey",
      model: "thinking-test",
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("协议");
  });
});
