import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "./api";
import { excerpt, filterTimeline, historyEntryView, operationLabel } from "./reviewHistory";

function entry(overrides: Partial<TimelineEntry>): TimelineEntry {
  return {
    id: "e1",
    createdAt: "2026-07-23T10:00:00.000Z",
    ok: true,
    reason: null,
    proposalId: "p1",
    decisionId: "d1",
    blockId: "b1",
    rationale: "rationale",
    risk: "language",
    decisionKind: "Y",
    operationKind: "translate",
    beforeText: "source text",
    afterText: "译文",
    beforeRevision: 1,
    afterRevision: 2,
    ...overrides,
  };
}

describe("operationLabel", () => {
  it("maps known operation kinds and falls back sensibly", () => {
    expect(operationLabel("translate")).toBe("翻译");
    expect(operationLabel("table_cell")).toBe("表格");
    expect(operationLabel(null)).toBe("提案");
    expect(operationLabel("custom_op")).toBe("custom_op");
  });
});

describe("excerpt", () => {
  it("keeps null, marks empty text, flattens whitespace and truncates", () => {
    expect(excerpt(null)).toBeNull();
    expect(excerpt("  \n ")).toBe("（空）");
    expect(excerpt("a\nb\tc")).toBe("a b c");
    const long = "字".repeat(60);
    expect(excerpt(long)).toBe(`${"字".repeat(48)}…`);
    expect(excerpt(long, 10)).toBe(`${"字".repeat(10)}…`);
  });
});

describe("historyEntryView", () => {
  it("describes an accepted translation", () => {
    expect(historyEntryView(entry({}))).toEqual({
      action: "翻译 → Y 接受",
      accepted: true,
      beforeExcerpt: "source text",
      afterExcerpt: "译文",
    });
  });

  it("describes an edited-then-accepted entry", () => {
    const view = historyEntryView(
      entry({ decisionKind: "E", operationKind: "polish", afterText: "人工编辑后的文本" }),
    );
    expect(view.action).toBe("润色 → E 编辑后接受");
    expect(view.afterExcerpt).toBe("人工编辑后的文本");
  });

  it("describes a rejected entry", () => {
    const view = historyEntryView(entry({ decisionKind: "N", ok: false, reason: "rejected" }));
    expect(view.action).toBe("翻译 → N 拒绝");
    expect(view.accepted).toBe(false);
  });

  it("labels an accepted decision whose apply failed as an apply failure", () => {
    const view = historyEntryView(entry({ decisionKind: "Y", ok: false, reason: "stale" }));
    expect(view.action).toBe("翻译 → 应用失败（stale）");
    expect(view.accepted).toBe(false);
  });

  it("falls back when an apply failure has no reason", () => {
    const view = historyEntryView(entry({ decisionKind: "E", ok: false, reason: null }));
    expect(view.action).toBe("翻译 → 应用失败（未知原因）");
  });

  it("tolerates missing fragments", () => {
    const view = historyEntryView(entry({ beforeText: null, afterText: null, operationKind: null }));
    expect(view.action).toBe("提案 → Y 接受");
    expect(view.beforeExcerpt).toBeNull();
    expect(view.afterExcerpt).toBeNull();
  });
});

describe("filterTimeline", () => {
  const entries = [
    entry({ id: "a", ok: true }),
    entry({ id: "b", ok: false, decisionKind: "N", reason: "rejected" }),
    entry({ id: "c", ok: true }),
    entry({ id: "d", ok: false, decisionKind: "Y", reason: "stale" }),
    entry({ id: "e", ok: false, decisionKind: "Y", reason: "missing" }),
  ];

  it("returns everything for the all filter", () => {
    expect(filterTimeline(entries, "all").map((e) => e.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps only applied entries for accepted", () => {
    expect(filterTimeline(entries, "accepted").map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("keeps only user rejections for rejected, excluding apply failures", () => {
    expect(filterTimeline(entries, "rejected").map((e) => e.id)).toEqual(["b"]);
  });
});
