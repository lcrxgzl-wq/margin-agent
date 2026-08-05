import { describe, expect, it } from "vitest";
import {
  claimsDocumentOpened,
  isDocumentOpenStatusMessage,
  parseExplicitLocalDocxPath,
} from "./local-document-intent.js";

describe("parseExplicitLocalDocxPath", () => {
  it("accepts a quoted Windows DOCX path pasted into chat", () => {
    expect(
      parseExplicitLocalDocxPath('"E:\\academic\\spviolence\\sport value.docx"'),
    ).toBe("E:\\academic\\spviolence\\sport value.docx");
    expect(
      parseExplicitLocalDocxPath('请打开 “E:\\资料\\访谈 文稿.docx”'),
    ).toBe("E:\\资料\\访谈 文稿.docx");
    expect(
      parseExplicitLocalDocxPath(
        '"E:\\academic\\spviolence\\sport value.docx" 打开这个，我们开始工作',
      ),
    ).toBe("E:\\academic\\spviolence\\sport value.docx");
    expect(
      parseExplicitLocalDocxPath("帮我打开 E:\\academic\\a\\b.docx 并总结"),
    ).toBe("E:\\academic\\a\\b.docx");
  });

  it("rejects relative paths, other formats, and ambiguous paths", () => {
    expect(parseExplicitLocalDocxPath("papers/draft.docx")).toBeNull();
    expect(parseExplicitLocalDocxPath("E:\\papers\\draft.txt")).toBeNull();
    expect(parseExplicitLocalDocxPath("E:\\papers\\draft.docx\n帮我改写")).toBeNull();
    expect(
      parseExplicitLocalDocxPath(
        '比较 "E:\\papers\\first.docx" 和 "E:\\papers\\second.docx"',
      ),
    ).toBeNull();
  });

  it("recognizes opening-status turns and unverified success claims", () => {
    expect(isDocumentOpenStatusMessage("我怎么没看到文档？")).toBe(true);
    expect(isDocumentOpenStatusMessage("讨论运动暴力的研究问题")).toBe(false);
    expect(claimsDocumentOpened("已完成加载，现在你应该能看到文档。")).toBe(true);
    expect(claimsDocumentOpened("系统并未真正打开文档。")).toBe(false);
  });
});
