import { describe, expect, it } from "vitest";
import { inferTranslationTarget, selectionEditIntent } from "./selectionEditIntent";

describe("selectionEditIntent", () => {
  it("routes concise translation and polishing commands to direct edits", () => {
    expect(selectionEditIntent("翻译", "An English sentence.")).toMatchObject({ operation: "translate", targetLanguage: "zh-CN" });
    expect(selectionEditIntent("翻译成英文", "中文")).toMatchObject({
      operation: "translate",
      targetLanguage: "en",
      instruction: expect.stringContaining("规范英语"),
    });
    expect(selectionEditIntent("润色")?.instruction).toContain("准确、清楚、克制");
    expect(selectionEditIntent("润色")?.instruction).not.toContain("学术");
  });

  it("leaves discussion prompts in chat", () => {
    expect(selectionEditIntent("这段的翻译为什么不准确？")).toBeNull();
    expect(selectionEditIntent("给我三个修改建议")).toBeNull();
  });

  it("infers the opposite working language", () => {
    expect(inferTranslationTarget("This is an English sentence.")).toBe("zh-CN");
    expect(inferTranslationTarget("这是一段中文。" )).toBe("en");
  });
});
