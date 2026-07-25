import { describe, expect, it } from "vitest";
import { buildSelectionCommand } from "./commands";

describe("buildSelectionCommand", () => {
  it("keeps the exact table-cell target through the shared selection command", () => {
    expect(buildSelectionCommand(
      "rewrite_directed",
      "table-1",
      "same",
      "translate",
      {
        selectionStart: 10,
        operation: "translate",
        targetLanguage: "zh-CN",
        tableCell: {
          address: "C2",
          row: 2,
          column: 3,
          before: "same then same",
        },
      },
    )).toMatchObject({
      blockId: "table-1",
      selectionStart: 10,
      tableCell: {
        address: "C2",
        row: 2,
        column: 3,
        before: "same then same",
      },
    });
  });
});
