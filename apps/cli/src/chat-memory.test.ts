import { describe, expect, it } from "vitest";
import { ChatMemory } from "./chat-memory.js";

describe("ChatMemory thread metadata", () => {
  it("keeps thread ids for UI persistence but strips them from LLM history", () => {
    const memory = new ChatMemory();
    memory.hydrate([
      { role: "user", text: "Question", threadId: "thread-1" },
      { role: "assistant", text: "Answer", threadId: "thread-1" },
    ]);

    expect(memory.list()).toEqual([
      { role: "user", text: "Question", threadId: "thread-1" },
      { role: "assistant", text: "Answer", threadId: "thread-1" },
    ]);
    expect(memory.prior()).toEqual([
      { role: "user", text: "Question" },
      { role: "assistant", text: "Answer" },
    ]);
  });

  it("records a new turn against its review thread", () => {
    const memory = new ChatMemory();
    memory.remember("user", "Question", "thread-1");
    memory.remember("assistant", "Answer", "thread-1");

    expect(memory.list().map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
  });

  it("keeps system turns for the UI but excludes them from LLM history", () => {
    const memory = new ChatMemory();
    memory.remember("user", "Question");
    memory.remember("system", "上下文已压缩：约 90000 → 20000 tokens（压缩前记录已存档）");
    memory.remember("assistant", "Answer");

    expect(memory.list().map((turn) => turn.role)).toEqual(["user", "system", "assistant"]);
    expect(memory.prior()).toEqual([
      { role: "user", text: "Question" },
      { role: "assistant", text: "Answer" },
    ]);
  });

  it("hydrates persisted system turns", () => {
    const memory = new ChatMemory();
    memory.hydrate([
      { role: "user", text: "Question" },
      { role: "system", text: "上下文已压缩" },
    ]);

    expect(memory.list().map((turn) => turn.role)).toEqual(["user", "system"]);
  });

  it("cleans literal thinking blocks from live and persisted assistant turns only", () => {
    const memory = new ChatMemory();
    memory.remember("assistant", "Visible<thinking>private</thinking> answer");
    memory.hydrate([
      { role: "user", text: "Quote <thinking>this source tag</thinking> exactly" },
      { role: "assistant", text: "Restored<thinking>hidden tail" },
    ]);

    expect(memory.list()).toEqual([
      { role: "user", text: "Quote <thinking>this source tag</thinking> exactly" },
      { role: "assistant", text: "Restored" },
    ]);
  });

  it("keeps the latest eighty turns for long writing sessions", () => {
    const memory = new ChatMemory();
    memory.hydrate(Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: `turn-${index}`,
    })));

    expect(memory.list()).toHaveLength(80);
    expect(memory.list()[0]?.text).toBe("turn-20");
    expect(memory.prior()).toHaveLength(80);
  });
});
