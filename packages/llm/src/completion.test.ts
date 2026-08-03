import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateProposal, streamDiscuss, translateSelection } from "./index.js";
import { configureRequestPolicy, type ModelUsageEntry } from "./request-policy.js";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "MARGIN_API_FORMAT",
  "MARGIN_API_KEY",
  "MARGIN_AUTH_STYLE",
  "MARGIN_BASE_URL",
  "MARGIN_MODEL",
  "MARGIN_PI_TIMEOUT_MS",
  "MARGIN_PROVIDER",
  "OPENAI_API_KEY",
] as const;

let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

const block = {
  id: "b1",
  kind: "paragraph" as const,
  text: "Original paragraph.",
  order: 0,
  contentHash: "hash-1",
};

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof previousEnv;
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("bounded completion adapter", () => {
  it("uses the Host timeout, then the environment, then the five-minute default", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_API_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        blockId: "b1",
        after: "Revised paragraph.",
        rationale: "Clearer.",
        risk: "language",
        evidence: [],
      }) } }],
    })));
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);

    await generateProposal({ block });
    process.env.MARGIN_PI_TIMEOUT_MS = "45000";
    await generateProposal({ block });
    await generateProposal({ block, timeoutMs: 90_000 });

    expect(timeoutSpy.mock.calls.map(([value]) => value)).toEqual([
      300_000,
      45_000,
      90_000,
    ]);
    timeoutSpy.mockRestore();
  });

  it("requests an OpenAI-compatible proposal without tool fields", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_API_KEY = "secret";
    process.env.MARGIN_MODEL = "model-a";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://provider.test/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "model-a", max_tokens: 4096 });
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("tool_choice");
      expect(body).not.toHaveProperty("response_format");
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          blockId: "b1",
          after: "Revised paragraph.",
          rationale: "Clearer.",
          risk: "language",
          evidence: [],
        }) } }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateProposal({ block })).resolves.toMatchObject({
      blockId: "b1",
      after: "Revised paragraph.",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns a single-shot translation without proposal or tool instructions", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_API_KEY = "secret";
    process.env.MARGIN_MODEL = "model-a";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages[0]?.content).toContain("只输出译文");
      expect(body.messages[1]?.content).toContain("规范的学术英语");
      expect(body.messages[1]?.content).toContain("选区：原文");
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("response_format");
      return Response.json({
        choices: [{
          finish_reason: "stop",
          message: {
            content: "  Translated <thinking>private reasoning</thinking>text.<thinking>unfinished private tail  ",
          },
        }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(translateSelection({ text: "原文", targetLanguage: "en" }))
      .resolves.toBe("Translated text.");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("strips thinking blocks without shifting Unicode output", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_API_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{
        finish_reason: "stop",
        message: { content: "İ<thinking>secret</thinking>Translated" },
      }],
    })));

    await expect(translateSelection({ text: "Original", targetLanguage: "zh-CN" }))
      .resolves.toBe("İTranslated");
  });

  it("raises the output budget for long translations and rejects OpenAI truncation", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_API_KEY = "secret";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens: number };
      expect(body.max_tokens).toBe(16_384);
      return Response.json({
        choices: [{ finish_reason: "length", message: { content: "Partial translation" } }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(translateSelection({ text: "原文".repeat(6_001), targetLanguage: "en" }))
      .rejects.toThrow(/truncated.*token limit/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects Anthropic translations stopped at max_tokens", async () => {
    process.env.MARGIN_API_FORMAT = "anthropic";
    process.env.MARGIN_BASE_URL = "https://provider.test/gateway";
    process.env.MARGIN_API_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "Partial translation" }],
    })));

    await expect(translateSelection({ text: "Original", targetLanguage: "zh-CN" }))
      .rejects.toThrow(/truncated.*token limit/i);
  });

  it("sends policy headers and records token usage on the legacy path", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_API_KEY = "secret";
    process.env.MARGIN_MODEL = "model-a";
    configureRequestPolicy({ version: "0.2.0-test" });
    const recorded: ModelUsageEntry[] = [];
    configureRequestPolicy({ onUsage: (entry) => recorded.push(entry) });
    let sentHeaders: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          blockId: "b1",
          after: "Revised paragraph.",
          rationale: "Clearer.",
          risk: "language",
          evidence: [],
        }) } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      });
    }));

    await expect(generateProposal({ block })).resolves.toMatchObject({ blockId: "b1" });
    expect(sentHeaders?.get("user-agent")).toBe("margin-agent/0.2.0-test");
    const requestId = sentHeaders?.get("x-client-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recorded).toEqual([{
      path: "legacy",
      model: "model-a",
      input: 100,
      output: 25,
      cacheRead: 64,
      cacheWrite: 0,
      requestId,
    }]);
    configureRequestPolicy({ onUsage: undefined });
  });

  it("uses Anthropic Messages with the selected auth style", async () => {
    process.env.MARGIN_API_FORMAT = "anthropic";
    process.env.MARGIN_BASE_URL = "https://provider.test/gateway";
    process.env.MARGIN_API_KEY = "secret";
    process.env.MARGIN_AUTH_STYLE = "bearer";
    process.env.MARGIN_MODEL = "model-b";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://provider.test/gateway/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "model-b", max_tokens: 4096 });
      return Response.json({ content: [{ type: "text", text: "A concise reply." }] });
    }));

    const deltas: string[] = [];
    await expect(streamDiscuss({ message: "Discuss this." }, (chunk) => deltas.push(chunk)))
      .resolves.toBe("A concise reply.");
    expect(deltas.join("")).toBe("A concise reply.");
  });

  it("propagates external cancellation instead of falling back", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_API_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn(async (_input, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })));
    const controller = new AbortController();
    const pending = streamDiscuss({ message: "Discuss this.", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not disguise a configured provider failure as an offline reply", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_API_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("failure", { status: 503 })));

    await expect(streamDiscuss({ message: "Discuss this." })).rejects.toThrow(/HTTP 503/);
  });

  it("cancels a response rejected by its declared size", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_API_KEY = "secret";
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    }), { headers: { "content-length": String(1024 * 1024 + 1) } })));

    await expect(generateProposal({ block })).rejects.toThrow(/exceeds 1 MiB/);
    expect(cancelled).toBe(true);
  });
});
