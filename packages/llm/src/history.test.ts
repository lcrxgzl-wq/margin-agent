import { describe, expect, it } from "vitest";
import { formatHistoryForPrompt, trimHistory } from "./history.js";
import { generateDiscuss, mockAgentReply } from "./index.js";

describe("chat history helpers", () => {
  it("trims to last N turns", () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `t${i}`,
    }));
    expect(trimHistory(turns, 4)).toEqual(turns.slice(-4));
  });

  it("formats transcript for prompt", () => {
    const s = formatHistoryForPrompt([
      { role: "user", text: "讨论问题意识" },
      { role: "assistant", text: "先看现象" },
    ]);
    expect(s).toContain("用户: 讨论问题意识");
    expect(s).toContain("助手: 先看现象");
  });

  it("answers identity without forcing open document", () => {
    const text = mockAgentReply({ message: "你是谁" });
    expect(text).toMatch(/Margin|边注/);
    expect(text).not.toMatch(/请先打开一篇文章/);
  });

  it("mock discuss bridges prior user turn", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.MARGIN_API_KEY;
    delete process.env.MARGIN_BASE_URL;
    const text = await generateDiscuss({
      message: "展开刚才那点，怎么落到材料上",
      history: [{ role: "user", text: "文献对话太薄" }],
    });
    expect(text).toMatch(/文献对话太薄|结合刚才/);
  });
});
