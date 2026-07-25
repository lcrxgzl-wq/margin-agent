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
});
