import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgent = vi.hoisted(() => ({
  abortCalls: 0,
  promptCalls: 0,
  rejectPrompt: undefined as ((error: Error) => void) | undefined,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { messages: [], errorMessage: undefined };

    subscribe() {
      return () => undefined;
    }

    prompt() {
      mockAgent.promptCalls += 1;
      return new Promise<void>((_resolve, reject) => {
        mockAgent.rejectPrompt = reject;
      });
    }

    abort() {
      mockAgent.abortCalls += 1;
      mockAgent.rejectPrompt?.(new Error("agent aborted"));
    }
  },
}));

const { runPiAgentLoop } = await import("./pi-loop.js");

beforeEach(() => {
  mockAgent.abortCalls = 0;
  mockAgent.promptCalls = 0;
  mockAgent.rejectPrompt = undefined;
});

describe("runPiAgentLoop external cancellation", () => {
  it("immediately aborts an active Pi run", async () => {
    const controller = new AbortController();
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    expect(mockAgent.promptCalls).toBe(1);
    controller.abort();

    await expect(running).resolves.toMatchObject({
      outcome: "aborted",
      notes: ["aborted by external signal"],
    });
    expect(mockAgent.abortCalls).toBe(1);
  });

  it("does not start a Pi prompt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      signal: controller.signal,
    });

    expect(result.outcome).toBe("aborted");
    expect(result.notes).toEqual(["aborted by external signal"]);
    expect(mockAgent.promptCalls).toBe(0);
    expect(mockAgent.abortCalls).toBe(1);
  });
});
