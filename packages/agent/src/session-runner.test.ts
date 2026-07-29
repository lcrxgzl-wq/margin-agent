import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiLoopResult } from "./pi-loop.js";
import type { WorkspaceBridge } from "./session-tools.js";

const mocks = vi.hoisted(() => ({
  runPiAgentLoop: vi.fn(),
}));

vi.mock("./pi-loop.js", () => ({
  runPiAgentLoop: mocks.runPiAgentLoop,
}));

vi.mock("./resolve-model.js", () => ({
  effectiveThinkingLevel: () => undefined,
  hasRuntimeCredentials: () => true,
  resolveRuntimeModel: () => ({ model: {}, apiKey: "test-key" }),
}));

const { runPiSessionTurn, CONTEXT_TIER_PRESETS } = await import("./session-runner.js");

const bridge: WorkspaceBridge = {
  listSourceFiles: () => [],
  readText: () => {
    throw new Error("unused");
  },
  writeText: async () => {
    throw new Error("unused");
  },
  openDocument: () => {
    throw new Error("unused");
  },
};

function loopResult(): PiLoopResult {
  return {
    messages: [],
    outcome: "completed",
    notes: [],
    streamedText: "",
    toolAudit: [],
  };
}

beforeEach(() => {
  mocks.runPiAgentLoop.mockReset();
  mocks.runPiAgentLoop.mockResolvedValue(loopResult());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPiSessionTurn proposal status hint", () => {
  it("injects the proposal hint next to docHint when provided", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      proposalHint:
        "[提案状态]\n待裁决提案 1 条：\n- proposal-1：「原文摘要」\n已裁决：接受 1、拒绝 0、编辑 0。",
    });

    const prompt = mocks.runPiAgentLoop.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("当前未打开文稿。");
    expect(prompt).toContain("[提案状态]");
    expect(prompt).toContain("- proposal-1：「原文摘要」");
    expect(prompt).toContain("已裁决：接受 1、拒绝 0、编辑 0。");
    expect(prompt.indexOf("[提案状态]")).toBeGreaterThan(
      prompt.indexOf("当前未打开文稿。"),
    );
  });

  it("omits the proposal section when no hint is provided", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
    });

    const prompt = mocks.runPiAgentLoop.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("[提案状态]");
  });

  it("omits the proposal section for a blank hint", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      proposalHint: "   ",
    });

    const prompt = mocks.runPiAgentLoop.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("[提案状态]");
  });
});

describe("runPiSessionTurn timeout resolution", () => {
  const ENV_KEY = "MARGIN_PI_TIMEOUT_MS";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("falls back to the profile default when neither input nor env sets a timeout", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
    });
    expect(mocks.runPiAgentLoop.mock.calls[0]![0].timeoutMs).toBe(120_000);
  });

  it("honors MARGIN_PI_TIMEOUT_MS when the input carries no timeout", async () => {
    process.env[ENV_KEY] = "45000";
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
    });
    expect(mocks.runPiAgentLoop.mock.calls[0]![0].timeoutMs).toBe(45_000);
  });

  it("prefers an explicit input timeout over the env override", async () => {
    process.env[ENV_KEY] = "45000";
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      timeoutMs: 90_000,
    });
    expect(mocks.runPiAgentLoop.mock.calls[0]![0].timeoutMs).toBe(90_000);
  });

  it("uses the input timeout when no env override is set", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      timeoutMs: 300_000,
    });
    expect(mocks.runPiAgentLoop.mock.calls[0]![0].timeoutMs).toBe(300_000);
  });
});

