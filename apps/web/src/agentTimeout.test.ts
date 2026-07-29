import { describe, expect, it } from "vitest";
import {
  agentTimeoutMsToSeconds,
  agentTimeoutSecondsToMs,
} from "./agentTimeout";

describe("agentTimeoutSecondsToMs", () => {
  it("maps an empty/blank input to null (clear back to default)", () => {
    expect(agentTimeoutSecondsToMs("")).toBeNull();
    expect(agentTimeoutSecondsToMs("   ")).toBeNull();
  });

  it("converts whole seconds to milliseconds", () => {
    expect(agentTimeoutSecondsToMs("10")).toBe(10_000);
    expect(agentTimeoutSecondsToMs("120")).toBe(120_000);
    expect(agentTimeoutSecondsToMs("600")).toBe(600_000);
  });

  it("rejects out-of-range or non-integer input as undefined", () => {
    expect(agentTimeoutSecondsToMs("9")).toBeUndefined();
    expect(agentTimeoutSecondsToMs("601")).toBeUndefined();
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
