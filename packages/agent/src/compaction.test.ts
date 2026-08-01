import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  COMPACTION_SUMMARY_PREFIX,
  PRUNED_TOOL_OUTPUT_PLACEHOLDER,
  createPiSummarizer,
  findLastContextTokens,
  findSafeCutIndex,
  keepRecentTokensForTier,
  orchestrateCompaction,
  prunedToolOutputPlaceholder,
  pruneToolOutputs,
} from "./compaction.js";

function userMsg(text: string, timestamp = 0): AgentMessage {
  return { role: "user", content: text, timestamp } as AgentMessage;
}

function assistantMsg(
  text: string,
  opts: { usage?: Record<string, number>; timestamp?: number; toolCallId?: string } = {},
): AgentMessage {
  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  if (opts.toolCallId) {
    content.push({ type: "toolCall", id: opts.toolCallId, name: "read", arguments: {} });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "m",
    ...(opts.usage ? { usage: opts.usage } : {}),
    stopReason: "stop",
    timestamp: opts.timestamp ?? 0,
  } as unknown as AgentMessage;
}

function toolResultMsg(
  toolCallId: string,
  text: string,
  timestamp = 0,
  toolName = "read",
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}

const fakeModel = {
  id: "m",
  name: "m",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_192,
} as never;

describe("findLastContextTokens", () => {
  it("returns totalTokens of the last assistant message with usage", () => {
    const messages = [
      userMsg("u", 1),
      assistantMsg("a1", { usage: { totalTokens: 1234, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, timestamp: 2 }),
      userMsg("u2", 3),
      assistantMsg("a2", { usage: { totalTokens: 5678, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, timestamp: 4 }),
    ];
    expect(findLastContextTokens(messages)).toBe(5678);
  });

  it("falls back to input+output+cacheRead+cacheWrite when totalTokens is missing", () => {
    const messages = [
      assistantMsg("a", { usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 }, timestamp: 1 }),
    ];
    expect(findLastContextTokens(messages)).toBe(20);
  });

  it("ignores usage at or before lastCompactionAt (self-trigger guard)", () => {
    const messages = [
      assistantMsg("a1", { usage: { totalTokens: 9000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, timestamp: 100 }),
      userMsg("u", 200),
    ];
    expect(findLastContextTokens(messages, 100)).toBeUndefined();
    expect(findLastContextTokens(messages, 99)).toBe(9000);
  });

  it("returns undefined when no assistant usage exists", () => {
    expect(findLastContextTokens([userMsg("u", 1), assistantMsg("a", { timestamp: 2 })])).toBeUndefined();
  });

  it("ignores usage older than the latest summary head (self-contained compaction cutoff)", () => {
    const summaryHead = userMsg(`${COMPACTION_SUMMARY_PREFIX}旧摘要`, 500);
    const staleUsage = assistantMsg("a-stale", {
      usage: { totalTokens: 90_000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      timestamp: 400,
    });
    // Kept-tail usage predating the summary head must not re-trigger compaction,
    // even though the message sits after the head in the transcript.
    expect(findLastContextTokens([summaryHead, userMsg("u", 600), staleUsage])).toBeUndefined();
    // Fresh usage (newer than the head) still counts.
    const freshUsage = assistantMsg("a-fresh", {
      usage: { totalTokens: 95_000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      timestamp: 700,
    });
    expect(findLastContextTokens([summaryHead, userMsg("u", 600), freshUsage])).toBe(95_000);
    // An explicit lastCompactionAt later than the head still wins.
    expect(findLastContextTokens([summaryHead, freshUsage], 800)).toBeUndefined();
  });
});

describe("pruneToolOutputs", () => {
  it("replaces tool outputs older than the 40k-char protection window", () => {
    const oldOutput = "o".repeat(30_000);
    const recentOutput = "r".repeat(30_000);
    const messages = [
      userMsg("u1", 1),
      toolResultMsg("c1", oldOutput, 2),
      assistantMsg("a1".padEnd(15_000, "a"), { timestamp: 3 }),
      userMsg("u2", 4),
      toolResultMsg("c2", recentOutput, 5),
    ];

    const { messages: pruned, reclaimed } = pruneToolOutputs(messages);

    const oldResult = pruned[1] as { content: Array<{ text: string }> };
    expect(oldResult.content[0]!.text).toBe(PRUNED_TOOL_OUTPUT_PLACEHOLDER);
    expect(PRUNED_TOOL_OUTPUT_PLACEHOLDER).toContain("blockId/cursor/sourceRef");
    expect(PRUNED_TOOL_OUTPUT_PLACEHOLDER).toContain("不要因此用 offset 重扫全文");
    const recentResult = pruned[4] as { content: Array<{ text: string }> };
    expect(recentResult.content[0]!.text).toBe(recentOutput);
    expect(reclaimed).toBe(oldOutput.length - PRUNED_TOOL_OUTPUT_PLACEHOLDER.length);
    // originals untouched
    expect((messages[1] as { content: Array<{ text: string }> }).content[0]!.text).toBe(oldOutput);
  });

  it("keeps cursor and sourceRef anchors when pruning bounded reads", () => {
    const oldBlocks = JSON.stringify({
      cursor: "0:0",
      nextCursor: "12:0",
      hasMore: true,
      chunks: [{ text: "x".repeat(30_000) }],
    });
    const oldSource = JSON.stringify({
      relativePath: "notes.md",
      sourceRef: "notes.md#sha256=0123456789abcdef&chars=0-10",
      nextOffset: 10,
      hasMore: true,
      text: "y".repeat(30_000),
    });
    const messages = [
      userMsg("u1", 1),
      toolResultMsg("c1", oldBlocks, 2, "read_document_blocks"),
      assistantMsg("a1".padEnd(10_000, "a"), { timestamp: 3 }),
      userMsg("u2", 4),
      toolResultMsg("c2", oldSource, 5, "read_workspace_file"),
      assistantMsg("recent".padEnd(30_000, "r"), { timestamp: 6 }),
    ];

    const { messages: pruned } = pruneToolOutputs(messages);

    const blocksResult = pruned[1] as { content: Array<{ text: string }> };
    expect(blocksResult.content[0]!.text).toContain("cursor=0:0");
    expect(blocksResult.content[0]!.text).toContain("nextCursor=12:0");
    const sourceResult = pruned[4] as { content: Array<{ text: string }> };
    expect(sourceResult.content[0]!.text).toContain(
      "sourceRef=notes.md#sha256=0123456789abcdef&chars=0-10",
    );
    expect(sourceResult.content[0]!.text).toContain("nextOffset=10");
    expect(prunedToolOutputPlaceholder(
      toolResultMsg("c3", "other", 6),
      "other",
    )).toBe(PRUNED_TOOL_OUTPUT_PLACEHOLDER);
  });

  it("does not execute when reclaimable output is below the 20k minimum", () => {
    const messages = [
      userMsg("u1", 1),
      toolResultMsg("c1", "o".repeat(10_000), 2),
      userMsg("u2".padEnd(50_000, "u"), 3),
    ];

    const { messages: pruned, reclaimed } = pruneToolOutputs(messages);

    expect(reclaimed).toBe(0);
    expect(pruned).toEqual(messages);
    expect((pruned[1] as { content: Array<{ text: string }> }).content[0]!.text).toBe("o".repeat(10_000));
  });
});

describe("findSafeCutIndex", () => {
  it("cuts at a user-message boundary within the recent-token budget", () => {
    const messages = [
      userMsg("u0".padEnd(400, "0"), 1), // ~100 tokens
      assistantMsg("a0".padEnd(400, "0"), { timestamp: 2 }),
      userMsg("u1".padEnd(400, "1"), 3),
      assistantMsg("a1".padEnd(400, "1"), { timestamp: 4 }),
      userMsg("latest", 5),
    ];

    const cut = findSafeCutIndex(messages, 150);

    expect(cut).toBe(2);
    expect((messages[cut!] as { role: string }).role).toBe("user");
  });

  it("never splits an assistant toolCall from its toolResult", () => {
    const messages = [
      userMsg("u0".padEnd(400, "0"), 1),
      assistantMsg("a0".padEnd(400, "0"), { timestamp: 2 }),
      userMsg("u1", 3),
      assistantMsg("call", { timestamp: 4, toolCallId: "c1" }),
      toolResultMsg("c1", "t".repeat(400), 5),
      userMsg("latest", 6),
    ];

    // Budget lands inside the a1/toolResult pair; the cut must back off to u1.
    const cut = findSafeCutIndex(messages, 150);

    expect(cut).toBe(2);
    const kept = messages.slice(cut!);
    expect(kept.some((m) => (m as { role: string }).role === "toolResult")).toBe(true);
    expect(kept.some((m) => (m as { content?: Array<{ type?: string }> }).content
      ?.some?.((b) => b.type === "toolCall"))).toBe(true);
  });

  it("never eats the latest user turn and returns undefined when nothing can drop", () => {
    const messages = [
      userMsg("only".padEnd(4_000, "u"), 1),
      assistantMsg("a".padEnd(4_000, "a"), { timestamp: 2 }),
      toolResultMsg("c1", "t".repeat(4_000), 3),
    ];

    expect(findSafeCutIndex(messages, 100)).toBeUndefined();
  });

  it("returns undefined when there is no legal cut point", () => {
    expect(findSafeCutIndex([userMsg("hi", 1)], 10)).toBeUndefined();
    expect(findSafeCutIndex([], 10)).toBeUndefined();
  });
});

describe("keepRecentTokensForTier", () => {
  it("maps tiers per spec (standard 20k, max 40k)", () => {
    expect(keepRecentTokensForTier("standard")).toBe(20_000);
    expect(keepRecentTokensForTier("max")).toBe(40_000);
  });
});

describe("orchestrateCompaction", () => {
  const usage = { totalTokens: 95_000, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

  function bigTranscript() {
    return [
      userMsg("u1".padEnd(400, "1"), 1),
      assistantMsg("a1".padEnd(400, "1"), { usage, timestamp: 2 }),
      toolResultMsg("c1", "t".repeat(400), 3),
      userMsg("u2".padEnd(400, "2"), 4),
      assistantMsg("a2".padEnd(400, "2"), { timestamp: 5 }),
      userMsg("latest question", 6),
    ];
  }

  it("compacts over-threshold transcripts into [summary user] + verbatim tail", async () => {
    const seen: { messages?: AgentMessage[]; previousSummary?: string } = {};
    const outcome = await orchestrateCompaction({
      messages: bigTranscript(),
      model: fakeModel,
      contextWindow: 100_000,
      tier: "standard",
      keepRecentTokens: 150,
      previousSummary: "上一轮摘要",
      domainSnapshot: "[Margin 裁决状态快照] p1=Y",
      summarizer: async (messages, previousSummary) => {
        seen.messages = messages;
        seen.previousSummary = previousSummary;
        return "摘要文本";
      },
    });

    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    const first = outcome.messages[0] as { role: string; content: string };
    expect(first.role).toBe("user");
    expect(first.content).toContain("此前对话已压缩为以下摘要：");
    expect(first.content).toContain("摘要文本");
    // tail preserved verbatim
    expect(outcome.messages.slice(1)).toEqual(bigTranscript().slice(3));
    expect(outcome.summary).toBe("摘要文本");
    expect(outcome.tokensBefore).toBeGreaterThan(outcome.tokensAfter);
    expect(outcome.droppedMessages.length).toBe(3);
    // C1: the compacted outcome carries a unique idempotency key.
    expect(typeof outcome.eventId).toBe("string");
    expect(outcome.eventId.length).toBeGreaterThan(0);
    // summarizer saw the dropped messages plus the domain snapshot, and previousSummary
    expect(seen.previousSummary).toBe("上一轮摘要");
    const lastSeen = seen.messages!.at(-1) as { role: string; content: string };
    expect(lastSeen.role).toBe("user");
    expect(lastSeen.content).toContain("[Margin 裁决状态快照]");
    expect(seen.messages!.slice(0, -1)).toEqual(bigTranscript().slice(0, 3));
  });

  it("skips when usage is below the threshold", async () => {
    let called = false;
    const messages = [
      userMsg("u1", 1),
      assistantMsg("a1", { usage: { totalTokens: 1_000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, timestamp: 2 }),
    ];
    const outcome = await orchestrateCompaction({
      messages,
      model: fakeModel,
      contextWindow: 100_000,
      tier: "standard",
      summarizer: async () => {
        called = true;
        return "x";
      },
    });
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.reason).toBe("below_threshold");
    expect(called).toBe(false);
  });

  it("skips when no usage exists yet (never triggers on char estimates)", async () => {
    const outcome = await orchestrateCompaction({
      messages: [userMsg("u".repeat(500_000), 1)],
      model: fakeModel,
      contextWindow: 100_000,
      tier: "standard",
      summarizer: async () => "x",
    });
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.reason).toBe("no_usage");
  });

  it("skips summarization on eco tier even over threshold", async () => {
    let called = false;
    const outcome = await orchestrateCompaction({
      messages: bigTranscript(),
      model: fakeModel,
      contextWindow: 100_000,
      tier: "eco",
      summarizer: async () => {
        called = true;
        return "x";
      },
    });
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.reason).toBe("eco_tier");
    expect(called).toBe(false);
  });

  it("honors the self-trigger guard via lastCompactionAt", async () => {
    const outcome = await orchestrateCompaction({
      messages: bigTranscript(),
      model: fakeModel,
      contextWindow: 100_000,
      tier: "standard",
      lastCompactionAt: 2,
      summarizer: async () => "x",
    });
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.reason).toBe("no_usage");
  });

  it("returns a trim-fallback marker when the summarizer fails", async () => {
    const outcome = await orchestrateCompaction({
      messages: bigTranscript(),
      model: fakeModel,
      contextWindow: 100_000,
      tier: "standard",
      keepRecentTokens: 150,
      summarizer: async () => {
        throw new Error("provider down");
      },
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.fallback).toBe("trim");
    expect(outcome.error).toContain("provider down");
  });

  it("gives up when the compacted transcript is not smaller", async () => {
    let called = false;
    const outcome = await orchestrateCompaction({
      messages: [
        userMsg("u1".padEnd(400, "1"), 1),
        assistantMsg("a1".padEnd(400, "1"), { timestamp: 2 }),
        userMsg("latest", 3),
      ],
      model: fakeModel,
      contextWindow: 100_000,
      tier: "standard",
      keepRecentTokens: 10,
      force: true,
      summarizer: async () => {
        called = true;
        return "s".repeat(40_000);
      },
    });
    expect(called).toBe(true);
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.reason).toBe("not_beneficial");
  });

  it("skips when no safe cut point exists", async () => {
    const outcome = await orchestrateCompaction({
      messages: [
        userMsg("only".padEnd(400, "u"), 1),
        assistantMsg("a".padEnd(400, "a"), { usage, timestamp: 2 }),
      ],
      model: fakeModel,
      contextWindow: 100_000,
      tier: "standard",
      keepRecentTokens: 10,
      summarizer: async () => "x",
    });
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.reason).toBe("no_safe_cut");
  });

  it("runs without usage when forced (overflow/manual path)", async () => {
    const outcome = await orchestrateCompaction({
      messages: [
        userMsg("u1".padEnd(400, "1"), 1),
        assistantMsg("a1".padEnd(400, "1"), { timestamp: 2 }),
        userMsg("u2".padEnd(400, "2"), 3),
        userMsg("latest", 4),
      ],
      model: fakeModel,
      contextWindow: 100_000,
      tier: "standard",
      keepRecentTokens: 60,
      force: true,
      summarizer: async () => "摘要",
    });
    expect(outcome.kind).toBe("compacted");
  });

  it("excludes a previous summary head from the summarizer input (I2b)", async () => {
    const seen: AgentMessage[][] = [];
    const transcript = [
      userMsg(`${COMPACTION_SUMMARY_PREFIX}${"旧".repeat(2_000)}`, 1),
      userMsg("u1".padEnd(400, "1"), 2),
      assistantMsg("a1".padEnd(400, "1"), { timestamp: 3 }),
      userMsg("latest", 4),
    ];
    const outcome = await orchestrateCompaction({
      messages: transcript,
      model: fakeModel,
      contextWindow: 100_000,
      tier: "standard",
      keepRecentTokens: 50,
      force: true,
      previousSummary: "旧摘要",
      summarizer: async (messages) => {
        seen.push([...messages]);
        return "新摘要";
      },
    });

    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    // The old summary head is compacted away (new head replaces it) but is not
    // re-fed to the summarizer — previousSummary already represents it.
    expect(seen).toHaveLength(1);
    expect(
      seen[0]!.some((message) =>
        String((message as { content?: unknown }).content).startsWith(COMPACTION_SUMMARY_PREFIX),
      ),
    ).toBe(false);
    expect(seen[0]!.length).toBe(2); // u1 + a1, head excluded
    // The new summary head replaces the old one.
    const first = outcome.messages[0] as { role: string; content: string };
    expect(first.content).toContain("新摘要");
    expect(outcome.messages.some((message) =>
      String((message as { content?: unknown }).content).includes("旧".repeat(100)),
    )).toBe(false);
  });
});

describe("createPiSummarizer", () => {
  it("is a factory returning a summarizer function", () => {
    const summarizer = createPiSummarizer({ model: fakeModel });
    expect(typeof summarizer).toBe("function");
  });
});
