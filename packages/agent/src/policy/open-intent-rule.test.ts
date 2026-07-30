import { describe, expect, it } from "vitest";
import {
  parseOpenIntent,
  parseReadIntent,
  resolveOpenPath,
  unwrapPathToken,
} from "./open-intent-rule.js";

describe("parseOpenIntent", () => {
  it("treats bare 打开文稿 as list, not a filename", () => {
    expect(parseOpenIntent("打开文稿")).toEqual({ kind: "list" });
    expect(parseOpenIntent("打开")).toEqual({ kind: "list" });
    expect(parseOpenIntent("打开文章")).toEqual({ kind: "list" });
  });

  it("opens sample chapter", () => {
    expect(parseOpenIntent("打开样章")).toEqual({
      kind: "path",
      relativePath: "fixtures/agent-chapter.md",
    });
  });

  it("keeps spaces and quotes in relative DOCX paths", () => {
    expect(parseOpenIntent("打开 imports/sport value.docx")).toEqual({
      kind: "path",
      relativePath: "imports/sport value.docx",
    });
    expect(parseOpenIntent('打开 "imports/sport value.docx"')).toEqual({
      kind: "path",
      relativePath: "imports/sport value.docx",
    });
    expect(parseOpenIntent("打开《imports/sport value.docx》")).toEqual({
      kind: "path",
      relativePath: "imports/sport value.docx",
    });
  });

  it("opens after 打开文件/文章 phrasing", () => {
    expect(parseOpenIntent("打开文件 paper.md")).toEqual({
      kind: "path",
      relativePath: "paper.md",
    });
    expect(parseOpenIntent("打开文章 notes/a.md")).toEqual({
      kind: "path",
      relativePath: "notes/a.md",
    });
  });
});

describe("resolveOpenPath", () => {
  const files = [
    "fixtures/sample.md",
    "fixtures/agent-chapter.md",
    "notes/a.md",
    "imports/sport value.docx",
  ];

  it("resolves basename and 样章", () => {
    expect(resolveOpenPath("sample.md", files)).toBe("fixtures/sample.md");
    expect(resolveOpenPath("样章", files)).toBe("fixtures/agent-chapter.md");
  });

  it("resolves spaced DOCX paths and passes through missing docx", () => {
    expect(resolveOpenPath("sport value.docx", files)).toBe("imports/sport value.docx");
    expect(resolveOpenPath("drafts/new paper.docx", files)).toBe("drafts/new paper.docx");
  });
});

describe("parseReadIntent", () => {
  it("keeps quoted paths with spaces", () => {
    expect(parseReadIntent('读取 "notes/interview notes.txt"')).toBe(
      "notes/interview notes.txt",
    );
    expect(unwrapPathToken("「资料.pdf」")).toBe("资料.pdf");
  });
});