describe("runPiSessionTurn context tiers", () => {
  type Block = { id: string; kind: "heading" | "paragraph"; order: number; text: string; contentHash: string };
  const paragraph = (id: string, order: number, text: string): Block => ({
    id,
    kind: "paragraph",
    order,
    text,
    contentHash: id,
  });
  const heading = (id: string, order: number, title: string): Block => ({
    id,
    kind: "heading",
    order,
    text: `# ${title}`,
    contentHash: id,
  });
  const lastPrompt = () => mocks.runPiAgentLoop.mock.calls.at(-1)![0].prompt as string;
  const lastOpts = () => mocks.runPiAgentLoop.mock.calls.at(-1)![0] as Record<string, unknown>;

  it("exports the spec preset table", () => {
    expect(CONTEXT_TIER_PRESETS).toEqual({
      eco: {
        selectionChars: 400,
        outlineHeadings: 12,
        contextMessages: 40,
        contextChars: 60_000,
        compactionFloor: 32,
        adjacentBlocks: false,
      },
      standard: {
        selectionChars: 2_000,
        outlineHeadings: 24,
        contextMessages: 80,
        contextChars: 200_000,
        compactionFloor: 128,
        adjacentBlocks: false,
      },
      max: {
        selectionChars: 12_000,
        outlineHeadings: 0,
        contextMessages: 120,
        contextChars: 600_000,
        compactionFloor: 1_000,
        adjacentBlocks: true,
      },
    });
  });

  it("slices the selection inline at 2000 chars when contextTier is unset", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      selectionHint: "x".repeat(3_000),
    });
    expect(lastPrompt()).toContain("x".repeat(2_000));
    expect(lastPrompt()).not.toContain("x".repeat(2_001));
  });

  it("slices the selection inline per tier (eco 400 / max 12000)", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      selectionHint: "x".repeat(3_000),
      contextTier: "eco",
    });
    expect(lastPrompt()).toContain("x".repeat(400));
    expect(lastPrompt()).not.toContain("x".repeat(401));

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      selectionHint: "x".repeat(13_000),
      contextTier: "max",
    });
    expect(lastPrompt()).toContain("x".repeat(12_000));
    expect(lastPrompt()).not.toContain("x".repeat(12_001));
  });

  it("keeps current loop limits and no compaction floor when contextTier is unset", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
    });
    expect(lastOpts().maxContextMessages).toBe(80);
    expect(lastOpts().maxContextChars).toBe(200_000);
    expect(lastOpts().toolCompactionFloor).toBeUndefined();
  });

  it("passes tier loop limits to the pi loop", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      contextTier: "eco",
    });
    expect(lastOpts().maxContextMessages).toBe(40);
    expect(lastOpts().maxContextChars).toBe(60_000);
    expect(lastOpts().toolCompactionFloor).toBe(32);

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      contextTier: "standard",
    });
    expect(lastOpts().maxContextMessages).toBe(80);
    expect(lastOpts().maxContextChars).toBe(200_000);
    expect(lastOpts().toolCompactionFloor).toBe(128);

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      contextTier: "max",
    });
    expect(lastOpts().maxContextMessages).toBe(120);
    expect(lastOpts().maxContextChars).toBe(600_000);
    expect(lastOpts().toolCompactionFloor).toBe(1_000);
  });

  it("caps outline headings at 24 by default, 12 on eco, unlimited on max", async () => {
    const blocks = Array.from({ length: 30 }, (_, i) => heading(`h${i + 1}`, i, `标题 ${i + 1}`));

    await runPiSessionTurn({ message: "继续修订", bridge, bag: { revision: 0, blocks } });
    expect(lastPrompt()).toContain("标题 24");
    expect(lastPrompt()).not.toContain("标题 25");

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      contextTier: "eco",
    });
    expect(lastPrompt()).toContain("标题 12");
    expect(lastPrompt()).not.toContain("标题 13");

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      contextTier: "max",
    });
    expect(lastPrompt()).toContain("标题 30");
  });

  it("injects the blocks adjacent to the selection on max tier", async () => {
    const blocks = [
      paragraph("b1", 0, "前文段落内容"),
      paragraph("b2", 1, "选中段落内容"),
      paragraph("b3", 2, "后文段落内容"),
    ];
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      selectionBlockIds: ["b2"],
      contextTier: "max",
    });
    expect(lastPrompt()).toContain("[选区上下文]");
    expect(lastPrompt()).toContain("前文段落内容");
    expect(lastPrompt()).toContain("后文段落内容");
  });

  it("caps each injected adjacent block at 800 chars on max tier", async () => {
    const blocks = [
      paragraph("b1", 0, "p".repeat(1_000)),
      paragraph("b2", 1, "选中段落"),
    ];
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      selectionBlockIds: ["b2"],
      contextTier: "max",
    });
    expect(lastPrompt()).toContain("p".repeat(800));
    expect(lastPrompt()).not.toContain("p".repeat(801));
  });

  it("does not inject adjacent blocks outside max tier or without a locatable selection", async () => {
    const blocks = [
      paragraph("b1", 0, "前文段落内容"),
      paragraph("b2", 1, "选中段落内容"),
      paragraph("b3", 2, "后文段落内容"),
    ];
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      selectionBlockIds: ["b2"],
      contextTier: "standard",
    });
    expect(lastPrompt()).not.toContain("[选区上下文]");

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      contextTier: "max",
    });
    expect(lastPrompt()).not.toContain("[选区上下文]");

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      selectionBlockIds: ["missing"],
      contextTier: "max",
    });
    expect(lastPrompt()).not.toContain("[选区上下文]");
  });

  it("falls back to standard when contextTier is invalid", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      selectionHint: "x".repeat(3_000),
      contextTier: "ludicrous" as never,
    });
    expect(lastPrompt()).toContain("x".repeat(2_000));
    expect(lastPrompt()).not.toContain("x".repeat(2_001));
  });
});
