import { describe, expect, it } from "vitest";
import { inferTranslationTarget, selectionEditIntent, translateAssistInstruction } from "./selectionEditIntent";

describe("selectionEditIntent", () => {
  it("routes concise translation and polishing commands to direct edits", () => {
    expect(selectionEditIntent("翻译", "An English sentence.")).toMatchObject({ operation: "translate", targetLanguage: "zh-CN" });
    expect(selectionEditIntent("翻译成英文", "中文")).toMatchObject({ operation: "translate", targetLanguage: "en" });
    expect(selectionEditIntent("润色")?.instruction).toContain("润色所选文本");
  });

  it("leaves discussion prompts in chat", () => {
    expect(selectionEditIntent("这段的翻译为什么不准确？")).toBeNull();
    expect(selectionEditIntent("给我三个修改建议")).toBeNull();
  });

  it("infers the opposite working language", () => {
    expect(inferTranslationTarget("This is an English sentence.")).toBe("zh-CN");
    expect(inferTranslationTarget("这是一段中文。" )).toBe("en");
  });

  it("keeps the assist-translate instruction inert to edit triggers", () => {
    expect(translateAssistInstruction("en")).toContain("学术英语");
    expect(translateAssistInstruction("zh-CN")).toContain("简体中文");
    for (const text of [translateAssistInstruction("en"), translateAssistInstruction("zh-CN")]) {
      expect(text).toContain("不写入正文");
      // Must not re-trigger selectionEditIntent (→ rewrite proposal) or the
      // offline planner's 重写|润色|改写|修订 branch (→ mock proposals).
      expect(selectionEditIntent(text, "选区文本")).toBeNull();
      expect(/重写|润色|改写|修订/.test(text)).toBe(false);
    }
  });
});
