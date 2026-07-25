import { describe, expect, it } from "vitest";
import { parseOpenIntent, resolveOpenPath } from "./open-intent.js";

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

  it("opens named path", () => {
    expect(parseOpenIntent("打开 fixtures/sample.md")).toEqual({
      kind: "path",
      relativePath: "fixtures/sample.md",
    });
  });
});

describe("resolveOpenPath", () => {
  const files = ["fixtures/sample.md", "fixtures/agent-chapter.md", "notes/a.md"];

  it("resolves basename", () => {
    expect(resolveOpenPath("sample.md", files)).toBe("fixtures/sample.md");
  });

  it("resolves 样章", () => {
    expect(resolveOpenPath("样章", files)).toBe("fixtures/agent-chapter.md");
  });
});
