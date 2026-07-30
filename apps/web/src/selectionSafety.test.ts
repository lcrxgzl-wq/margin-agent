import { describe, expect, it } from "vitest";
import { filterEditableBlockIds, selectionEditUnavailableReason } from "./selectionSafety";

describe("selectionEditUnavailableReason", () => {
  it("allows one paragraph and one single-paragraph cell", () => {
    expect(selectionEditUnavailableReason({ blockId: "p1", text: "selected" })).toBeNull();
    expect(selectionEditUnavailableReason({
      blockId: "t1",
      text: "selected",
      tableCell: { row: 1, column: 1, address: "A1", before: "selected" },
    })).toBeNull();
  });

  it("rejects a selection that cannot bind to one block", () => {
    expect(selectionEditUnavailableReason({ blockId: null, text: "across paragraphs" }))
      .toMatch(/无法把选区定位到文档段落/);
  });

  it("allows a cross-paragraph selection that resolves to multiple blocks", () => {
    expect(selectionEditUnavailableReason({
      blockId: "p1",
      blockIds: ["p1", "p2"],
      selectionRanges: [
        { blockId: "p1", start: 0, end: 5, before: "first" },
        { blockId: "p2", start: 0, end: 6, before: "second" },
      ],
      text: "firstsecond",
    })).toBeNull();
    const blockIds = Array.from({ length: 24 }, (_, index) => `p${index + 1}`);
    expect(selectionEditUnavailableReason({
      blockId: "p1",
      blockIds,
      selectionRanges: blockIds.map((blockId) => ({ blockId, start: 0, end: 1, before: "x" })),
      text: "x".repeat(24),
    })).toBeNull();
  });

  it("caps cross-paragraph selections at 24 blocks", () => {
    const blockIds = Array.from({ length: 25 }, (_, index) => `p${index + 1}`);
    expect(selectionEditUnavailableReason({
      blockId: "p1",
      blockIds,
      selectionRanges: blockIds.map((blockId) => ({ blockId, start: 0, end: 1, before: "x" })),
      text: "x".repeat(25),
    })).toMatch(/最多覆盖 24 个段落/);
  });

  it("does not fabricate cross-block offsets for Markdown selections", () => {
    expect(selectionEditUnavailableReason({
      blockId: "p1",
      blockIds: ["p1", "p2"],
      text: "first\nsecond",
    })).toMatch(/无法精确定位跨段选区/);
  });

  it("blocks selections spanning multiple table cells with a precise reason", () => {
    const reason = selectionEditUnavailableReason({
      blockId: "ooxml-t-1-x",
      text: "跨格文字",
      tableCell: { row: 1, column: 1, address: "A1", before: "跨格文字" },
      crossTableCells: true,
    });
    expect(reason).toContain("单个单元格");
  });

  it("blocks a cross-cell selection even without cell metadata (thread anchor path)", () => {
    expect(selectionEditUnavailableReason({
      blockId: "ooxml-t-1-x",
      text: "跨格文字",
      crossTableCells: true,
    })).toContain("单个单元格");
  });

  it("rejects a multi-paragraph table cell before proposal generation", () => {
    expect(selectionEditUnavailableReason({
      blockId: "t1",
      text: "first",
      tableCell: { row: 1, column: 1, address: "A1", before: "first\nsecond" },
    })).toMatch(/单元格包含多个段落/);
  });
});

describe("filterEditableBlockIds", () => {
  const blocks = [
    { id: "p1", kind: "paragraph" },
    { id: "t1", kind: "table" },
    { id: "p2", kind: "paragraph" },
    { id: "t2", kind: "table" },
  ];

  it("drops every table block so an all-table selection edits nothing", () => {
    expect(filterEditableBlockIds(["t1", "t2"], blocks)).toEqual({
      editableIds: [],
      skippedTables: 2,
    });
  });

  it("keeps text blocks in order and counts the skipped table", () => {
    expect(filterEditableBlockIds(["p1", "t1", "p2"], blocks)).toEqual({
      editableIds: ["p1", "p2"],
      skippedTables: 1,
    });
  });

  it("bypasses filtering when a table cell is targeted", () => {
    const tableCell = { row: 1, column: 1, address: "A1", before: "cell" };
    expect(filterEditableBlockIds(["t1"], blocks, tableCell)).toEqual({
      editableIds: ["t1"],
      skippedTables: 0,
    });
  });
});
