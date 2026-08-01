import type { ReviewChecklistItem } from "@margin/domain";
import { describe, expect, it } from "vitest";
import {
  CITE_CHECK_DISCLOSURE,
  checklistOpenCount,
  fixedChecklistDisclosure,
  groupChecklistItems,
  replaceChecklistRun,
} from "./reviewChecklists";

const createdAt = "2026-08-01T00:00:00.000Z";
const item = (
  id: string,
  issueType: string,
  blockId: string,
  status: ReviewChecklistItem["status"] = "open",
): ReviewChecklistItem => ({
  schemaVersion: 1,
  id,
  runId: "run-1",
  documentId: "doc-1",
  blockId,
  issueType,
  label: issueType === "style.cliche" ? "套话" : "空泛评价",
  excerpt: id,
  detail: "detail",
  severity: "warn",
  status,
  heuristicOnly: true,
  createdAt,
});

const bundle = (items: ReviewChecklistItem[]) => ({
  run: {
    schemaVersion: 1 as const,
    id: "run-1",
    documentId: "doc-1",
    checker: "style_lint" as const,
    disclaimer: "server text",
    status: "active" as const,
    createdAt,
  },
  items,
});

describe("review checklist view model", () => {
  it("groups by issue type and then paragraph while retaining item status", () => {
    const groups = groupChecklistItems([
      item("i1", "style.cliche", "b2"),
      item("i2", "style.cliche", "b1", "resolved"),
      item("i3", "style.empty_evaluation", "b1"),
    ]);

    expect(groups.map((group) => group.issueType)).toEqual([
      "style.cliche",
      "style.empty_evaluation",
    ]);
    expect(groups[0]?.blocks.map((block) => block.blockId)).toEqual(["b2", "b1"]);
    expect(groups[0]?.blocks[1]?.items[0]?.status).toBe("resolved");
  });

  it("counts only open items and replaces an updated run in place", () => {
    const initial = bundle([item("i1", "style.cliche", "b1")]);
    const updated = bundle([item("i1", "style.cliche", "b1", "dismissed")]);
    expect(checklistOpenCount([initial])).toBe(1);
    expect(checklistOpenCount(replaceChecklistRun([initial], updated))).toBe(0);
  });

  it("uses fixed product disclosures even for zero-finding runs", () => {
    expect(fixedChecklistDisclosure("cite_check")).toBe(CITE_CHECK_DISCLOSURE);
    expect(fixedChecklistDisclosure("cite_check")).toContain("≠ 文献真实存在");
    expect(fixedChecklistDisclosure("style_lint")).toContain("不是全面语体审校");
    expect(checklistOpenCount([{ ...bundle([]), items: [] }])).toBe(0);
  });
});
