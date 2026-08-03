import { describe, expect, it } from "vitest";
import { contextUsageCopy } from "./contextUsage";

describe("contextUsageCopy", () => {
  it("labels estimated usage without presenting it as provider-exact", () => {
    expect(contextUsageCopy({
      contextWindowTokens: 128_000,
      usedTokens: 12_345,
      usageEstimated: true,
    })).toEqual({
      label: "上下文（估算） 12.3k / 128k",
      title: "当前会话估算 12,345 tokens；模型上下文窗口 128,000 tokens",
    });
  });

  it("omits the estimate qualifier for reported usage", () => {
    expect(contextUsageCopy({
      contextWindowTokens: 200_000,
      usedTokens: 900,
      usageEstimated: false,
    }).label).toBe("上下文 900 / 200k");
  });
});
