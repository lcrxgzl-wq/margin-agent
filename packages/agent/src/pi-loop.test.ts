import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgent = vi.hoisted(() => ({
  abortCalls: 0,
  promptCalls: 0,
  continueCalls: 0,
  continueHook: undefined as ((instance: { state: { messages: unknown[]; errorMessage?: string } }) => void) | undefined,
  instance: undefined as { state: { messages: unknown[]; errorMessage?: string } } | undefined,
  resolvePrompt: undefined as (() => void) | undefined,
  rejectPrompt: undefined as ((error: Error) => void) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  subscriber: undefined as ((event: Record<string, unknown>) => void) | undefined,
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Agent: class {
      state = { messages: [] as unknown[], errorMessage: undefined as string | undefined };

      constructor(options: Record<string, unknown>) {
        mockAgent.options = options;
        mockAgent.instance = this;
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

      continue() {
        mockAgent.continueCalls += 1;
        this.state.errorMessage = undefined;
        mockAgent.continueHook?.(this);
        return Promise.resolve();
      }

      abort() {
        mockAgent.abortCalls += 1;
        mockAgent.rejectPrompt?.(new Error("agent aborted"));
      }
    },
  };
});

const mockCompat = vi.hoisted(() => ({
  streamSimpleCalls: [] as Array<{ options?: Record<string, unknown> }>,
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
    mockCompat.streamSimpleCalls.push({ options });
    return {};
  },
  completeSimple: async () => {
    throw new Error("completeSimple is not mocked in pi-loop tests");
  },
}));

const { runPiAgentLoop, summarizeToolArguments, trimAgentMessages } = await import("./pi-loop.js");
const { configureRequestPolicy } = await import("@margin/llm");

beforeEach(() => {
  mockAgent.abortCalls = 0;
  mockAgent.promptCalls = 0;
  mockAgent.continueCalls = 0;
  mockAgent.continueHook = undefined;
  mockAgent.instance = undefined;
  mockAgent.resolvePrompt = undefined;
  mockAgent.rejectPrompt = undefined;
  mockAgent.options = undefined;
  mockAgent.subscriber = undefined;
  mockCompat.streamSimpleCalls.length = 0;
});

