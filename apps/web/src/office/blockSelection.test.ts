import { describe, expect, it } from "vitest";
import type { Block } from "../api";
import {
  buildOfficeSelectionRanges,
  canvasFocusRangeIndexes,
  createOfficeBlockResolver,
  findOfficeBlockId,
  findSelectionStart,
  resolveOfficeBlocksForRange,
  splitOfficeSelectionParagraphs,
} from "./blockSelection";

const blocks: Block[] = [
  { id: "p-1", kind: "paragraph", text: "第一段中文内容", order: 0, contentHash: "a" },
  { id: "t-1", kind: "table", text: "姓名\t分数\n张三\t90", order: 1, contentHash: "b" },
  { id: "p-2", kind: "paragraph", text: "末段内容", order: 2, contentHash: "c" },
];

describe("findOfficeBlockId", () => {
  it("matches a paragraph while ignoring layout whitespace", () => {
    expect(findOfficeBlockId(blocks, { paragraphText: "第一段 中文内容" })).toBe("p-1");
  });

  it("prefers a table block for a selected cell", () => {
    expect(findOfficeBlockId(blocks, { selectionText: "张三", isTable: true })).toBe("t-1");
  });

  it("uses the paragraph ordinal when an empty paragraph is selected", () => {
    expect(findOfficeBlockId(blocks, { paragraphNo: 1 })).toBe("p-2");
  });

  it("uses the paragraph ordinal to disambiguate repeated text", () => {
    const repeated = [
      ...blocks,
      { id: "p-3", kind: "paragraph", text: "第一段中文内容", order: 3, contentHash: "d" },
    ];
    expect(findOfficeBlockId(repeated, {
      paragraphText: "第一段中文内容",
      paragraphNo: 2,
    })).toBe("p-3");
  });

  it("uses the OOXML body index after an unindexed empty paragraph", () => {
    const indexed: Block[] = [
      { id: "ooxml-p-0-a", kind: "paragraph", text: "重复段落", order: 0, contentHash: "a" },
      { id: "ooxml-p-2-b", kind: "paragraph", text: "重复段落", order: 1, contentHash: "b" },
    ];
    expect(findOfficeBlockId(indexed, { paragraphText: "重复段落", paragraphNo: 2 })).toBe("ooxml-p-2-b");
  });

  it("keeps the OOXML body target stable after its text changes", () => {
    const indexed: Block[] = [
      { id: "ooxml-p-4-a", kind: "paragraph", text: "Before", order: 0, contentHash: "a" },
      { id: "ooxml-p-7-b", kind: "paragraph", text: "Other", order: 1, contentHash: "b" },
    ];
    expect(findOfficeBlockId(indexed, { paragraphNo: 4 })).toBe("ooxml-p-4-a");
  });

  it("uses the OOXML body index for table content changes", () => {
    const indexed: Block[] = [
      { id: "ooxml-t-6-a", kind: "table", text: "A\tB", order: 0, contentHash: "a" },
      { id: "ooxml-t-9-b", kind: "table", text: "C\tD", order: 1, contentHash: "b" },
    ];
    expect(findOfficeBlockId(indexed, { paragraphNo: 9, isTable: true })).toBe("ooxml-t-9-b");
  });
});

describe("createOfficeBlockResolver text validation", () => {
  it("rejects bodyIndex match when provided text does not score", () => {
    const blocks = [
      { id: "ooxml-p-0-aaa", kind: "paragraph", text: "第一段正文" },
      { id: "ooxml-t-1-bbb", kind: "table", text: "表格内容" },
      { id: "ooxml-p-2-ccc", kind: "paragraph", text: "表格后的段落" },
    ] as unknown as Block[];
    const resolve = createOfficeBlockResolver(blocks);
    // paragraphNo=1 错位指到 table，但文本是正文段落 → 不得返回 table 块
    const id = resolve({ paragraphNo: 1, paragraphText: "表格后的段落" });
    expect(id).toBe("ooxml-p-2-ccc");
  });

  it("returns null instead of blind ordinal fallback when text queries score zero", () => {
    const blocks = [
      { id: "ooxml-p-0-aaa", kind: "paragraph", text: "完全无关的内容" },
    ] as unknown as Block[];
    const resolve = createOfficeBlockResolver(blocks);
    expect(resolve({ paragraphNo: 0, paragraphText: "无法匹配的文字" })).toBeNull();
  });
});

describe("findSelectionStart", () => {
  it("uses the preferred exact occurrence for repeated text", () => {
    expect(findSelectionStart("same then same", "same", 10)).toBe(10);
  });

  it("resolves repeated text against the selected cell rather than the flattened table", () => {
    const cellText = "same then same";
    expect(findSelectionStart(cellText, "same", 10)).toBe(10);
    expect(findSelectionStart(blocks[1]!.text, "same", 10)).toBeNull();
  });

  it("does not guess between repeated text without a range hint", () => {
    expect(findSelectionStart("same then same", "same")).toBeNull();
  });
});

describe("canvasFocusRangeIndexes", () => {
  it("applies empty-paragraph stream drift before focusing a keyword range", () => {
    expect(canvasFocusRangeIndexes({ startIndex: 40, endIndex: 44 }, 3)).toEqual({
      startIndex: 42,
      endIndex: 47,
    });
  });

  it("keeps the executeSetRange start boundary non-negative", () => {
    expect(canvasFocusRangeIndexes({ startIndex: 0, endIndex: 2 }, 0)).toEqual({
      startIndex: 0,
      endIndex: 2,
    });
  });
});

