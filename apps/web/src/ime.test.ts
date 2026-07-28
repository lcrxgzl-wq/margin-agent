import { describe, expect, it } from "vitest";
import { isSubmitEnter, submitEnterFrom } from "./ime";

describe("isSubmitEnter (IME composition guard)", () => {
  it("submits on plain Enter when composition is inactive", () => {
    expect(isSubmitEnter({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(isSubmitEnter({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("never submits while an IME composition session is active", () => {
    expect(isSubmitEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });

  it("keeps Shift+Enter as a line break, never a submit", () => {
    expect(isSubmitEnter({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(isSubmitEnter({ key: "Enter", shiftKey: true, isComposing: true })).toBe(false);
  });

  it("ignores non-Enter keys", () => {
    expect(isSubmitEnter({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
    expect(isSubmitEnter({ key: "Escape", shiftKey: false, isComposing: false })).toBe(false);
  });

  it("reads isComposing from the native event of a React keyboard event", () => {
    const composing = {
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: true } as KeyboardEvent,
    };
    expect(submitEnterFrom(composing)).toBe(false);
    const settled = {
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false } as KeyboardEvent,
    };
    expect(submitEnterFrom(settled)).toBe(true);
  });
});
