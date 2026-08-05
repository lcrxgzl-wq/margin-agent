import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPiLoopCompleted, PiLoopFailure } from "./pi-outcome.js";
import type { PiLoopOptions, PiLoopResult } from "./pi-loop.js";
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

const { runBlockScan } = await import("./index.js");
const { runSessionTurn } = await import("./session-runner.js");

const ENV_KEYS = [
  "MARGIN_ENGINE",
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
    toolAudit: [],
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

  it("runs deterministic host commands without starting Pi", async () => {
    const result = await runSessionTurn({
      message: "有哪些文件",
      bridge,
      bag: { revision: 0, blocks: [] },
    });

    expect(result.engine).toBe("offline");
    expect(mocks.runPiAgentLoop).not.toHaveBeenCalled();
  });

  it("propagates a failed session outcome without replaying offline", async () => {
    mocks.runPiAgentLoop.mockResolvedValue(loopResult("error", "provider failed"));

    await expect(
      runSessionTurn({
        message: "who are you",
        bridge,
        bag: { revision: 0, blocks: [] },
      }),
    ).rejects.toThrow(/pi session failed.*provider failed/);
  });

  it("soft-lands when the turn budget is exhausted instead of throwing", async () => {
    mocks.runPiAgentLoop.mockResolvedValue({
      messages: [{ role: "assistant", content: [{ type: "text", text: "已读完大纲，准备归纳。" }] }],
      outcome: "aborted",
      notes: ["stopped after 40 turns"],
      streamedText: "已读完大纲，准备归纳。",
      toolAudit: [],
    });

    const deltas: string[] = [];
    const turn = await runSessionTurn({
      message: "通读全文",
      bridge,
      bag: { revision: 0, blocks: [{ id: "b1", kind: "paragraph", text: "hello", order: 0, contentHash: "h" }] },
      onDelta: (chunk) => deltas.push(chunk),
    });
    expect(turn.reply).toContain("已读完大纲");
    expect(turn.reply).toMatch(/工具读取已停止/);
    expect(turn.reply).toMatch(/继续/);
    expect(deltas.join("")).toContain("请直接回复「继续」");
  });

  it("propagates caller abort without starting another planner", async () => {
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

  it("does not run a second planner after a partial Pi scan", async () => {
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

    await expect(runBlockScan(
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
    )).rejects.toThrow(/pi scan timed out/);
  });

  it("does not repeat a completed write when Pi later times out", async () => {
    let writes = 0;
    const writeBridge: WorkspaceBridge = {
      ...bridge,
      writeText: async (relativePath, content) => {
        writes += 1;
        return { relativePath, bytes: content.length, created: true };
      },
    };
    mocks.runPiAgentLoop.mockImplementation(async (options: PiLoopOptions) => {
      const write = options.tools.find((tool) => tool.name === "write_workspace_file");
      await write!.execute("write-once", {
        relativePath: "notes/result.md",
        content: "done",
      });
      const result = loopResult("timed_out", "aborted after 10ms");
      result.toolAudit = [{
        toolCallId: "write-once",
        toolName: "write_workspace_file",
        status: "completed",
        durationMs: 1,
        args: { relativePath: "notes/result.md" },
      }];
      return result;
    });

    const failure = await runSessionTurn({
      message: "write notes/result.md",
      bridge: writeBridge,
      bag: { revision: 0, blocks: [] },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PiLoopFailure);
    expect(failure).toMatchObject({
      message: expect.stringMatching(/pi session timed out/),
      toolAudit: [expect.objectContaining({ toolName: "write_workspace_file" })],
    });
    expect(writes).toBe(1);

    mocks.runPiAgentLoop.mockImplementation(async (options: PiLoopOptions) => {
      expect(options.tools.find((tool) => tool.name === "write_workspace_file")).toBeUndefined();
      return loopResult("completed");
    });
    await runSessionTurn({
      message: "继续此前任务：write notes/result.md",
      workspaceWriteApprovalMessage: "继续",
      bridge: writeBridge,
      bag: { revision: 0, blocks: [] },
    });
    expect(writes).toBe(1);
  });

  it("does not treat a negated write as approval and supports an explicit quoted path", async () => {
    const written: string[] = [];
    const writeBridge: WorkspaceBridge = {
      ...bridge,
      writeText: async (relativePath, content) => {
        written.push(relativePath);
        return { relativePath, bytes: content.length, created: true };
      },
    };
    const mounted: string[][] = [];
    mocks.runPiAgentLoop.mockImplementation(async (options: PiLoopOptions) => {
      mounted.push(options.tools.map((tool) => tool.name));
      const write = options.tools.find((tool) => tool.name === "write_workspace_file");
      if (write) {
        await write.execute("approved", {
          relativePath: "notes/final draft.md",
          content: "done",
        });
      }
      return loopResult("completed");
    });

    await runSessionTurn({
      message: "不要创建 notes/final.md，只讨论方案",
      bridge: writeBridge,
      bag: { revision: 0, blocks: [] },
    });
    await runSessionTurn({
      message: '请创建 "notes/final draft.md"',
      bridge: writeBridge,
      bag: { revision: 0, blocks: [] },
    });

    expect(mounted[0]).not.toContain("write_workspace_file");
    expect(mounted[1]).toContain("write_workspace_file");
    expect(written).toEqual(["notes/final draft.md"]);
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
    expect(prompts[0]).toContain('load_skill("source-grounded-writing")');
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

    // office-zh / social-science-zh: full skill pointers
    expect(prompts[0]).toContain('load_skill("socratic-revision-zh")');
    expect(prompts[0]).toContain('load_skill("cascade-consistency-zh")');
    // minimal: no skill pointers at all
    expect(prompts[1]).not.toContain('load_skill("socratic-revision-zh")');
    expect(prompts[1]).not.toContain('load_skill("cascade-consistency-zh")');
    expect(prompts[2]).toContain('load_skill("socratic-revision-zh")');
    expect(prompts[2]).toContain('load_skill("cascade-consistency-zh")');
  });
});
