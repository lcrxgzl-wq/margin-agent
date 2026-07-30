import { describe, expect, it } from "vitest";
import {
  AGENT_TIMEOUT_DEFAULT_SECONDS,
  AGENT_TIMEOUT_MAX_SECONDS,
  agentTimeoutMsToSeconds,
  agentTimeoutSecondsToMs,
} from "./agentTimeout";

describe("agentTimeoutSecondsToMs", () => {
  it("uses a five-minute default and allows up to thirty minutes", () => {
    expect(AGENT_TIMEOUT_DEFAULT_SECONDS).toBe(300);
    expect(AGENT_TIMEOUT_MAX_SECONDS).toBe(1_800);
  });

  it("maps an empty/blank input to null (clear back to default)", () => {
    expect(agentTimeoutSecondsToMs("")).toBeNull();
    expect(agentTimeoutSecondsToMs("   ")).toBeNull();
  });

  it("converts whole seconds to milliseconds", () => {
    expect(agentTimeoutSecondsToMs("10")).toBe(10_000);
    expect(agentTimeoutSecondsToMs("300")).toBe(300_000);
    expect(agentTimeoutSecondsToMs("1800")).toBe(1_800_000);
  });

  it("rejects out-of-range or non-integer input as undefined", () => {
    expect(agentTimeoutSecondsToMs("9")).toBeUndefined();
    expect(agentTimeoutSecondsToMs("1801")).toBeUndefined();
    expect(agentTimeoutSecondsToMs("1.5")).toBeUndefined();
    expect(agentTimeoutSecondsToMs("abc")).toBeUndefined();
  });
});

describe("agentTimeoutMsToSeconds", () => {
  it("renders an unset timeout as empty (default)", () => {
    expect(agentTimeoutMsToSeconds(undefined)).toBe("");
  });

  it("renders a persisted timeout in seconds", () => {
    expect(agentTimeoutMsToSeconds(180_000)).toBe("180");
  });
});
