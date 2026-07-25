import { describe, expect, it } from "vitest";
import type { Block } from "../api";
import { createOfficeBlockResolver, findOfficeBlockId, findSelectionStart } from "./blockSelection";

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
