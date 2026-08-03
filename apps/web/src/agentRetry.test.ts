import { describe, expect, it } from "vitest";
import {
  AGENT_RETRY_ATTEMPTS_DEFAULT,
  AGENT_RETRY_DELAY_DEFAULT_SECONDS,
  retryAttemptsFromInput,
  retryAttemptsToInput,
  retryDelayMsToSeconds,
  retryDelaySecondsToMs,
} from "./agentRetry";

describe("agent retry settings", () => {
  it("defines five total attempts with a thirty-second default delay", () => {
    expect(AGENT_RETRY_ATTEMPTS_DEFAULT).toBe(5);
    expect(AGENT_RETRY_DELAY_DEFAULT_SECONDS).toBe(30);
  });

  it("converts valid inputs and uses null to restore defaults", () => {
    expect(retryAttemptsFromInput("5")).toBe(5);
    expect(retryDelaySecondsToMs("30")).toBe(30_000);
    expect(retryAttemptsFromInput(" ")).toBeNull();
    expect(retryDelaySecondsToMs("")).toBeNull();
    expect(retryAttemptsToInput(undefined)).toBe("");
    expect(retryDelayMsToSeconds(undefined)).toBe("");
  });

  it("rejects fractional and out-of-range values", () => {
    expect(retryAttemptsFromInput("0")).toBeUndefined();
    expect(retryAttemptsFromInput("11")).toBeUndefined();
    expect(retryAttemptsFromInput("2.5")).toBeUndefined();
    expect(retryDelaySecondsToMs("-1")).toBeUndefined();
    expect(retryDelaySecondsToMs("301")).toBeUndefined();
    expect(retryDelaySecondsToMs("0.5")).toBeUndefined();
  });
});
