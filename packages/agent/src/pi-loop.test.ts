import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgent = vi.hoisted(() => ({
  abortCalls: 0,
  promptCalls: 0,
  resolvePrompt: undefined as (() => void) | undefined,
  rejectPrompt: undefined as ((error: Error) => void) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  subscriber: undefined as ((event: Record<string, unknown>) => void) | undefined,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { messages: [], errorMessage: undefined };

    constructor(options: Record<string, unknown>) {
      mockAgent.options = options;
      const initial = options.initialState as { messages?: unknown[] } | undefined;
      this.state.messages = (initial?.messages ?? []) as never[];
    }

    subscribe(listener: (event: Record<string, unknown>) => void) {
      mockAgent.subscriber = listener;
      return () => undefined;
    }

    prompt() {
      mockAgent.promptCalls += 1;
      return new Promise<void>((resolve, reject) => {
        mockAgent.resolvePrompt = resolve;
        mockAgent.rejectPrompt = reject;
      });
    }

    abort() {
      mockAgent.abortCalls += 1;
      mockAgent.rejectPrompt?.(new Error("agent aborted"));
    }
  },
}));

const mockCompat = vi.hoisted(() => ({
  streamSimpleCalls: [] as Array<{ options?: Record<string, unknown> }>,
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
    mockCompat.streamSimpleCalls.push({ options });
    return {};
  },
}));

const { runPiAgentLoop, summarizeToolArguments, trimAgentMessages } = await import("./pi-loop.js");
const { configureRequestPolicy } = await import("@margin/llm");

