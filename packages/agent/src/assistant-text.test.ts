import { describe, expect, it } from "vitest";
import {
  LiteralThinkingBlockFilter,
  stripLiteralThinkingBlocks,
} from "./assistant-text.js";

describe("stripLiteralThinkingBlocks", () => {
  it("removes a closed thinking block", () => {
    expect(stripLiteralThinkingBlocks("before<thinking>private</thinking>after"))
      .toBe("beforeafter");
  });

  it("removes multiple thinking blocks", () => {
    expect(stripLiteralThinkingBlocks(
      "a<thinking>one</thinking>b<THINKING>two</THINKING>c",
    )).toBe("abc");
  });

  it("drops an unclosed thinking tail", () => {
    expect(stripLiteralThinkingBlocks("answer<thinking>unfinished private text"))
      .toBe("answer");
  });

  it("leaves text without thinking tags unchanged", () => {
    const text = "普通回答\nwith <other>literal markup</other> and symbols.";
    expect(stripLiteralThinkingBlocks(text)).toBe(text);
  });

  it("does not shift source indexes when visible Unicode expands on lowercase", () => {
    expect(stripLiteralThinkingBlocks("İ<thinking>private</thinking>Visible"))
      .toBe("İVisible");
  });
});

describe("LiteralThinkingBlockFilter", () => {
  it("removes tags and content split across delta boundaries", () => {
    const filter = new LiteralThinkingBlockFilter();
    const chunks = [
      "Visible <thi",
      "nking>Continue reading chunks</think",
      "ing> answer",
    ];

    const visible = chunks.map((chunk) => filter.push(chunk)).join("") + filter.finish();

    expect(visible).toBe("Visible  answer");
  });

  it("drops an unclosed streamed thinking tail", () => {
    const filter = new LiteralThinkingBlockFilter();
    const visible = filter.push("answer<think")
      + filter.push("ing>unfinished")
      + filter.finish();

    expect(visible).toBe("answer");
  });

  it("keeps Unicode boundaries stable when tags span chunks", () => {
    const filter = new LiteralThinkingBlockFilter();
    const visible = filter.push("İ<THI")
      + filter.push("NKING>private</THINK")
      + filter.push("ING>Visible")
      + filter.finish();

    expect(visible).toBe("İVisible");
  });

  it("preserves untagged text even when a chunk ends like a tag prefix", () => {
    const filter = new LiteralThinkingBlockFilter();
    const visible = filter.push("plain <thi")
      + filter.push("s remains literal")
      + filter.finish();

    expect(visible).toBe("plain <this remains literal");
  });
});
