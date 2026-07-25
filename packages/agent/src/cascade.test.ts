import { describe, expect, it } from "vitest";
import {
  assertCanProposeBlock,
  createCascadeGate,
  formatOutlineHint,
  isPrimaryProposeTarget,
  normalizeCascadeOffer,
} from "./cascade.js";
import { createPaperTools } from "./pi-tools.js";
import type { BlockSnapshot } from "@margin/domain";

const blocks: BlockSnapshot[] = [
  {
    id: "h1",
    kind: "heading",
    order: 0,
    text: "# 摘要",
    contentHash: "a",
  },
  {
    id: "b-abs",
    kind: "paragraph",
    order: 1,
    text: "本文讨论县域教育。",
    contentHash: "b",
  },
  {
    id: "h2",
    kind: "heading",
    order: 2,
    text: "## 文献综述",
    contentHash: "c",
  },
  {
    id: "b-lit",
    kind: "paragraph",
    order: 3,
    text: "既有研究强调执行张力。",
    contentHash: "d",
  },
];

describe("cascade gate", () => {
  it("allows selection proposes without scout", () => {
    expect(() =>
      assertCanProposeBlock("b-lit", {
        selectionBlockIds: ["b-lit"],
        enforceCascadeGate: true,
        gate: createCascadeGate(),
      }),
    ).not.toThrow();
  });

  it("blocks out-of-selection propose without confirm", () => {
    expect(() =>
      assertCanProposeBlock("b-abs", {
        selectionBlockIds: ["b-lit"],
        enforceCascadeGate: true,
        gate: createCascadeGate(),
      }),
    ).toThrow(/选区外提案被拒绝/);
  });

  it("allows confirmed cascade after unlock", () => {
    const gate = createCascadeGate();
    expect(() =>
      assertCanProposeBlock("b-abs", {
        selectionBlockIds: ["b-lit"],
        cascadeConfirmedIds: ["b-abs"],
        enforceCascadeGate: true,
        cascadeUnlocked: true,
        gate,
      }),
    ).not.toThrow();
  });

  it("scan primaryAllowlist: outline sees full doc; propose outside fails", async () => {
    const drafts: import("./pi-tools.js").Draft[] = [];
    const tools = createPaperTools(
      {
        getBlocks: () => blocks,
        getDocumentId: () => "doc1",
        getRevision: () => 1,
        proposeScope: {
          primaryAllowlist: ["b-lit"],
          enforceCascadeGate: true,
        },
      },
      drafts,
      [],
      { packId: "none" },
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const outline = await byName.get_document_outline!.execute("1", {});
    const parsed = JSON.parse(outline.content.find((c) => c.type === "text")!.text);
    expect(parsed.map((n: { title: string }) => n.title)).toEqual(["摘要", "文献综述"]);

    await byName.propose_block_edit!.execute("2", {
      blockId: "b-lit",
      after: "修订综述。",
      rationale: "收紧主张。",
    });
    expect(drafts).toHaveLength(1);

    await expect(
      byName.propose_block_edit!.execute("3", {
        blockId: "b-abs",
        after: "修订摘要。",
        rationale: "联动。",
      }),
    ).rejects.toThrow(/选区外提案被拒绝/);
  });

  it("offer_cascade normalizes candidates", () => {
    const offer = normalizeCascadeOffer(
      [
        { blockId: "b-abs", reason: "摘要口径需对齐", query: "县域教育" },
        { blockId: "missing", reason: "x" },
        { blockId: "b-abs", reason: "dup" },
      ],
      blocks,
    );
    expect(offer).toEqual([
      { blockId: "b-abs", reason: "摘要口径需对齐", query: "县域教育" },
    ]);
  });

  it("formatOutlineHint lists titles only", () => {
    const hint = formatOutlineHint(blocks);
    expect(hint).toContain("摘要");
    expect(hint).toContain("文献综述");
    expect(hint).not.toContain("执行张力");
  });

  it("isPrimaryProposeTarget respects allowlist", () => {
    expect(isPrimaryProposeTarget("b-lit", { primaryAllowlist: ["b-lit"] })).toBe(true);
    expect(isPrimaryProposeTarget("b-abs", { primaryAllowlist: ["b-lit"] })).toBe(false);
  });
});
