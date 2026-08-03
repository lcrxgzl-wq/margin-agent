import { describe, expect, it, vi } from "vitest";
import { refreshSessionContextUsage } from "./sessionContextUsage";

describe("refreshSessionContextUsage", () => {
  it("stores the latest server-authoritative context usage", async () => {
    const usage = {
      contextWindowTokens: 128_000,
      usedTokens: 12_345,
      usageEstimated: true,
    };
    const setContextUsage = vi.fn();

    await expect(refreshSessionContextUsage(
      async () => ({ context: usage }),
      setContextUsage,
    )).resolves.toBe(true);
    expect(setContextUsage).toHaveBeenCalledWith(usage);
  });

  it("hides stale usage when the refresh itself fails", async () => {
    const setContextUsage = vi.fn();

    await expect(refreshSessionContextUsage(
      async () => { throw new Error("offline"); },
      setContextUsage,
    )).resolves.toBe(false);
    expect(setContextUsage).toHaveBeenCalledWith(null);
  });
});
