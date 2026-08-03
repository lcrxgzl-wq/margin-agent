import { Schema } from "@tiptap/pm/model";
import { describe, expect, it, vi } from "vitest";
import type { Block } from "./api";
import { blocksToDocJson } from "./doc";
import { resolveMarkdownSelectionStart } from "./markdownSelection";
import { sameTranslationSelectionIdentity } from "./selectionIdentity";

vi.mock("./api", () => ({
  displayText: (block: Block) => {
    if (block.kind === "heading") return block.text.replace(/^#{1,6}\s+/, "");
    if (block.kind === "blockquote") {
      return block.text.split("\n").map((line) => line.replace(/^>\s?/, "")).join("\n");
    }
    return block.text;
  },
}));

const schema = new Schema({
  nodes: {
    doc: { content: "marginBlock+" },
    text: { group: "inline" },
    marginBlock: {
      group: "block",
      content: "inline*",
      attrs: {
        blockId: { default: "" },
        kind: { default: "paragraph" },
        pending: { default: false },
        proposalId: { default: null },
      },
    },
  },
});

function block(overrides: Partial<Block> = {}): Block {
  return {
    id: "block-1",
    kind: "paragraph",
    text: "same then same",
    order: 0,
    contentHash: "hash-1",
    ...overrides,
  };
}

function documentFor(blocks: Block[]) {
  return schema.nodeFromJSON(blocksToDocJson(blocks));
}

describe("Markdown selection coordinates", () => {
  it("distinguishes repeated text inside the same block", () => {
    const blocks = [block()];
    const doc = documentFor(blocks);
    const first = resolveMarkdownSelectionStart(doc, blocks, "block-1", 1, 5, "same");
    const second = resolveMarkdownSelectionStart(doc, blocks, "block-1", 11, 15, "same");

    expect(first).toBe(0);
    expect(second).toBe(10);
    expect(sameTranslationSelectionIdentity({
      blockId: "block-1",
      selectionText: "same",
      selectionStart: first,
    }, {
      blockId: "block-1",
      selectionText: "same",
      selectionStart: second,
    })).toBe(false);
  });

  it("maps rendered heading and quote offsets back to Markdown source offsets", () => {
    const heading = block({ kind: "heading", text: "## same then same" });
    const headingDoc = documentFor([heading]);
    expect(resolveMarkdownSelectionStart(headingDoc, [heading], heading.id, 11, 15, "same"))
      .toBe(13);

    const quote = block({ kind: "blockquote", text: "> same\n> same" });
    const quoteDoc = documentFor([quote]);
    expect(resolveMarkdownSelectionStart(quoteDoc, [quote], quote.id, 6, 10, "same"))
      .toBe(9);
    expect(resolveMarkdownSelectionStart(quoteDoc, [quote], quote.id, 1, 10, "same\nsame"))
      .toBeUndefined();
  });

  it("does not invent a block-local offset for a cross-block selection", () => {
    const blocks = [block(), block({ id: "block-2", text: "tail", order: 1 })];
    const doc = documentFor(blocks);
    expect(resolveMarkdownSelectionStart(doc, blocks, "block-1", 11, 21, "same\ntail"))
      .toBeUndefined();
  });
});
