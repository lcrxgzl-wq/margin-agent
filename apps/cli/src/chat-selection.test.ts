import { describe, expect, it } from "vitest";
import { chatSelectionError } from "./chat-selection.js";

describe("chat selection validation", () => {
  it("accepts an absent or in-budget exact selection", () => {
    expect(chatSelectionError(undefined, 12_000)).toBeUndefined();
    expect(chatSelectionError("x".repeat(12_000), 12_000)).toBeUndefined();
  });

  it("rejects non-text selection payloads", () => {
    expect(chatSelectionError({ text: "selection" }, 12_000)).toEqual({
      statusCode: 400,
      error: "selectionText must be a string",
    });
  });

  it("rejects an oversized selection instead of silently truncating it", () => {
    expect(chatSelectionError("x".repeat(12_001), 12_000)).toEqual({
      statusCode: 413,
      error: expect.stringContaining("12000"),
    });
  });
});