beforeEach(() => {
  mockAgent.abortCalls = 0;
  mockAgent.promptCalls = 0;
  mockAgent.resolvePrompt = undefined;
  mockAgent.rejectPrompt = undefined;
  mockAgent.options = undefined;
  mockAgent.subscriber = undefined;
  mockCompat.streamSimpleCalls.length = 0;
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

describe("Pi runtime boundaries", () => {
  it("does not turn a natural final turn at the cap into an abort", async () => {
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      maxTurns: 1,
      timeoutMs: 10_000,
    });
    mockAgent.subscriber?.({
      type: "turn_end",
      message: { content: [{ type: "text", text: "done" }] },
      toolResults: [],
    });
    mockAgent.resolvePrompt?.();

    await expect(running).resolves.toMatchObject({ outcome: "completed" });
    expect(mockAgent.abortCalls).toBe(0);
  });

  it("keeps a terminating tool turn successful at the cap", async () => {
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [{
        name: "finish_turn",
        label: "Finish",
        description: "Finish",
        parameters: {},
        execute: async () => ({ content: [], details: {}, terminate: true }),
      } as never],
      model: {},
      maxTurns: 1,
      timeoutMs: 10_000,
    });
    const options = mockAgent.options as {
      beforeToolCall: (context: { toolCall: { id: string; name: string }; args: unknown }) => Promise<unknown>;
      afterToolCall: (context: {
        toolCall: { id: string; name: string };
        result: { terminate: boolean };
        isError: boolean;
      }) => Promise<unknown>;
    };
    await options.beforeToolCall({
      toolCall: { id: "finish", name: "finish_turn" },
      args: {},
    });
    await options.afterToolCall({
      toolCall: { id: "finish", name: "finish_turn" },
      result: { terminate: true },
      isError: false,
    });
    mockAgent.subscriber?.({
      type: "turn_end",
      message: { content: [{ type: "toolCall", id: "finish" }] },
      toolResults: [{}],
    });
    mockAgent.resolvePrompt?.();

    await expect(running).resolves.toMatchObject({ outcome: "completed" });
    expect(mockAgent.abortCalls).toBe(0);
  });

  it("stops at the cap only when a non-terminating tool turn needs another call", async () => {
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      maxTurns: 1,
      timeoutMs: 10_000,
    });
    mockAgent.subscriber?.({
      type: "turn_end",
      message: { content: [{ type: "toolCall", id: "call-1" }] },
      toolResults: [{}],
    });

    await expect(running).resolves.toMatchObject({
      outcome: "aborted",
      notes: ["stopped after 1 turns"],
    });
    expect(mockAgent.abortCalls).toBe(1);
  });

  it("fails the run immediately when a tool returns an error", async () => {
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      timeoutMs: 10_000,
    });
    mockAgent.subscriber?.({
      type: "tool_execution_end",
      toolName: "read_workspace_file",
      isError: true,
      result: { content: [{ type: "text", text: "file missing" }] },
    });

    await expect(running).resolves.toMatchObject({
      outcome: "error",
      notes: ["tool read_workspace_file failed: file missing"],
    });
    expect(mockAgent.abortCalls).toBe(1);
  });

  it("keeps complete recent turns within message and character limits", () => {
    const messages = Array.from({ length: 30 }, (_, index) => [
      { role: "user", content: `user-${index}` },
      { role: "assistant", content: [{ type: "text", text: `assistant-${index}` }] },
      {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "read",
        content: [{ type: "text", text: index === 29 ? "x".repeat(20_000) : `tool-${index}` }],
      },
    ]).flat() as never[];

    const trimmed = trimAgentMessages(messages, 10, 4_000);

    expect(trimmed.length).toBeLessThanOrEqual(10);
    expect((trimmed[0] as { role: string }).role).toBe("user");
    expect(JSON.stringify(trimmed)).toContain("tool output truncated");
    expect(JSON.stringify(trimmed).length).toBeLessThan(4_000);
  });

  it("bounds one oversized current turn without dropping its user request", () => {
    const messages = [
      { role: "user", content: "u".repeat(10_000) },
      ...Array.from({ length: 20 }, (_, index) => [
        { role: "assistant", content: [{ type: "toolCall", id: `call-${index}` }] },
        {
          role: "toolResult",
          toolCallId: `call-${index}`,
          content: [{ type: "text", text: "x".repeat(1_000) }],
        },
      ]).flat(),
    ] as never[];

    const trimmed = trimAgentMessages(messages, 8, 2_000);

    expect(trimmed.length).toBeLessThanOrEqual(8);
    expect((trimmed[0] as { role: string }).role).toBe("user");
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(2_000);
  });

  it("redacts secrets from bounded tool argument summaries", () => {
    const summary = summarizeToolArguments({
      query: "sport",
      token: "secret-token",
      nested: { authorization: "Bearer secret", text: "x".repeat(800) },
    });
    expect(summary).toMatchObject({
      query: "sport",
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]" },
    });
    expect(JSON.stringify(summary)).not.toContain("secret-token");
  });

  it("installs context, permission, and audit hooks on Pi", async () => {
    const controller = new AbortController();
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [{
        name: "safe_tool",
        label: "Safe",
        description: "Safe",
        parameters: {},
        execute: async () => ({ content: [], details: {} }),
      } as never],
      allowedToolNames: ["safe_tool"],
      model: {},
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    const options = mockAgent.options as {
      transformContext: (messages: never[]) => Promise<never[]>;
      beforeToolCall: (context: { toolCall: { id: string; name: string }; args: unknown }) => Promise<unknown>;
      afterToolCall: (context: { toolCall: { id: string; name: string }; isError: boolean }) => Promise<unknown>;
    };

    expect(typeof options.transformContext).toBe("function");
    await expect(options.beforeToolCall({
      toolCall: { id: "blocked", name: "unsafe_tool" },
      args: { apiKey: "secret" },
    })).resolves.toMatchObject({ block: true });
    await options.beforeToolCall({
      toolCall: { id: "allowed", name: "safe_tool" },
      args: { query: "ok" },
    });
    await options.afterToolCall({
      toolCall: { id: "allowed", name: "safe_tool" },
      isError: false,
    });
    await options.beforeToolCall({
      toolCall: { id: "unfinished", name: "safe_tool" },
      args: { query: "pending" },
    });
    controller.abort();

    const result = await running;
    expect(result.toolAudit).toEqual([
      expect.objectContaining({ toolName: "unsafe_tool", status: "blocked" }),
      expect.objectContaining({ toolName: "safe_tool", status: "completed" }),
      expect.objectContaining({ toolCallId: "unfinished", status: "aborted" }),
    ]);
    expect(JSON.stringify(result.toolAudit)).not.toContain("secret");
  });

  it("propagates a loop abort into a tool even when Pi supplies its own signal", async () => {
    const controller = new AbortController();
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [{
        name: "slow_tool",
        label: "Slow",
        description: "Slow",
        parameters: {},
        execute: async (_id: string, _args: unknown, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("tool cancelled")), { once: true });
          }),
      } as never],
      model: {},
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    const options = mockAgent.options as {
      initialState: { tools: Array<{ execute: (...args: never[]) => Promise<unknown> }> };
    };
    const piSignal = new AbortController();
    const toolRun = options.initialState.tools[0]!.execute(
      "slow",
      {},
      piSignal.signal,
    );

    controller.abort();

    await expect(toolRun).rejects.toThrow(/tool cancelled/);
    await expect(running).resolves.toMatchObject({ outcome: "aborted" });
  });
});