describe("runPiAgentLoop external cancellation", () => {
  it("defaults to a five-minute timeout", async () => {
    vi.useFakeTimers();
    try {
      const running = runPiAgentLoop({
        prompt: "test",
        systemPrompt: "test",
        tools: [],
        model: {},
      });

      await vi.advanceTimersByTimeAsync(299_999);
      expect(mockAgent.abortCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(running).resolves.toMatchObject({
        outcome: "timed_out",
        notes: ["aborted after 300000ms"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

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
  it("hides literal thinking blocks from streamed output without mutating the transcript", async () => {
    const deltas: string[] = [];
    const rawText = "Visible <thinking>Continue reading chunks</thinking> answer";
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      onDelta: (chunk) => deltas.push(chunk),
      timeoutMs: 10_000,
    });
    if (mockAgent.instance) {
      mockAgent.instance.state.messages = [{
        role: "assistant",
        content: [{ type: "text", text: rawText }],
      }];
    }
    for (const delta of [
      "Visible <thi",
      "nking>Continue reading chunks</think",
      "ing> answer",
    ]) {
      mockAgent.subscriber?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta },
      });
    }
    mockAgent.subscriber?.({
      type: "message_end",
      message: { role: "assistant" },
    });
    mockAgent.resolvePrompt?.();

    const result = await running;

    expect(deltas.join("")).toBe("Visible  answer");
    expect(result.streamedText).toBe("Visible  answer");
    expect(JSON.stringify(result.messages)).toContain(rawText);
  });

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

  it("keeps the run alive when a tool returns an error", async () => {
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      timeoutMs: 10_000,
    });
    mockAgent.subscriber?.({
      type: "tool_execution_end",
      toolName: "get_block",
      isError: true,
      result: { content: [{ type: "text", text: "Unknown blockId: ooxml-p-19-deadbeef" }] },
    });
    mockAgent.resolvePrompt?.();

    await expect(running).resolves.toMatchObject({
      outcome: "completed",
      notes: ["tool get_block failed: Unknown blockId: ooxml-p-19-deadbeef"],
    });
    expect(mockAgent.abortCalls).toBe(0);
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

  it("never truncates a lone current user request above the soft character budget", () => {
    const currentRequest = '"'.repeat(100_000);
    const messages = [{ role: "user", content: currentRequest }] as never[];

    const trimmed = trimAgentMessages(messages, 10, 100);

    const content = (trimmed[0] as { content: string }).content;
    expect(content).toBe(currentRequest);
    expect(JSON.stringify(trimmed).length).toBeGreaterThan(100);
  });

  it("does not let toolCompactionFloor truncate the current user request", () => {
    const messages = [{ role: "user", content: "x".repeat(2_000) }] as never[];

    const floored = trimAgentMessages(messages, 10, 100, 1_000);

    const content = (floored[0] as { content: string }).content;
    expect(content).toBe("x".repeat(2_000));
  });

  it("preserves an oversized current request through Pi context trimming", async () => {
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      maxContextChars: 100,
      toolCompactionFloor: 1_000,
      timeoutMs: 10_000,
    });
    const options = mockAgent.options as {
      transformContext: (messages: never[]) => Promise<never[]>;
    };
    const big = [{ role: "user", content: "x".repeat(2_000) }] as never[];
    const trimmed = await options.transformContext(big);
    expect((trimmed[0] as { content: string }).content).toBe("x".repeat(2_000));
    mockAgent.resolvePrompt?.();
    await running;
  });

  it("drops tool units before altering an oversized current user request", () => {
    const currentRequest = "u".repeat(10_000);
    const messages = [
      { role: "user", content: currentRequest },
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

    expect(trimmed).toHaveLength(1);
    expect((trimmed[0] as { role: string }).role).toBe("user");
    expect((trimmed[0] as { content: string }).content).toBe(currentRequest);
    expect(JSON.stringify(trimmed).length).toBeGreaterThan(2_000);
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

describe("Pi context compaction", () => {
  const usageAssistant = (totalTokens: number, timestamp: number) => ({
    role: "assistant",
    content: [{ type: "text", text: "a" }],
    usage: { totalTokens, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp,
  });

  const transformContextOf = () =>
    (mockAgent.options as {
      transformContext: (messages: never[]) => Promise<never[]>;
    }).transformContext;

  const overThresholdTranscript = () => [
    { role: "user", content: "u1".padEnd(400, "1"), timestamp: 1 },
    usageAssistant(90_000, 2),
    { role: "user", content: "y".repeat(88_000), timestamp: 3 },
  ];

  it("summarizes over-threshold context inside transformContext", async () => {
    const events: unknown[] = [];
    let summarizeCalls = 0;
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      contextWindow: 100_000,
      contextTier: "standard",
      summarizer: async () => {
        summarizeCalls += 1;
        return "摘要文本";
      },
      onCompaction: (event: unknown) => events.push(event),
      timeoutMs: 10_000,
    } as never);

    const transformed = await transformContextOf()(overThresholdTranscript() as never[]);

    expect(summarizeCalls).toBe(1);
    const first = transformed[0] as { role: string; content: string };
    expect(first.role).toBe("user");
    expect(first.content).toContain("此前对话已压缩为以下摘要：");
    expect(first.content).toContain("摘要文本");
    expect(events).toEqual([
      expect.objectContaining({ reason: "threshold", summary: "摘要文本" }),
    ]);
    const event = events[0] as {
      eventId: string;
      tokensBefore: number;
      tokensAfter: number;
      messagesBefore: unknown[];
      messagesAfter: unknown[];
    };
    expect(event.tokensBefore).toBeGreaterThan(event.tokensAfter);
    // C1/C2: the event carries an idempotency key and both transcript snapshots.
    expect(typeof event.eventId).toBe("string");
    expect(event.eventId.length).toBeGreaterThan(0);
    expect(event.messagesBefore).toEqual(overThresholdTranscript());
    const afterHead = event.messagesAfter[0] as { role: string; content: string };
    expect(afterHead.role).toBe("user");
    expect(afterHead.content).toContain("摘要文本");
    expect(event.messagesAfter.length).toBeLessThan(event.messagesBefore.length);

    // Self-trigger guard: the stale usage no longer re-triggers compaction.
    await transformContextOf()(overThresholdTranscript() as never[]);
    expect(summarizeCalls).toBe(1);

    mockAgent.resolvePrompt?.();
    await running;
  });

  it("does not summarize when compactionAuto is false", async () => {
    let summarizeCalls = 0;
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      contextWindow: 100_000,
      contextTier: "standard",
      compactionAuto: false,
      summarizer: async () => {
        summarizeCalls += 1;
        return "x";
      },
      timeoutMs: 10_000,
    } as never);

    const transformed = await transformContextOf()(overThresholdTranscript() as never[]);

    expect(summarizeCalls).toBe(0);
    expect((transformed[0] as { role: string }).role).toBe("user");
    expect((transformed[0] as { content: string }).content).toContain("u1");
    mockAgent.resolvePrompt?.();
    await running;
  });

  it("never summarizes on the eco tier (prune + ladder only)", async () => {
    let summarizeCalls = 0;
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      contextWindow: 100_000,
      contextTier: "eco",
      summarizer: async () => {
        summarizeCalls += 1;
        return "x";
      },
      timeoutMs: 10_000,
    } as never);

    await transformContextOf()(overThresholdTranscript() as never[]);

    expect(summarizeCalls).toBe(0);
    mockAgent.resolvePrompt?.();
    await running;
  });

  it("falls back to the trim ladder when the summarizer fails", async () => {
    const events: unknown[] = [];
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      contextWindow: 100_000,
      contextTier: "standard",
      summarizer: async () => {
        throw new Error("provider down");
      },
      onCompaction: (event: unknown) => events.push(event),
      timeoutMs: 10_000,
    } as never);

    const transformed = await transformContextOf()(overThresholdTranscript() as never[]);

    expect(events).toEqual([]);
    expect((transformed[0] as { content: string }).content).toContain("u1");
    mockAgent.resolvePrompt?.();
    const result = await running;
    expect(result.outcome).toBe("completed");
    expect(result.notes.some((note) => note.includes("compaction failed"))).toBe(true);
  });

  const overflowAssistant = (timestamp: number) => ({
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
    usage: { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    timestamp,
  });

  it("drops the overflow error message, compacts, and retries once", async () => {
    const events: unknown[] = [];
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      contextWindow: 200_000,
      contextTier: "standard",
      summarizer: async () => "溢出后摘要",
      onCompaction: (event: unknown) => events.push(event),
      timeoutMs: 10_000,
    } as never);

    const instance = mockAgent.instance!;
    instance.state.messages = [
      { role: "user", content: "u1".padEnd(400, "1"), timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "a1" }], stopReason: "stop", timestamp: 2 },
      { role: "user", content: "latest", timestamp: 3 },
      overflowAssistant(4),
    ];
    instance.state.errorMessage = "prompt is too long: 213462 tokens > 200000 maximum";
    mockAgent.resolvePrompt?.();
    const result = await running;

    expect(mockAgent.continueCalls).toBe(1);
    expect(result.outcome).toBe("completed");
    expect(events).toEqual([
      expect.objectContaining({ reason: "overflow", summary: "溢出后摘要" }),
    ]);
    const messages = instance.state.messages as Array<{ role: string; content: unknown; errorMessage?: string }>;
    expect(messages.some((m) => m.errorMessage?.includes("too long"))).toBe(false);
    expect(messages[0]!.role).toBe("user");
    expect(String(messages[0]!.content)).toContain("溢出后摘要");
    expect(result.notes.some((note) => note.includes("context overflow"))).toBe(true);
  });

  it("reports the error when the retry overflows again", async () => {
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      contextWindow: 200_000,
      contextTier: "standard",
      summarizer: async () => "溢出后摘要",
      timeoutMs: 10_000,
    } as never);

    const instance = mockAgent.instance!;
    instance.state.messages = [
      { role: "user", content: "u1".padEnd(400, "1"), timestamp: 1 },
      { role: "user", content: "latest", timestamp: 2 },
      overflowAssistant(3),
    ];
    instance.state.errorMessage = "prompt is too long: 213462 tokens > 200000 maximum";
    mockAgent.continueHook = (agent) => {
      agent.state.messages = [...agent.state.messages, overflowAssistant(5)];
      agent.state.errorMessage = "prompt is too long: 213462 tokens > 200000 maximum";
    };
    mockAgent.resolvePrompt?.();
    const result = await running;

    expect(mockAgent.continueCalls).toBe(1);
    expect(result.outcome).toBe("error");
    expect(result.errorMessage).toContain("prompt is too long");
  });

  it("keeps the full transcript in state and the result when auto compaction is active (C3)", async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `m${index}`,
      timestamp: index,
    }));
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      messages: history,
      maxContextMessages: 10,
      timeoutMs: 10_000,
    } as never);

    const initial = (mockAgent.options as { initialState: { messages: unknown[] } })
      .initialState.messages;
    // No pre-trim: trimming is a per-request view, not a state mutation.
    expect(initial).toHaveLength(30);
    mockAgent.resolvePrompt?.();
    const result = await running;
    // No trim on the way out either; growth is bounded by compaction itself.
    expect(result.messages).toHaveLength(30);
  });

  it("still trims state and result when compactionAuto is false (documented degraded path)", async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `m${index}`,
      timestamp: index,
    }));
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      messages: history,
      maxContextMessages: 10,
      compactionAuto: false,
      timeoutMs: 10_000,
    } as never);

    const initial = (mockAgent.options as { initialState: { messages: unknown[] } })
      .initialState.messages;
    expect(initial.length).toBeLessThanOrEqual(10);
    mockAgent.resolvePrompt?.();
    const result = await running;
    expect(result.messages.length).toBeLessThanOrEqual(10);
  });

  it("forwards domainSnapshot to the summarizer as a trailing user message", async () => {
    const seen: Array<Array<{ role: string; content: unknown }>> = [];
    const running = runPiAgentLoop({
      prompt: "test",
      systemPrompt: "test",
      tools: [],
      model: {},
      contextWindow: 100_000,
      contextTier: "standard",
      domainSnapshot: "[Margin 裁决状态快照]\n待裁决提案 2 条",
      summarizer: async (messages: Array<{ role: string; content: unknown }>) => {
        seen.push(messages);
        return "摘要文本";
      },
      timeoutMs: 10_000,
    } as never);

    await transformContextOf()(overThresholdTranscript() as never[]);

    expect(seen).toHaveLength(1);
    const last = seen[0]!.at(-1)!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("[Margin 裁决状态快照]");
    mockAgent.resolvePrompt?.();
    await running;
  });
});