describe("precise Office selection ranges", () => {
  const rangeBlocks = [
    { id: "a", kind: "paragraph", text: "same then same", order: 0, contentHash: "a" },
    { id: "b", kind: "paragraph", text: "middle", order: 1, contentHash: "b" },
    { id: "c", kind: "paragraph", text: "tail kept", order: 2, contentHash: "c" },
  ] as Block[];

  it("ignores a phantom trailing paragraph when a paragraph-start selection has one fragment", () => {
    const indexed = [
      { id: "ooxml-p-3-heading", kind: "paragraph", text: "Abstract", order: 0, contentHash: "h" },
      { id: "ooxml-p-4-body", kind: "paragraph", text: "Paragraph starts here and continues.", order: 1, contentHash: "b" },
      { id: "ooxml-p-5-keywords", kind: "paragraph", text: "Keywords", order: 2, contentHash: "k" },
    ] as Block[];
    expect(resolveOfficeBlocksForRange(
      createOfficeBlockResolver(indexed),
      { startParagraphNo: 4, endParagraphNo: 5 },
      "Paragraph starts here",
      "Paragraph starts here and continues.",
      ["Paragraph starts here and continues."],
    )).toEqual({ blockId: "ooxml-p-4-body", blockIds: undefined });
  });

  it("splits cross-paragraph canvas elements at paragraph sentinels", () => {
    expect(splitOfficeSelectionParagraphs([
      { value: "same" },
      { value: "\u200b" },
      { value: "middle" },
      { value: "\u200b" },
      { value: "tail" },
    ], 3)).toEqual(["same", "middle", "tail"]);
  });

  it("splits newline sentinels and preserves empty canvas paragraphs", () => {
    expect(splitOfficeSelectionParagraphs([
      { value: "tail" },
      { value: "\n" },
      { value: "" },
      { value: "\n" },
      { value: "head" },
    ], 3)).toEqual(["tail", "", "head"]);
  });

  it("keeps grouped title content as its own paragraph", () => {
    expect(splitOfficeSelectionParagraphs([
      { value: "end" },
      { type: "title", valueList: [{ value: "Heading" }] },
      { value: "\u200b" },
      { value: "next" },
    ], 3)).toEqual(["end", "Heading", "next"]);
  });

  it("builds partial first/last ranges and a full middle range", () => {
    expect(buildOfficeSelectionRanges(
      rangeBlocks,
      ["a", "b", "c"],
      "samemiddletail",
      ["same", "middle", "tail"],
    )).toEqual([
      { blockId: "a", start: 10, end: 14, before: "same" },
      { blockId: "b", start: 0, end: 6, before: "middle" },
      { blockId: "c", start: 0, end: 4, before: "tail" },
    ]);
  });

  it("uses an exact single-block offset for repeated short text", () => {
    expect(buildOfficeSelectionRanges(
      rangeBlocks,
      ["a"],
      "same",
      ["same"],
      10,
    )).toEqual([{ blockId: "a", start: 10, end: 14, before: "same" }]);
    expect(buildOfficeSelectionRanges(rangeBlocks, ["a"], "same", ["same"])).toBeNull();
  });

  it("returns null instead of fabricating a mismatched edge offset", () => {
    expect(buildOfficeSelectionRanges(
      rangeBlocks,
      ["a", "c"],
      "then tail",
      ["then ", "tail"],
    )).toBeNull();
  });

  it("skips empty OOXML paragraphs and aligns canvas boundary whitespace", () => {
    const fixtureBlocks = [
      { id: "ooxml-p-0-a", kind: "paragraph", text: "Body tail", order: 0, contentHash: "a" },
      { id: "ooxml-p-2-b", kind: "paragraph", text: "Abstract:", order: 1, contentHash: "b" },
      { id: "ooxml-p-4-c", kind: "paragraph", text: "Keywords: agent", order: 2, contentHash: "c" },
    ] as Block[];
    const fragments = ["tail", "", "Abstract: ", "   ", "Keywords"];
    const selectionText = fragments.join("");
    const resolved = resolveOfficeBlocksForRange(
      createOfficeBlockResolver(fixtureBlocks),
      { startParagraphNo: 0, endParagraphNo: 4 },
      selectionText,
      "",
      fragments,
    );

    expect(resolved).toEqual({
      blockId: "ooxml-p-0-a",
      blockIds: ["ooxml-p-0-a", "ooxml-p-2-b", "ooxml-p-4-c"],
    });
    const ranges = buildOfficeSelectionRanges(
      fixtureBlocks,
      resolved.blockIds!,
      selectionText,
      fragments,
    );
    expect(ranges).toEqual([
      { blockId: "ooxml-p-0-a", start: 5, end: 9, before: "tail" },
      { blockId: "ooxml-p-2-b", start: 0, end: 9, before: "Abstract:" },
      { blockId: "ooxml-p-4-c", start: 0, end: 8, before: "Keywords" },
    ]);
    expect(ranges?.map((range) => range.before).join(""))
      .toBe("tailAbstract:Keywords");
  });
});
