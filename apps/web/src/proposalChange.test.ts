import { describe, expect, it } from "vitest";
import type { Proposal } from "./api";
import { proposalChange } from "./proposalChange";

const base: Proposal = {
  id: "p1",
  documentId: "d1",
  blockId: "b1",
  baseRevision: 1,
  baseHash: "hash",
  before: "Before source text after",
  after: "Before 译文 after",
  rationale: "Translated.",
  risk: "language",
  evidence: [],
  status: "proposed",
  operation: {
    kind: "translate",
    scope: "selection",
    targetLanguage: "zh-CN",
    selection: { start: 7, end: 18, before: "source text", after: "译文" },
  },
};

describe("proposalChange", () => {
  it("separates a translated fragment from unchanged context", () => {
    const change = proposalChange(base);
    expect(change).toMatchObject({
      scope: "selection",
      kind: "translate",
      beforeFragment: "source text",
      afterFragment: "译文",
      contextBefore: "Before ",
      contextAfter: " after",
    });
  });

  it("composes a fragment edit without changing surrounding text", () => {
    expect(proposalChange(base).composeEditedText("人工译文")).toBe("Before 人工译文 after");
  });

  it("derives a compact change for legacy block proposals", () => {
    const change = proposalChange({ ...base, operation: undefined });
    expect(change.scope).toBe("block");
    expect(change.beforeFragment).toBe("source text");
    expect(change.afterFragment).toBe("译文");
    expect(change.composeEditedText("complete block")).toBe("complete block");
  });

  it("rejects inconsistent structured selection metadata instead of falling back to a block edit", () => {
    expect(() => proposalChange({
      ...base,
      operation: {
        ...base.operation!,
        selection: { start: 7, end: 18, before: "source text", after: "错误译文" },
      },
    })).toThrow(/禁止按整段处理/);
  });

  it("presents one table-cell change without treating it as a full table replacement", () => {
    const change = proposalChange({
      ...base,
      blockId: "table-1",
      before: "90",
      after: "91",
      operation: undefined,
      tableCell: { address: "B2", row: 2, column: 2, before: "90", after: "91" },
    });
    expect(change).toMatchObject({
      kind: "table_cell",
      scope: "table_cell",
      address: "B2",
      beforeFragment: "90",
      afterFragment: "91",
      editValue: "91",
    });
    expect(change.composeEditedText("92")).toBe("92");
  });
});