describe("Pi request policy", () => {
  const runToCompletion = async (opts: Record<string, unknown> = {}) => {
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: { id: "model-pi" },
      timeoutMs: 10_000,
      ...opts,
    } as never);
    mockAgent.resolvePrompt?.();
    return running;
  };

  it("keeps thinkingLevel off unless an explicit level is requested", async () => {
    await runToCompletion();
    expect((mockAgent.options?.initialState as { thinkingLevel?: string }).thinkingLevel)
      .toBe("off");

    await runToCompletion({ thinkingLevel: "low" });
    expect((mockAgent.options?.initialState as { thinkingLevel?: string }).thinkingLevel)
      .toBe("low");
  });

  it("injects margin policy headers into every provider request via streamFn", async () => {
    configureRequestPolicy({ version: "0.2.0-test" });
    await runToCompletion();
    const streamFn = mockAgent.options?.streamFn as (
      model: unknown,
      context: unknown,
      options?: Record<string, unknown>,
    ) => unknown;
    expect(typeof streamFn).toBe("function");

    streamFn({}, {}, { headers: { "X-Custom": "keep" }, sessionId: "s-1" });
    expect(mockCompat.streamSimpleCalls).toHaveLength(1);
    const options = mockCompat.streamSimpleCalls[0]!.options as {
      headers: Record<string, string>;
      sessionId?: string;
    };
    expect(options.headers["X-Custom"]).toBe("keep");
    expect(options.headers["User-Agent"]).toBe("margin-agent/0.2.0-test");
    expect(options.headers["X-Client-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(options.sessionId).toBe("s-1");

    streamFn({}, {}, {});
    const second = mockCompat.streamSimpleCalls[1]!.options as { headers: Record<string, string> };
    expect(second.headers["X-Client-Request-Id"])
      .not.toBe(options.headers["X-Client-Request-Id"]);
  });

  it("aggregates assistant usage per loop and reports it best-effort", async () => {
    const recorded: unknown[] = [];
    configureRequestPolicy({ onUsage: (entry: unknown) => recorded.push(entry) });
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: { id: "model-pi" },
      usagePath: "pi-chat",
      timeoutMs: 10_000,
    });
    mockAgent.subscriber?.({
      type: "message_end",
      message: { role: "assistant", usage: { input: 10, output: 4, cacheRead: 6, cacheWrite: 2 } },
    });
    mockAgent.subscriber?.({
      type: "message_end",
      message: { role: "assistant", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } },
    });
    mockAgent.subscriber?.({ type: "message_end", message: { role: "user" } });
    mockAgent.resolvePrompt?.();
    await running;

    expect(recorded).toEqual([
      expect.objectContaining({
        path: "pi-chat",
        model: "model-pi",
        input: 15,
        output: 5,
        cacheRead: 6,
        cacheWrite: 2,
      }),
    ]);
    expect((recorded[0] as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    configureRequestPolicy({ onUsage: undefined });
  });

  it("does not report usage without a usagePath or without tokens", async () => {
    const recorded: unknown[] = [];
    configureRequestPolicy({ onUsage: (entry: unknown) => recorded.push(entry) });
    await runToCompletion({ usagePath: "pi-scan" });
    await runToCompletion();
    expect(recorded).toEqual([]);
    configureRequestPolicy({ onUsage: undefined });
  });
});
