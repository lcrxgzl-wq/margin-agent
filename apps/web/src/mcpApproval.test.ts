import { describe, expect, it } from "vitest";
import { formatMcpApprovalArgs } from "./mcpApproval";

describe("MCP approval dialog model", () => {
  it("pretty-prints approval args", () => {
    expect(formatMcpApprovalArgs({ q: "证据", page: 2 })).toBe(
      JSON.stringify({ q: "证据", page: 2 }, null, 2),
    );
    expect(formatMcpApprovalArgs(null)).toBe("null");
    expect(formatMcpApprovalArgs("plain")).toBe('"plain"');
  });

  it("bounds oversized previews", () => {
    const huge = { blob: "x".repeat(10_000) };
    const text = formatMcpApprovalArgs(huge);
    expect(text.length).toBeLessThanOrEqual(4_002);
    expect(text.endsWith("…")).toBe(true);
  });
});
