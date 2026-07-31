import { describe, expect, it } from "vitest";
import type { Proposal } from "./api";
import {
  proposalMatchesSelection,
  proposalSelectionIdentity,
  sameSelectionIdentity,
  selectionAnchorAlive,
  selectionOwnedByOpenThread,
  selectionClearlyDivergedFromThread,
} from "./selectionIdentity";

function selectionProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "proposal-1",
    documentId: "doc-1",
    blockId: "block-1",
    baseRevision: 1,
    baseHash: "hash-1",
    before: "甲重复文字乙",
    after: "甲修改文字乙",
    rationale: "test",
    risk: "language",
    status: "proposed",
    operation: {
      kind: "rewrite",
      scope: "selection",
      selection: { start: 1, end: 5, before: "重复文字", after: "修改文字" },
    },
    ...overrides,
  };
}

describe("selection identity", () => {
  it("requires block, start, and before text for a selection proposal", () => {
    const proposal = selectionProposal();
    expect(proposalMatchesSelection(proposal, {
      blockId: "block-1",
      selectionStart: 1,
      selectionText: "重复文字",
    })).toBe(true);
    expect(proposalMatchesSelection(proposal, {
      blockId: "block-1",
      selectionStart: 7,
      selectionText: "重复文字",
    })).toBe(false);
    expect(proposalMatchesSelection(proposal, {
      blockId: "block-1",
      selectionStart: 1,
      selectionText: "另一处文字",
    })).toBe(false);
    expect(proposalMatchesSelection(proposal, {
      blockId: "block-2",
      selectionStart: 1,
      selectionText: "重复文字",
    })).toBe(false);
  });

  it("uses the table-cell address within the block", () => {
    const proposal = selectionProposal({
      blockId: "table-1",
      operation: undefined,
      before: "旧值",
      after: "新值",
      tableCell: { address: "B3", row: 3, column: 2, before: "旧值", after: "新值" },
    });
    expect(proposalMatchesSelection(proposal, {
      blockId: "table-1",
      selectionText: "已经变化的显示文字",
      tableCell: { address: "B3", row: 3, column: 2, before: "已经变化的显示文字" },
    })).toBe(true);
    expect(proposalMatchesSelection(proposal, {
      blockId: "table-1",
      selectionText: "旧值",
      tableCell: { address: "C3", row: 3, column: 3, before: "旧值" },
    })).toBe(false);
  });

  it("keeps repeated text at different offsets as separate threads", () => {
    const first = { blockId: "block-1", selectionText: "重复", selectionStart: 2 };
    const second = { blockId: "block-1", selectionText: "重复", selectionStart: 12 };
    expect(sameSelectionIdentity(first, second)).toBe(false);
    expect(proposalSelectionIdentity(selectionProposal())).toMatchObject({
      blockId: "block-1",
      selectionStart: 1,
      selectionText: "重复文字",
    });
  });

  it("matches a cross-block proposal only to its exact persisted range", () => {
    const anchor = {
      blockId: "block-1",
      selectionText: "首段末尾次段开头",
      selectionStart: 4,
      selectionRanges: [
        { blockId: "block-1", start: 4, end: 8, before: "首段末尾" },
        { blockId: "block-2", start: 0, end: 4, before: "次段开头" },
      ],
    };
    const matching = selectionProposal({
      blockId: "block-2",
      before: "次段开头",
      after: "第二段新文",
      operation: {
        kind: "rewrite",
        scope: "selection",
        selection: { start: 0, end: 4, before: "次段开头", after: "第二段新文" },
      },
    });
    const sameBlockWrongRange = selectionProposal({
      blockId: "block-2",
      operation: {
        kind: "rewrite",
        scope: "selection",
        selection: { start: 8, end: 12, before: "次段开头", after: "另一处" },
      },
    });

    expect(proposalMatchesSelection(matching, anchor)).toBe(true);
    expect(proposalMatchesSelection(sameBlockWrongRange, anchor)).toBe(false);
    expect(proposalMatchesSelection(selectionProposal({ blockId: "block-3" }), anchor)).toBe(false);
  });

  it("matches full middle blocks without broadening partial edge ranges", () => {
    const anchor = {
      blockId: "block-1",
      selectionText: "尾部完整中段开头",
      selectionStart: 2,
      selectionRanges: [
        { blockId: "block-1", start: 2, end: 4, before: "尾部" },
        { blockId: "block-2", start: 0, end: 4, before: "完整中段" },
        { blockId: "block-3", start: 0, end: 2, before: "开头" },
      ],
    };
    const middleBlock = selectionProposal({
      blockId: "block-2",
      before: "完整中段",
      after: "修改中段",
      operation: { kind: "rewrite", scope: "block" },
    });
    const partialFirstAsBlock = selectionProposal({
      blockId: "block-1",
      before: "整段尾部",
      after: "错误扩大",
      operation: { kind: "rewrite", scope: "block" },
    });
    const fullLastBlock = selectionProposal({
      blockId: "block-3",
      before: "开头",
      after: "末段新文",
      operation: { kind: "rewrite", scope: "block" },
    });

    expect(proposalMatchesSelection(middleBlock, anchor)).toBe(true);
    expect(proposalMatchesSelection(partialFirstAsBlock, anchor)).toBe(false);
    expect(proposalMatchesSelection(fullLastBlock, anchor)).toBe(true);
  });

  it("keeps a cross-block thread alive while every exact range still matches", () => {
    const anchor = {
      blockId: "block-1",
      selectionText: "尾部开头",
      selectionRanges: [
        { blockId: "block-1", start: 2, end: 4, before: "尾部" },
        { blockId: "block-2", start: 0, end: 2, before: "开头" },
      ],
    };
    expect(selectionAnchorAlive(anchor, [
      { id: "block-1", text: "前文尾部" },
      { id: "block-2", text: "开头后文" },
    ])).toBe(true);
  });

  it("invalidates a cross-block thread when any exact range changes", () => {
    const anchor = {
      blockId: "block-1",
      selectionText: "尾部开头",
      selectionRanges: [
        { blockId: "block-1", start: 2, end: 4, before: "尾部" },
        { blockId: "block-2", start: 0, end: 2, before: "开头" },
      ],
    };
    expect(selectionAnchorAlive(anchor, [
      { id: "block-1", text: "前文尾部" },
      { id: "block-2", text: "改动后文" },
    ])).toBe(false);
  });

  it("checks a single-block anchor at its exact offset when available", () => {
    const blocks = [{ id: "block-1", text: "重复文字与重复文字" }];
    expect(selectionAnchorAlive({
      blockId: "block-1",
      selectionText: "重复文字",
      selectionStart: 0,
    }, blocks)).toBe(true);
    expect(selectionAnchorAlive({
      blockId: "block-1",
      selectionText: "重复文字",
      selectionStart: 2,
    }, blocks)).toBe(false);
    expect(selectionAnchorAlive({
      blockId: "block-1",
      selectionText: "重复文字",
    }, blocks)).toBe(true);
  });

  it("treats precise-start drift as the same span when collapsing threads", () => {
    const thread = {
      blockId: "block-1",
      selectionText: "重复文字",
      selectionStart: 1,
    };
    expect(selectionClearlyDivergedFromThread(thread, {
      blockId: "block-1",
      text: "重复文字",
    })).toBe(false);
    expect(selectionClearlyDivergedFromThread(thread, {
      blockId: "block-1",
      text: "另一段",
    })).toBe(true);
  });

  it("hides the selection bubble only while the open thread owns that exact span", () => {
    const thread = {
      blockId: "block-1",
      selectionText: "重复文字",
      selectionStart: 1,
    };
    expect(selectionOwnedByOpenThread(thread, {
      blockId: "block-1",
      text: "重复文字",
      selectionStart: 1,
    })).toBe(true);
    expect(selectionOwnedByOpenThread(thread, {
      blockId: "block-1",
      text: "另一段",
      selectionStart: 0,
    })).toBe(false);
    expect(selectionOwnedByOpenThread(thread, {
      blockId: null,
      text: "重复文字",
      selectionStart: 1,
    })).toBe(false);
  });
});
