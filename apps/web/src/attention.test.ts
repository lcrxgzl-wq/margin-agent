import { describe, expect, it } from "vitest";
import { attentionMode, ATTENTION_COPY } from "./attention";

describe("attentionMode", () => {
  it("无选区时是 global", () => {
    expect(attentionMode({ hasSelection: false, selectionBlockCount: 0, sourceCount: 0 })).toBe("global");
    expect(attentionMode({ hasSelection: false, selectionBlockCount: 0, sourceCount: 2 })).toBe("global");
  });

  it("有选区无资料时是 selection", () => {
    expect(attentionMode({ hasSelection: true, selectionBlockCount: 1, sourceCount: 0 })).toBe("selection");
    expect(attentionMode({ hasSelection: true, selectionBlockCount: 3, sourceCount: 0 })).toBe("selection");
  });

  it("有选区且有资料时是 mixed", () => {
    expect(attentionMode({ hasSelection: true, selectionBlockCount: 1, sourceCount: 1 })).toBe("mixed");
    expect(attentionMode({ hasSelection: true, selectionBlockCount: 2, sourceCount: 3 })).toBe("mixed");
  });
});

describe("ATTENTION_COPY", () => {
  it("每个模式都有 label 与 hint", () => {
    for (const mode of ["global", "selection", "mixed"] as const) {
      expect(ATTENTION_COPY[mode].label.length).toBeGreaterThan(0);
      expect(ATTENTION_COPY[mode].hint.length).toBeGreaterThan(0);
    }
  });
});
