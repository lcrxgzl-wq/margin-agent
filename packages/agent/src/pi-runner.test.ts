import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPiLoop = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("./pi-loop.js", () => ({
  runPiAgentLoop: vi.fn(async (opts: Record<string, unknown>) => {
    mockPiLoop.calls.push(opts);
    return {
      messages: [],
      outcome: "completed",
      notes: [],
      streamedText: "",
      toolAudit: [],
    };
  }),
}));

const { runPiBlockScan } = await import("./pi-runner.js");

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

const ctx = {
  documentId: "doc- opaque -1",
  revision: 3,
  blocks: [
    { id: "b1", kind: "paragraph" as const, text: "First block.", order: 0, contentHash: "h1" },
  ],
};

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof previousEnv;
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.MARGIN_API_FORMAT = "openai";
  process.env.MARGIN_API_KEY = "test-key";
  process.env.MARGIN_MODEL = "custom-proxy-model";
  mockPiLoop.calls.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("runPiBlockScan request policy", () => {
  it("passes a stable opaque session id derived from the document id", async () => {
    await runPiBlockScan(ctx);
    await runPiBlockScan(ctx);
    expect(mockPiLoop.calls).toHaveLength(2);
    const first = mockPiLoop.calls[0]!.sessionId as string;
    expect(first).toMatch(/^pi-scan-[0-9a-f]{24}$/);
    expect(mockPiLoop.calls[1]!.sessionId).toBe(first);
    expect(first).not.toContain(ctx.documentId);
  });

  it("omits thinking levels for non-compatible models even in explicit modes", async () => {
    await runPiBlockScan({ ...ctx, reasoningMode: "deep" });
    expect(mockPiLoop.calls[0]!.thinkingLevel).toBeUndefined();
    expect(mockPiLoop.calls[0]!.usagePath).toBe("pi-scan");
  });

  it("maps explicit modes when a custom provider opts in", async () => {
    await runPiBlockScan({ ...ctx, reasoningMode: "deep", reasoningOptIn: true });
    expect(mockPiLoop.calls[0]!.thinkingLevel).toBe("high");

    mockPiLoop.calls.length = 0;
    await runPiBlockScan({ ...ctx, reasoningMode: "fast", reasoningOptIn: true });
    expect(mockPiLoop.calls[0]!.thinkingLevel).toBe("low");
  });

  it("keeps reasoning controls off in auto mode", async () => {
    await runPiBlockScan({ ...ctx, reasoningMode: "auto", reasoningOptIn: true });
    expect(mockPiLoop.calls[0]!.thinkingLevel).toBeUndefined();
  });
});
