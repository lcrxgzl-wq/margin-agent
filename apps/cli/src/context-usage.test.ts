import { describe, expect, it } from "vitest";
import { buildContextUsage } from "./context-usage.js";

describe("buildContextUsage", () => {
  it("uses the latest provider-reported context usage", () => {
    const context = buildContextUsage([
      { role: "user", content: "hello", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "world" }],
        stopReason: "stop",
        usage: {
          input: 90,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 100,
        },
        timestamp: 2,
      },
    ] as never, 128_000);

    expect(context).toEqual({
      contextWindowTokens: 128_000,
      usedTokens: 100,
      usageEstimated: false,
    });
  });

  it("labels the serialized transcript fallback as an estimate", () => {
    const context = buildContextUsage([
      { role: "user", content: "hello", timestamp: 1 },
    ] as never, 200_000);

    expect(context.contextWindowTokens).toBe(200_000);
    expect(context.usedTokens).toBeGreaterThan(0);
    expect(context.usageEstimated).toBe(true);
  });

  it("ignores zero-token failures and estimates messages after valid usage", () => {
    const context = buildContextUsage([
      {
        role: "assistant",
        content: [{ type: "text", text: "prior" }],
        stopReason: "stop",
        usage: { totalTokens: 100, input: 90, output: 10 },
        timestamp: 1,
      },
      { role: "user", content: "next request", timestamp: 2 },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "Connection error",
        usage: { totalTokens: 0, input: 0, output: 0 },
        timestamp: 3,
      },
    ] as never, 128_000);

    expect(context.usedTokens).toBeGreaterThan(100);
    expect(context.usageEstimated).toBe(true);
  });

  it("does not reuse provider usage from before a compaction summary", () => {
    const context = buildContextUsage([
      {
        role: "assistant",
        content: [{ type: "text", text: "old" }],
        stopReason: "stop",
        usage: { totalTokens: 90_000 },
        timestamp: 1,
      },
      {
        role: "user",
        content: "此前对话已压缩为以下摘要：\n\nsummary",
        timestamp: 2,
      },
    ] as never, 128_000);

    expect(context.usedTokens).toBeLessThan(90_000);
    expect(context.usageEstimated).toBe(true);
  });

  it("reports an empty session as zero estimated tokens", () => {
    expect(buildContextUsage([], 128_000)).toEqual({
      contextWindowTokens: 128_000,
      usedTokens: 0,
      usageEstimated: true,
    });
  });
});
