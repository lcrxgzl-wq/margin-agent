import { describe, expect, it } from "vitest";
import { ProposalSchema, SelectionCommandSchema } from "./browser.js";

describe("browser contracts", () => {
  it("preserves structured selection edit fields", () => {
    const command = SelectionCommandSchema.parse({
      kind: "rewrite_directed",
      blockId: "b1",
      selectionText: "source",
      selectionStart: 12,
      selectionRanges: [{ blockId: "b1", start: 12, end: 18, before: "source" }],
      instruction: "translate",
      operation: "translate",
      targetLanguage: "zh-CN",
      tableCell: { address: "C2", row: 2, column: 3, before: "source source" },
    });
    expect(command).toMatchObject({
      selectionStart: 12,
      selectionRanges: [{ blockId: "b1", start: 12, end: 18, before: "source" }],
      operation: "translate",
      targetLanguage: "zh-CN",
      tableCell: { address: "C2", row: 2, column: 3, before: "source source" },
    });
  });

  it("accepts selection metadata on proposals", () => {
    const proposal = ProposalSchema.parse({
      schemaVersion: 1,
      id: "p1",
      documentId: "d1",
      blockId: "b1",
      baseRevision: 0,
      baseHash: "hash",
      before: "source",
      after: "译文",
      rationale: "translate",
      risk: "language",
      evidence: [],
      operation: {
        kind: "translate",
        scope: "selection",
        targetLanguage: "zh-CN",
        selection: { start: 0, end: 6, before: "source", after: "译文" },
      },
      status: "proposed",
      createdAt: "2026-07-21T00:00:00.000Z",
    });
    expect(proposal.operation?.kind).toBe("translate");
  });

  it("preserves table-cell metadata on proposals", () => {
    const proposal = ProposalSchema.parse({
      schemaVersion: 1,
      id: "p-table-cell",
      documentId: "doc-1",
      blockId: "table-1",
      baseRevision: 1,
      baseHash: "hash",
      before: "90",
      after: "91",
      rationale: "Correct the value.",
      risk: "fact",
      evidence: [],
      tableCell: { address: "B2", row: 2, column: 2, before: "90", after: "91" },
      status: "proposed",
      createdAt: new Date().toISOString(),
    });
    expect(proposal.tableCell?.column).toBe(2);
  });
});
