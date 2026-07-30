import { describe, expect, it } from "vitest";
import {
  selectionContextCharsToInput,
  selectionContextInputToChars,
} from "./selectionContext";

describe("selectionContextInputToChars", () => {
  it("maps blank input to following the context tier", () => {
    expect(selectionContextInputToChars("")).toBeNull();
    expect(selectionContextInputToChars("   ")).toBeNull();
  });

  it("accepts the full integer boundary", () => {
    expect(selectionContextInputToChars("1000")).toBe(1_000);
    expect(selectionContextInputToChars("64000")).toBe(64_000);
    expect(selectionContextInputToChars("100000")).toBe(100_000);
  });

  it("rejects out-of-range and non-integer values", () => {
    expect(selectionContextInputToChars("999")).toBeUndefined();
    expect(selectionContextInputToChars("100001")).toBeUndefined();
    expect(selectionContextInputToChars("12000.5")).toBeUndefined();
    expect(selectionContextInputToChars("abc")).toBeUndefined();
  });
});

describe("selectionContextCharsToInput", () => {
  it("renders persisted and tier-following values", () => {
    expect(selectionContextCharsToInput(undefined)).toBe("");
    expect(selectionContextCharsToInput(32_000)).toBe("32000");
  });
});
