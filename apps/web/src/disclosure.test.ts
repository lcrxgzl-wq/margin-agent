import { describe, expect, it } from "vitest";
import { buildDisclosureText } from "./disclosure";

describe("buildDisclosureText", () => {
  it("joins exported decisions to superseded proposals", () => {
    const text = buildDisclosureText({
      document: { relativePath: "papers/chapter.md" },
      proposals: [
        { id: "p1", status: "superseded", risk: "argument", rationale: "收紧主张" },
        { id: "p2", status: "superseded", risk: "fact", rationale: "补充限定" },
        { id: "p3", status: "superseded", risk: "language", rationale: "调整措辞" },
      ],
      decisions: [
        { proposalId: "p1", kind: "Y" },
        { proposalId: "p2", kind: "E" },
        { proposalId: "p3", kind: "N" },
      ],
    });

    expect(text).toContain("接受/编辑后接受 2 处；拒绝 1 处");
    expect(text).toContain("补充限定（作者编辑后接受）");
  });
});
