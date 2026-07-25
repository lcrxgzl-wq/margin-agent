import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateProposal, streamDiscuss } from "./index.js";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "MARGIN_API_FORMAT",
  "MARGIN_API_KEY",
  "MARGIN_AUTH_STYLE",
  "MARGIN_BASE_URL",
  "MARGIN_MODEL",
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
