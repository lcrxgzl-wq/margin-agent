import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDirectProposal } from "./direct-proposal.js";

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

const block = {
  id: "b1",
  kind: "paragraph" as const,
  text: "Original paragraph.",
  order: 0,
  contentHash: "hash-1",
};

let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

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

describe("direct proposal completion", () => {
  it("uses Anthropic messages without tools or tool_choice", async () => {
    process.env.MARGIN_API_FORMAT = "anthropic";
    process.env.MARGIN_BASE_URL = "https://provider.test/gateway";
    process.env.MARGIN_API_KEY = "test-key";
    process.env.MARGIN_AUTH_STYLE = "bearer";
    process.env.MARGIN_MODEL = "deepseek-v4-flash";
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://provider.test/gateway/v1/messages");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: '```json\n{"blockId":"b1","after":"Revised.","rationale":"Clearer.","risk":"language","evidence":[]}\n```',
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const proposal = await generateDirectProposal({ block, instruction: "Make it concise." });

    expect(proposal.after).toBe("Revised.");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestHeaders?.get("authorization")).toBe("Bearer test-key");
    expect(requestBody?.model).toBe("deepseek-v4-flash");
    expect(requestBody).not.toHaveProperty("tools");
    expect(requestBody).not.toHaveProperty("tool_choice");
    expect(requestBody).not.toHaveProperty("response_format");
    expect(requestBody).not.toHaveProperty("temperature");
    expect(requestBody?.max_tokens).toBe(4096);
    const messages = requestBody?.messages as Array<{ content?: string }>;
    expect(messages[0]?.content).toContain("禁止编造文献");
    expect(messages[0]?.content).toContain("风格：问题意识清晰、文献对话、克制可辩护");
    expect(messages[0]?.content).toContain('<skill name="argument-revision-zh">');
  });

  it("uses an OpenAI-compatible chat completion without tool fields", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/gateway/v1/chat/completions";
    process.env.MARGIN_API_KEY = "test-key";
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://provider.test/gateway/v1/chat/completions");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"blockId":"b1","after":"Revised.","rationale":"Clearer.","risk":"language","evidence":[]}',
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateDirectProposal({ block })).resolves.toMatchObject({ blockId: "b1" });
    expect(requestBody).not.toHaveProperty("tools");
    expect(requestBody).not.toHaveProperty("tool_choice");
    expect(requestBody).not.toHaveProperty("response_format");
    expect(requestBody).not.toHaveProperty("temperature");
  });

  it("keeps only evidence references supplied by the Host", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    const sourceRef = "notes/interview.txt#chars=0-120";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        blockId: "b1",
        replacement: "Revised from interview evidence.",
        rationale: "Grounded.",
        risk: "fact",
        evidence: [sourceRef],
      }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const proposal = await generateDirectProposal({
      block,
      selectionText: "Original paragraph.",
      selectionStart: 0,
      operation: "rewrite",
      sourceContext: [{ sourceRef, text: "Interview evidence." }],
    });

    expect(proposal.evidence).toEqual([sourceRef]);
    expect(proposal.operation?.selection?.after).toBe("Revised from interview evidence.");
  });

  it("rejects evidence not present in Host-read material", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        blockId: "b1",
        after: "Revised.",
        rationale: "Grounded.",
        risk: "fact",
        evidence: ["notes/interview.txt#chars=120-240"],
      }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(generateDirectProposal({
      block,
      sourceContext: [{
        sourceRef: "notes/interview.txt#chars=0-120",
        text: "Interview evidence.",
      }],
    })).rejects.toThrow(/outside Host-read material/);
  });

  it("aborts an in-flight direct completion with the external signal", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_input, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    ));
    const controller = new AbortController();
    const pending = generateDirectProposal({ block, signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses mock output when no key is configured, even with a base URL", async () => {
    process.env.MARGIN_BASE_URL = "http://127.0.0.1:12345/v1";
    const fetchMock = vi.fn(() => {
      throw new Error("fetch must not be called without a key");
    });
    vi.stubGlobal("fetch", fetchMock);

    const proposal = await generateDirectProposal({ block });

    expect(proposal.blockId).toBe("b1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("splices a selected translation into the target block", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: '{"blockId":"b1","replacement":"原始段落","rationale":"Translated.","risk":"language","evidence":[]}',
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const proposal = await generateDirectProposal({
      block: { ...block, text: "Before Original paragraph. After" },
      selectionText: "Original paragraph.",
      selectionStart: 7,
      instruction: "Translate to Chinese.",
      operation: "translate",
      targetLanguage: "zh-CN",
    });

    expect(proposal.after).toBe("Before 原始段落 After");
    expect(proposal.operation).toEqual({
      kind: "translate",
      scope: "selection",
      targetLanguage: "zh-CN",
      selection: {
        start: 7,
        end: 26,
        before: "Original paragraph.",
        after: "原始段落",
      },
    });
  });

  it("uses an explicit offset to disambiguate repeated selected text", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: '{"blockId":"b1","replacement":"译文","rationale":"Translated.","risk":"language","evidence":[]}',
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const proposal = await generateDirectProposal({
      block: { ...block, text: "same then same" },
      selectionText: "same",
      selectionStart: 10,
      instruction: "Translate to Chinese.",
      operation: "translate",
      targetLanguage: "zh-CN",
    });

    expect(proposal.after).toBe("same then 译文");
    expect(proposal.operation?.selection?.start).toBe(10);
  });

  it("keeps whitespace around a padded selection replacement", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: '{"blockId":"b1","replacement":"Control or [Mock revision draft]","rationale":"Rewritten.","risk":"language","evidence":[]}',
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const proposal = await generateDirectProposal({
      block: { ...block, text: "Violence Control or Culture Violence?" },
      selectionText: " Control or ",
      selectionStart: 8,
    });

    expect(proposal.after).toBe("Violence Control or [Mock revision draft] Culture Violence?");
    expect(proposal.operation?.selection?.after).toBe(" Control or [Mock revision draft] ");
  });

  it("rejects a full-block response instead of guessing a selection fragment", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: '{"blockId":"b1","after":"Before 译文 After","rationale":"Translated.","risk":"language","evidence":[]}',
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(generateDirectProposal({
      block: { ...block, text: "Before Original paragraph. After" },
      selectionText: "Original paragraph.",
      selectionStart: 7,
      instruction: "Translate to Chinese.",
      operation: "translate",
      targetLanguage: "zh-CN",
    })).rejects.toThrow(/selection replacement/);
  });

  it("rejects an invalid translation after exactly one model request", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              blockId: "b1",
              replacement: "Original paragraph.（原始段落）",
              rationale: "Translated.",
              risk: "language",
              evidence: [],
            }),
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    await expect(generateDirectProposal({
      block: { ...block, text: "Before Original paragraph. After" },
      selectionText: "Original paragraph.",
      selectionStart: 7,
      instruction: "Translate to Chinese.",
      operation: "translate",
      targetLanguage: "zh-CN",
    })).rejects.toThrow(/bilingual source-plus-translation/);

    expect(requestBodies).toHaveLength(1);
    for (const body of requestBodies) {
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("tool_choice");
      expect(body).not.toHaveProperty("response_format");
    }
  });

  it("rejects a short retained source selection without retrying", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            blockId: "b1",
            replacement: "source（来源）",
            rationale: "Translated.",
            risk: "language",
            evidence: [],
          }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateDirectProposal({
      block: { ...block, text: "Before Source After" },
      selectionText: "Source",
      selectionStart: 7,
      operation: "translate",
      targetLanguage: "zh-CN",
    })).rejects.toThrow(/bilingual source-plus-translation/);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a structurally foreign proposal", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"blockId":"other","after":"Revised.","rationale":"Clearer.","risk":"language","evidence":[]}',
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(generateDirectProposal({ block })).rejects.toThrow(/foreign blockId/);
  });

  it("stops reading a streamed response after 1 MiB", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 })),
    );

    await expect(generateDirectProposal({ block })).rejects.toThrow(/exceeds 1 MiB/);
  });

  it("cancels a response body rejected by its declared size", async () => {
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_API_KEY = "test-key";
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1])); },
        cancel() { cancelled = true; },
      }), {
        status: 200,
        headers: { "content-length": String(1024 * 1024 + 1) },
      })),
    );

    await expect(generateDirectProposal({ block })).rejects.toThrow(/exceeds 1 MiB/);
    expect(cancelled).toBe(true);
  });
});
