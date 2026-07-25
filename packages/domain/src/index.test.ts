import { describe, expect, it } from "vitest";
import {
  ProposalSchema,
  DecisionSchema,
  SelectionCommandSchema,
  TableCellProposalSchema,
  assertDecisionInput,
  canApply,
  contentHash,
  textToApply,
  tableCellTextToApply,
} from "./index.js";

const now = "2026-07-18T00:00:00.000Z";

describe("contentHash", () => {
  it("is stable", () => {
    expect(contentHash("你好")).toBe(contentHash("你好"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});

describe("SelectionCommandSchema", () => {
  it("accepts valid selection commands", () => {
    expect(
      SelectionCommandSchema.parse({
        kind: "rewrite_directed",
        blockId: "b123",
        selectionText: "old wording",
        selectionStart: 4,
        instruction: "Make this more direct.",
        operation: "rewrite",
      }),
    ).toMatchObject({ kind: "rewrite_directed", blockId: "b123" });
  });

  it("rejects invalid kind, blank block id, and overlong instruction", () => {
    expect(() => SelectionCommandSchema.parse({ kind: "edit", blockId: "b1" })).toThrow();
    expect(() => SelectionCommandSchema.parse({ kind: "discuss", blockId: "" })).toThrow();
    expect(() =>
      SelectionCommandSchema.parse({
        kind: "rewrite",
        blockId: "b1",
        instruction: "x".repeat(601),
      }),
    ).toThrow();
  });

  it("accepts a structured selection translation operation", () => {
    const proposal = ProposalSchema.parse({
      schemaVersion: 1,
      id: "p-selection",
      documentId: "d1",
      blockId: "b1",
      baseRevision: 0,
      baseHash: contentHash("Before source text after"),
      before: "Before source text after",
      after: "Before 译文 after",
      rationale: "Translate the selected span.",
      risk: "language",
      evidence: [],
      operation: {
        kind: "translate",
        scope: "selection",
        targetLanguage: "zh-CN",
        selection: { start: 7, end: 18, before: "source text", after: "译文" },
      },
      status: "proposed",
      createdAt: now,
    });

    expect(proposal.operation?.selection?.before).toBe("source text");
  });

  it("accepts a structured table-cell proposal in the shared review queue", () => {
    const proposal = ProposalSchema.parse({
      schemaVersion: 1,
      id: "p-table-cell",
      documentId: "doc-1",
      blockId: "table-1",
      baseRevision: 2,
      baseHash: "table-hash",
      before: "Old",
      after: "New",
      rationale: "Update one table cell.",
      risk: "language",
      evidence: [],
      tableCell: { address: "B3", row: 3, column: 2, before: "Old", after: "New" },
      status: "proposed",
      createdAt: new Date().toISOString(),
    });
    expect(proposal.tableCell?.address).toBe("B3");
  });
});

describe("decision rules", () => {
  it("rejects E without editedText", () => {
    expect(() => assertDecisionInput("E")).toThrow();
  });

  it("rejects editedText on Y", () => {
    expect(() => assertDecisionInput("Y", "x")).toThrow();
  });
});

describe("apply derivation", () => {
  const proposal = ProposalSchema.parse({
    schemaVersion: 1,
    id: "p1",
    documentId: "d1",
    blockId: "b1",
    baseRevision: 0,
    baseHash: contentHash("before"),
    before: "before",
    after: "after",
    rationale: "clarify",
    risk: "language",
    evidence: [],
    status: "proposed",
    createdAt: now,
  });

  it("Y uses proposal.after", () => {
    const decision = DecisionSchema.parse({
      schemaVersion: 1,
      id: "dec1",
      proposalId: "p1",
      kind: "Y",
      createdAt: now,
    });
    expect(canApply(proposal, decision)).toBe(true);
    expect(textToApply(proposal, decision)).toBe("after");
  });

  it("E uses editedText without mutating proposal", () => {
    const decision = DecisionSchema.parse({
      schemaVersion: 1,
      id: "dec2",
      proposalId: "p1",
      kind: "E",
      editedText: "edited by human",
      createdAt: now,
    });
    expect(textToApply(proposal, decision)).toBe("edited by human");
    expect(proposal.after).toBe("after");
  });

  it("N is not applicable", () => {
    const decision = DecisionSchema.parse({
      schemaVersion: 1,
      id: "dec3",
      proposalId: "p1",
      kind: "N",
      reason: "no",
      createdAt: now,
    });
    expect(canApply(proposal, decision)).toBe(false);
    expect(textToApply(proposal, decision)).toBeNull();
  });
});

describe("table cell proposal contract", () => {
  const proposal = TableCellProposalSchema.parse({
    schemaVersion: 1,
    id: "table-p1",
    documentId: "d1",
    blockId: "table-1",
    baseRevision: 4,
    baseHash: "table-hash",
    applyMode: "host_table_cell_patch",
    cell: { address: "AB12", row: 12, column: 28, before: "旧值", after: "新值" },
    rationale: "修正单元格措辞。",
    risk: "language",
    evidence: [],
    status: "proposed",
    createdAt: now,
  });

  it("binds an A1 address to one-based row and column", () => {
    expect(proposal.cell).toMatchObject({ address: "AB12", row: 12, column: 28 });
    expect(() => TableCellProposalSchema.parse({
      ...proposal,
      cell: { ...proposal.cell, address: "A12" },
    })).toThrow(/address/);
  });

  it("keeps Y/N/E compatible at the cell text boundary", () => {
    const decision = (kind: "Y" | "N" | "E", editedText?: string) => DecisionSchema.parse({
      schemaVersion: 1,
      id: `decision-${kind}`,
      proposalId: proposal.id,
      kind,
      editedText,
      createdAt: now,
    });
    expect(tableCellTextToApply(proposal, decision("Y"))).toBe("新值");
    expect(tableCellTextToApply(proposal, decision("N"))).toBeNull();
    expect(tableCellTextToApply(proposal, decision("E", "作者改值"))).toBe("作者改值");
  });
});
