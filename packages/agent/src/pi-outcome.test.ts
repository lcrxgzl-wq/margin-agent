import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPiLoopCompleted } from "./pi-outcome.js";
import type { PiLoopOptions, PiLoopResult } from "./pi-loop.js";
import type { WorkspaceBridge } from "./session-tools.js";

const mocks = vi.hoisted(() => ({
  runPiAgentLoop: vi.fn(),
}));

vi.mock("./pi-loop.js", () => ({
  runPiAgentLoop: mocks.runPiAgentLoop,
}));

vi.mock("./resolve-model.js", () => ({
  hasRuntimeCredentials: () => true,
  resolveRuntimeModel: () => ({ model: {}, apiKey: "test-key" }),
}));

const { runBlockScan } = await import("./index.js");
const { runSessionTurn } = await import("./session-runner.js");

const ENV_KEYS = [
  "MARGIN_ENGINE",
  "MARGIN_ENGINE_STRICT",
  "MARGIN_API_KEY",
  "MARGIN_BASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

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

function loopResult(
  outcome: PiLoopResult["outcome"],
  detail = outcome,
): PiLoopResult {
  return {
    messages: [],
    outcome,
    notes: outcome === "completed" ? [] : [detail],
    streamedText: "",
    errorMessage: outcome === "error" ? detail : undefined,
  };
}

beforeEach(() => {
  mocks.runPiAgentLoop.mockReset();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Pi loop outcome handling", () => {
  it("accepts only completed outcomes", () => {
    expect(() => assertPiLoopCompleted(loopResult("completed"), "pi test")).not.toThrow();

    for (const outcome of ["error", "timed_out", "aborted"] as const) {
      expect(() => assertPiLoopCompleted(loopResult(outcome), "pi test")).toThrow(
        new RegExp(outcome === "timed_out" ? "timed out" : outcome),
      );
    }
  });

  it("falls back after a failed session outcome", async () => {
    mocks.runPiAgentLoop.mockResolvedValue(loopResult("error", "provider failed"));

    const result = await runSessionTurn({
      message: "who are you",
      bridge,
      bag: { revision: 0, blocks: [] },
    });

    expect(result.engine).toBe("offline");
    expect(result.fallbackFrom).toBe("pi");
    expect(result.fallbackReason).toMatch(/provider failed/);
  });

  it("propagates a failed session outcome in strict mode", async () => {
    process.env.MARGIN_ENGINE_STRICT = "1";
    mocks.runPiAgentLoop.mockResolvedValue(loopResult("error", "provider failed"));

    await expect(
      runSessionTurn({
        message: "who are you",
        bridge,
        bag: { revision: 0, blocks: [] },
      }),
    ).rejects.toThrow(/pi session failed.*provider failed/);
  });

  it("does not fallback when the caller aborts the session", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.runPiAgentLoop.mockResolvedValue(
      loopResult("aborted", "aborted by external signal"),
    );

    await expect(
      runSessionTurn({
        message: "who are you",
        bridge,
        bag: { revision: 0, blocks: [] },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/pi session aborted.*external signal/);
  });

  it("discards a partial Pi scan draft before fallback", async () => {
    process.env.MARGIN_ENGINE = "pi";
    mocks.runPiAgentLoop.mockImplementation(async (options: PiLoopOptions) => {
      const propose = options.tools.find((tool) => tool.name === "propose_block_edit");
      await propose!.execute("partial", {
        blockId: "b1",
        after: "partial Pi draft",
        rationale: "partial",
        risk: "language",
      });
      return loopResult("timed_out", "aborted after 10ms");
    });

    const result = await runBlockScan(
      {
        documentId: "doc-1",
        revision: 1,
        blocks: [
          {
            id: "b1",
            kind: "paragraph",
            text: "original",
            order: 0,
            contentHash: "hash-1",
          },
        ],
      },
      ["b1"],
    );

    expect(result.fallbackFrom).toBe("pi");
    expect(result.fallbackReason).toMatch(/pi scan timed out/);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.after).not.toBe("partial Pi draft");
  });

  it("gates the source-grounded-writing skill pointer by harness scope", async () => {
    const prompts: string[] = [];
    mocks.runPiAgentLoop.mockImplementation(async (options: PiLoopOptions) => {
      prompts.push(options.prompt);
      return loopResult("completed");
    });

    const turn = (harnessId: string) =>
      runSessionTurn({
        message: "根据资料改写这段",
        bridge,
        bag: { revision: 0, blocks: [] },
        harnessId,
        sourcePaths: ["notes/a.md"],
      });
    await turn("office-zh");
    await turn("social-science-zh");

    expect(prompts[0]).toContain("已挂资料");
    expect(prompts[0]).not.toContain('load_skill("source-grounded-writing")');
    expect(prompts[1]).toContain('load_skill("source-grounded-writing")');
  });

  it("gates clarification and cascade skill pointers by harness scope", async () => {
    const prompts: string[] = [];
    mocks.runPiAgentLoop.mockImplementation(async (options: PiLoopOptions) => {
      prompts.push(options.prompt);
      return loopResult("completed");
    });

    const turn = (harnessId: string) =>
      runSessionTurn({
        message: "改写这段",
        bridge,
        bag: { revision: 0, blocks: [] },
        harnessId,
        selectionBlockIds: ["b1"],
      });
    await turn("office-zh");
    await turn("minimal");
    await turn("social-science-zh");

    // office-zh: socratic (academic) hidden, cascade (core) visible
    expect(prompts[0]).not.toContain('load_skill("socratic-revision-zh")');
    expect(prompts[0]).toContain('load_skill("cascade-consistency-zh")');
    // minimal: no skill pointers at all
    expect(prompts[1]).not.toContain('load_skill("socratic-revision-zh")');
    expect(prompts[1]).not.toContain('load_skill("cascade-consistency-zh")');
    // social-science-zh: both visible
    expect(prompts[2]).toContain('load_skill("socratic-revision-zh")');
    expect(prompts[2]).toContain('load_skill("cascade-consistency-zh")');
  });
});
