import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./index.js";

describe("chunkMarkdown block IDs", () => {
  it("keeps a unique paragraph ID stable across positions", () => {
    const [first] = chunkMarkdown("unique paragraph");
    const [, second] = chunkMarkdown("another paragraph\n\nunique paragraph");

    expect(second.id).toBe(first.id);
  });

  it("keeps an existing paragraph ID when text is inserted before it", () => {
    const before = chunkMarkdown("first paragraph\n\nmiddle paragraph\n\nlast paragraph");
    const beforeMiddle = before.find((block) => block.text === "middle paragraph");
    const after = chunkMarkdown(
      "inserted paragraph\n\nfirst paragraph\n\nmiddle paragraph\n\nlast paragraph",
    );
    const afterMiddle = after.find((block) => block.text === "middle paragraph");

    expect(afterMiddle?.id).toBe(beforeMiddle?.id);
  });

  it("suffixes duplicate paragraphs so their IDs are unique", () => {
    const blocks = chunkMarkdown("same paragraph\n\nsame paragraph\n\nsame paragraph");

    expect(blocks.map((block) => block.id)).toEqual([
      blocks[0].id,
      `${blocks[0].id}-2`,
      `${blocks[0].id}-3`,
    ]);
  });
});
