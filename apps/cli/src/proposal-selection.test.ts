import { describe, expect, it } from "vitest";
import {
  assertSelectionBlockCount,
  resolveSelectionContextLimit,
  validateProposalSelectionRanges,
} from "./proposal-selection.js";

const selected = [
  { id: "a", text: "保留甲选中甲" },
  { id: "b", text: "中间整段" },
  { id: "c", text: "选中丙保留丙" },
];

describe("proposal selection validation", () => {
  it("accepts precise edge spans and a fully covered middle block", () => {
    expect(validateProposalSelectionRanges({
      selected,
      selectionText: "选中甲中间整段选中丙",
      selectionStart: 3,
      selectionRanges: [
        { blockId: "a", start: 3, end: 6, before: "选中甲" },
        { blockId: "b", start: 0, end: 4, before: "中间整段" },
        { blockId: "c", start: 0, end: 3, before: "选中丙" },
      ],
    })).toHaveLength(3);
  });

  it("rejects a cross-block selection without exact ranges", () => {
    expect(() => validateProposalSelectionRanges({
      selected: selected.slice(0, 2),
      selectionText: "选中甲中间整段",
    })).toThrow(/无法精确定位跨段选区/);
  });

  it("rejects ranges that would replace unselected edge text", () => {
    expect(() => validateProposalSelectionRanges({
      selected,
      selectionText: "保留甲选中甲中间整段选中丙",
      selectionRanges: [
        { blockId: "a", start: 0, end: 6, before: "保留甲选中甲" },
        { blockId: "b", start: 0, end: 4, before: "中间整段" },
        { blockId: "c", start: 0, end: 3, before: "选中丙" },
      ],
    })).not.toThrow();
    expect(() => validateProposalSelectionRanges({
      selected,
      selectionText: "选中甲中间整段选中丙保留丙",
      selectionRanges: [
        { blockId: "a", start: 3, end: 6, before: "选中甲" },
        { blockId: "b", start: 0, end: 4, before: "中间整段" },
        { blockId: "c", start: 0, end: 6, before: "选中丙保留丙" },
      ],
    })).not.toThrow();
    expect(() => validateProposalSelectionRanges({
      selected,
      selectionText: "选中甲中间整段中丙",
      selectionRanges: [
        { blockId: "a", start: 3, end: 6, before: "选中甲" },
        { blockId: "b", start: 0, end: 4, before: "中间整段" },
        { blockId: "c", start: 1, end: 3, before: "中丙" },
      ],
    })).toThrow(/末段范围必须从段首/);
  });

  it("uses the configured context limit and enforces the 100k hard cap", () => {
    expect(resolveSelectionContextLimit(12_000, 48_000)).toBe(12_000);
    expect(resolveSelectionContextLimit(undefined, 48_000)).toBe(48_000);
    expect(resolveSelectionContextLimit(120_000, 48_000)).toBe(100_000);
  });

  it("rejects more than 24 blocks without truncating", () => {
    expect(() => assertSelectionBlockCount(
      Array.from({ length: 25 }, (_, index) => `p-${index}`),
    )).toThrow(/最多覆盖 24 个段落/);
  });
});
