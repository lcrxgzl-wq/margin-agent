import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiLoopResult } from "./pi-loop.js";
import type { WorkspaceBridge } from "./session-tools.js";

const mocks = vi.hoisted(() => ({
  runPiAgentLoop: vi.fn(),
  streamDiscuss: vi.fn(),
}));

vi.mock("./pi-loop.js", () => ({
  runPiAgentLoop: mocks.runPiAgentLoop,
}));

vi.mock("@margin/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@margin/llm")>();
  return {
    ...actual,
    streamDiscuss: mocks.streamDiscuss,
  };
});

vi.mock("./resolve-model.js", () => ({
  effectiveThinkingLevel: () => undefined,
  hasRuntimeCredentials: () => true,
  resolveRuntimeModel: () => ({ model: { contextWindow: 128_000 }, apiKey: "test-key" }),
}));

const {
  runOfflineSessionTurn,
  runPiSessionTurn,
  composeVisibleReply,
  CONTEXT_TIER_PRESETS,
} = await import("./session-runner.js");

const bridge: WorkspaceBridge = {
  listSourceFiles: () => [],
  readText: () => {
    throw new Error("unused");
  },
  readVersion: (relativePath) => ({
    relativePath,
    bytes: 0,
    versionHash: "a".repeat(64),
  }),
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
  mocks.streamDiscuss.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("composeVisibleReply", () => {
  it("uses finish_turn.summary when assistant text is empty", () => {
    expect(composeVisibleReply("", "完整结构分析")).toBe("完整结构分析");
  });

  it("keeps assistant text when summary is empty", () => {
    expect(composeVisibleReply("短状态", "")).toBe("短状态");
  });

  it("appends a distinct summary after spoken status text", () => {
    expect(composeVisibleReply("我继续推进结构判断。", "一、拒稿点\n二、重排方案")).toBe(
      "我继续推进结构判断。\n\n一、拒稿点\n二、重排方案",
    );
  });

  it("does not duplicate when summary is already inside spoken text", () => {
    const body = "完整结构分析已经在正文里。";
    expect(composeVisibleReply(body, "完整结构分析已经在正文里。")).toBe(body);
  });
});

describe("session assistant text boundaries", () => {
  it("returns a clean reply while preserving the raw Pi transcript", async () => {
    const rawText = "Visible<thinking>private chain of thought</thinking> answer";
    mocks.runPiAgentLoop.mockResolvedValue({
      ...loopResult(),
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: rawText }],
      }],
      streamedText: "Visible answer",
    });

    const turn = await runPiSessionTurn({
      message: "继续",
      bridge,
      bag: { revision: 0, blocks: [] },
    });

    expect(turn.reply).toBe("Visible answer");
    expect(JSON.stringify(turn.messages)).toContain(rawText);
  });

  it("does not reuse an earlier assistant reply when the current turn has no text", async () => {
    mocks.runPiAgentLoop.mockResolvedValue({
      ...loopResult(),
      messages: [
        { role: "user", content: "上一问" },
        { role: "assistant", content: [{ type: "text", text: "上一轮回答" }] },
        { role: "user", content: "当前问题" },
        { role: "assistant", content: [{ type: "toolCall", id: "finish-1" }] },
      ] as never,
    });

    const turn = await runPiSessionTurn({
      message: "当前问题",
      bridge,
      bag: { revision: 0, blocks: [] },
    });

    expect(turn.reply).toBe("本轮已结束。若要继续，直接说下一步。");
    expect(turn.reply).not.toContain("上一轮回答");
  });

  it("filters thinking blocks split across streamDiscuss chunks", async () => {
    const chunks = [
      "Visible <thi",
      "nking>private chain of thought</think",
      "ing> answer",
    ];
    mocks.streamDiscuss.mockImplementation(async (_input, onDelta) => {
      for (const chunk of chunks) onDelta?.(chunk);
      return chunks.join("");
    });
    const deltas: string[] = [];

    const turn = await runOfflineSessionTurn({
      message: "谈谈这个研究问题",
      bridge,
      bag: { revision: 0, blocks: [] },
      onDelta: (chunk) => deltas.push(chunk),
    });

    expect(deltas.join("")).toBe("Visible  answer");
    expect(turn.reply).toBe("Visible  answer");
  });
});

describe("recoverable Pi loop stops", () => {
  it.each([
    "stopped after 40 turns",
    "stopped after repeated non-progress read: read_document_blocks",
  ])("marks %s as requiring continuation", async (note) => {
    mocks.runPiAgentLoop.mockResolvedValue({
      ...loopResult(),
      outcome: "aborted",
      notes: [note],
      streamedText: "已完成部分通读。",
    });

    const turn = await runPiSessionTurn({
      message: "通读全文并分析结构",
      bridge,
      bag: { revision: 0, blocks: [] },
    });

    expect(turn.continuationRequired).toBe(true);
    expect(turn.reply).toContain("继续");
  });

  it("does not promise cursor continuation after switching documents", async () => {
    const switchingBridge: WorkspaceBridge = {
      ...bridge,
      listSourceFiles: () => ["b.md"],
      openDocument: async () => ({
        document: {
          id: "doc-b",
          relativePath: "b.md",
          revision: 2,
          contentHash: "document-b-hash",
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
        blocks: [{
          id: "b1",
          kind: "paragraph",
          text: "Document B",
          order: 0,
          contentHash: "block-b-hash",
        }],
      }),
    };
    mocks.runPiAgentLoop.mockImplementationOnce(async (input: {
      tools: Array<{
        name: string;
        execute: (id: string, params: unknown) => Promise<unknown>;
      }>;
    }) => {
      const openDocument = input.tools.find((tool) => tool.name === "open_document");
      await openDocument!.execute("open-b", { relativePath: "b.md" });
      return {
        ...loopResult(),
        outcome: "aborted",
        notes: ["stopped after 40 turns"],
        streamedText: "已完成部分读取。",
      };
    });

    const turn = await runPiSessionTurn({
      message: "打开 b.md 并分析",
      bridge: switchingBridge,
      bag: {
        documentId: "doc-a",
        relativePath: "a.md",
        revision: 1,
        blocks: [{
          id: "a1",
          kind: "paragraph",
          text: "Document A",
          order: 0,
          contentHash: "block-a-hash",
        }],
      },
    });

    expect(turn.documentSwitchOccurred).toBe(true);
    expect(turn.continuationRequired).toBeUndefined();
    expect(turn.reply).toContain("请针对当前文稿重新提出任务");
    expect(turn.reply).not.toContain("block/cursor");
  });
});

describe("offline rewrite cancellation", () => {
  const envKeys = ["MARGIN_API_FORMAT", "MARGIN_BASE_URL", "MARGIN_API_KEY"] as const;
  let savedEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as typeof savedEnv;
    process.env.MARGIN_API_FORMAT = "openai";
    process.env.MARGIN_BASE_URL = "https://provider.test/v1";
    process.env.MARGIN_API_KEY = "test-key";
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("aborts a simple-mode rewrite completion with the caller signal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    ));
    const controller = new AbortController();
    const pending = runOfflineSessionTurn({
      message: "重写这段",
      bridge,
      bag: {
        documentId: "doc-1",
        revision: 0,
        blocks: [{
          id: "b1",
          kind: "paragraph",
          text: "Original paragraph.",
          order: 0,
          contentHash: "hash-1",
        }],
      },
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("runOfflineSessionTurn open intents", () => {
  it("opens spaced DOCX paths and returns a soft error for PDF", async () => {
    const opened: string[] = [];
    const localBridge: WorkspaceBridge = {
      listSourceFiles: () => ["imports/sport value.docx", "notes/report.pdf"],
      readText: () => {
        throw new Error("unused");
      },
      writeText: async () => {
        throw new Error("unused");
      },
      openDocument: async (relativePath) => {
        opened.push(relativePath);
        if (relativePath.endsWith(".pdf")) {
          throw new Error(
            "open_document only supports Markdown (.md/.markdown) and Word (.docx); use read_workspace_file for pdf/txt/csv",
          );
        }
        return {
          document: {
            id: "doc-1",
            relativePath,
            revision: 0,
            contentHash: "hash",
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
          blocks: [
            {
              id: "b1",
              kind: "paragraph",
              text: "body",
              order: 0,
              contentHash: "b1",
            },
          ],
        };
      },
    };

    const openedTurn = await runOfflineSessionTurn({
      message: '打开 "imports/sport value.docx"',
      bridge: localBridge,
      bag: { revision: 0, blocks: [] },
    });
    expect(opened).toEqual(["imports/sport value.docx"]);
    expect(openedTurn.opened?.document.relativePath).toBe("imports/sport value.docx");
    expect(openedTurn.reply).toContain("已打开");

    const pdfTurn = await runOfflineSessionTurn({
      message: "打开 notes/report.pdf",
      bridge: localBridge,
      bag: { revision: 0, blocks: [] },
    });
    expect(pdfTurn.opened).toBeUndefined();
    expect(pdfTurn.reply).toMatch(/打开失败：.*read_workspace_file/);
  });

  it("opens after 打开文件 phrasing instead of listing", async () => {
    const opened: string[] = [];
    const localBridge: WorkspaceBridge = {
      listSourceFiles: () => ["paper.md"],
      readText: () => {
        throw new Error("unused");
      },
      writeText: async () => {
        throw new Error("unused");
      },
      openDocument: async (relativePath) => {
        opened.push(relativePath);
        return {
          document: {
            id: "doc-md",
            relativePath,
            revision: 0,
            contentHash: "hash",
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
          blocks: [],
        };
      },
    };
    const turn = await runOfflineSessionTurn({
      message: "打开文件 paper.md",
      bridge: localBridge,
      bag: { revision: 0, blocks: [] },
    });
    expect(opened).toEqual(["paper.md"]);
    expect(turn.opened?.document.relativePath).toBe("paper.md");
  });
});

describe("offline academic checklists", () => {
  it("returns actual checker runs without creating heuristic comments or proposals", async () => {
    const turn = await runOfflineSessionTurn({
      message: "检查引用和语体风格",
      bridge,
      bag: {
        documentId: "doc-1",
        revision: 0,
        relativePath: "paper.md",
        blocks: [{
          id: "b1",
          kind: "paragraph",
          text: "新时代背景下（张三，2020）的治理研究具有重要的理论意义。",
          order: 0,
          contentHash: "hash-b1",
        }],
      },
    });

    expect(turn.proposals).toEqual([]);
    expect(turn.comments).toEqual([]);
    expect(turn.reviewChecklists?.map((entry) => entry.run.checker)).toEqual([
      "cite_check",
      "style_lint",
    ]);
    expect(turn.reviewChecklists?.flatMap((entry) => entry.items).length).toBeGreaterThan(0);
  });
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
    expect(mocks.runPiAgentLoop.mock.calls[0]![0].timeoutMs).toBe(300_000);
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

  it("forwards explicit transient retry settings", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      retryAttempts: 7,
      retryDelayMs: 45_000,
    });
    expect(mocks.runPiAgentLoop.mock.calls[0]![0]).toMatchObject({
      retryAttempts: 7,
      retryDelayMs: 45_000,
    });
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
        selectionChars: 2_000,
        outlineHeadings: 24,
        contextMessages: 48,
        contextChars: 80_000,
        compactionFloor: 64,
        adjacentBlocksPerSide: 0,
        adjacentBlockChars: 0,
      },
      standard: {
        selectionChars: 12_000,
        outlineHeadings: 48,
        contextMessages: 120,
        contextChars: 300_000,
        compactionFloor: 512,
        adjacentBlocksPerSide: 1,
        adjacentBlockChars: 1_200,
      },
      max: {
        selectionChars: 48_000,
        outlineHeadings: 0,
        contextMessages: 180,
        contextChars: 800_000,
        compactionFloor: 2_000,
        adjacentBlocksPerSide: 2,
        adjacentBlockChars: 2_000,
      },
    });
  });

  it("uses the complete standard selection budget when contextTier is unset", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      selectionHint: "x".repeat(13_000),
    });
    expect(lastPrompt()).toContain("x".repeat(12_000));
    expect(lastPrompt()).not.toContain("x".repeat(12_001));
  });

  it("slices the selection inline per tier (eco 2000 / max 48000)", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      selectionHint: "x".repeat(3_000),
      contextTier: "eco",
    });
    expect(lastPrompt()).toContain("x".repeat(2_000));
    expect(lastPrompt()).not.toContain("x".repeat(2_001));

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      selectionHint: "x".repeat(49_000),
      contextTier: "max",
    });
    expect(lastPrompt()).toContain("x".repeat(48_000));
    expect(lastPrompt()).not.toContain("x".repeat(48_001));
  });

  it("injects a bounded host-owned evidence directory independently of tool history", async () => {
    const sourceRef = "notes.txt#sha256=0123456789abcdef&chars=0-8";
    await runPiSessionTurn({
      message: "继续依据资料修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      sourcePaths: ["notes.txt"],
      evidenceCache: [{
        sourceRef,
        relativePath: "notes.txt",
        start: 0,
        end: 8,
        extractedHash: "0123456789abcdef",
        versionHash: "a".repeat(64),
        preview: "访谈证据摘录",
        readAt: "2026-08-01T00:00:00.000Z",
      }],
      messages: [{
        role: "user",
        content: "[旧工具输出已清理]",
        timestamp: Date.now(),
      }] as never,
    });
    expect(lastPrompt()).toContain("[会话已读证据目录]");
    expect(lastPrompt()).toContain(sourceRef);
    expect(lastPrompt()).toContain("宿主会重新校验原文件 SHA-256");
  });

  it("evicts stale evidence before building the prompt directory", async () => {
    const sourceRef = "notes.txt#sha256=0123456789abcdef&chars=0-8";
    let persisted = [{
      sourceRef,
      relativePath: "notes.txt",
      start: 0,
      end: 8,
      extractedHash: "0123456789abcdef",
      versionHash: "a".repeat(64),
      preview: "stale preview",
      readAt: "2026-08-01T00:00:00.000Z",
    }];
    await runPiSessionTurn({
      message: "继续依据资料修订",
      bridge: {
        ...bridge,
        readVersion: (relativePath) => ({
          relativePath,
          bytes: 9,
          versionHash: "b".repeat(64),
        }),
      },
      bag: { revision: 0, blocks: [] },
      sourcePaths: ["notes.txt"],
      evidenceCache: persisted,
      onEvidenceCacheChange: (entries) => { persisted = entries; },
    });

    expect(lastPrompt()).not.toContain("[会话已读证据目录]");
    expect(lastPrompt()).not.toContain(sourceRef);
    expect(lastPrompt()).not.toContain("stale preview");
    expect(persisted).toEqual([]);
  });

  it("publishes cache normalization even when retained evidence is fresh", async () => {
    const retained = {
      sourceRef: "notes.txt#sha256=0123456789abcdef&chars=0-8",
      relativePath: "notes.txt",
      start: 0,
      end: 8,
      extractedHash: "0123456789abcdef",
      versionHash: "a".repeat(64),
      preview: "retained preview",
      readAt: "2026-08-01T00:00:00.000Z",
    };
    const detached = {
      ...retained,
      sourceRef: "detached.txt#sha256=0123456789abcdef&chars=0-8",
      relativePath: "detached.txt",
      preview: "must be removed",
    };
    let persisted = [retained, detached];

    await runPiSessionTurn({
      message: "继续依据资料修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      sourcePaths: ["notes.txt"],
      evidenceCache: persisted,
      onEvidenceCacheChange: (entries) => { persisted = entries; },
    });

    expect(persisted).toEqual([retained]);
    expect(lastPrompt()).toContain(retained.sourceRef);
    expect(lastPrompt()).not.toContain(detached.sourceRef);
  });

  it("injects the full open document instead of a 通读 ceremony", async () => {
    await runPiSessionTurn({
      message: "请通读全文并做结构分析",
      bridge,
      bag: {
        revision: 3,
        relativePath: "paper.md",
        blocks: [{ id: "b1", kind: "paragraph", text: "hello body", order: 0, contentHash: "h" }],
      },
    });
    expect(lastPrompt()).not.toContain("[通读策略]");
    expect(lastPrompt()).toContain("[Margin 文稿全文 revision=3 path=paper.md blocks=1]");
    expect(lastPrompt()).toContain("### b1 (paragraph)");
    expect(lastPrompt()).toContain("hello body");
    expect(lastPrompt()).not.toContain("大纲（仅标题）");
  });

  it("keeps selection focus without neighbor context in full mode", async () => {
    const blocks = [
      paragraph("b1", 0, "前文段落内容"),
      paragraph("b2", 1, "选中段落内容"),
      paragraph("b3", 2, "后文段落内容"),
    ];
    const turn = await runPiSessionTurn({
      message: "润色这段",
      bridge,
      bag: { revision: 1, relativePath: "paper.md", blocks },
      selectionBlockIds: ["b2"],
      selectionHint: "选中段落内容",
    });
    expect(turn.documentMode).toBe("full");
    expect(lastPrompt()).toContain("[Margin 文稿全文 revision=1");
    expect(lastPrompt()).toContain('用户当前选区（blockIds: b2）');
    expect(lastPrompt()).toContain("选中段落内容");
    expect(lastPrompt()).not.toContain("[选区上下文]");
  });

  it("strips prior full-document copies from the transcript before the next turn", async () => {
    const injection = [
      "[Margin 文稿全文 revision=1 path=old.md blocks=1]",
      "### old (paragraph)",
      "stale body that must leave",
      "[/Margin 文稿全文]",
    ].join("\n");
    await runPiSessionTurn({
      message: "继续",
      bridge,
      bag: {
        revision: 2,
        relativePath: "paper.md",
        blocks: [{ id: "b1", kind: "paragraph", text: "fresh body", order: 0, contentHash: "h" }],
      },
      messages: [{ role: "user", content: `上一问\n${injection}` } as never],
    });
    expect(lastOpts().messages as Array<{ content?: string }>).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("[Margin 文稿全文已移除；以本轮注入为准]"),
      }),
    ]);
    expect(String((lastOpts().messages as Array<{ content?: string }>)[0]?.content ?? ""))
      .not.toContain("stale body that must leave");
    expect(lastPrompt()).toContain("fresh body");
    expect(lastPrompt()).toContain("revision=2");
  });

  it("uses the complete standard loop preset when contextTier is unset", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
    });
    expect(lastOpts().maxContextMessages).toBe(120);
    expect(lastOpts().maxContextChars).toBe(300_000);
    expect(lastOpts().toolCompactionFloor).toBe(512);
  });

  it("passes tier loop limits to the pi loop", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      contextTier: "eco",
    });
    expect(lastOpts().maxContextMessages).toBe(48);
    expect(lastOpts().maxContextChars).toBe(80_000);
    expect(lastOpts().toolCompactionFloor).toBe(64);

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      contextTier: "standard",
    });
    expect(lastOpts().maxContextMessages).toBe(120);
    expect(lastOpts().maxContextChars).toBe(300_000);
    expect(lastOpts().toolCompactionFloor).toBe(512);

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      contextTier: "max",
    });
    expect(lastOpts().maxContextMessages).toBe(180);
    expect(lastOpts().maxContextChars).toBe(800_000);
    expect(lastOpts().toolCompactionFloor).toBe(2_000);
  });

  it("caps outline headings at 48 by default, 24 on eco, unlimited on max", async () => {
    const blocks = Array.from({ length: 60 }, (_, i) => heading(`h${i + 1}`, i, `标题 ${i + 1}`));

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      documentModeLeanLock: true,
    });
    expect(lastPrompt()).toContain("标题 48");
    expect(lastPrompt()).not.toContain("标题 49");
    expect(lastPrompt()).not.toContain("[Margin 文稿全文");

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      contextTier: "eco",
    });
    expect(lastPrompt()).toContain("标题 24");
    expect(lastPrompt()).not.toContain("标题 25");

    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      contextTier: "max",
      documentModeLeanLock: true,
    });
    expect(lastPrompt()).toContain("标题 60");
  });

  it("injects one block per side on the default standard tier", async () => {
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
      documentModeLeanLock: true,
    });
    expect(lastPrompt()).toContain("[选区上下文]");
    expect(lastPrompt()).toContain("前文段落内容");
    expect(lastPrompt()).toContain("后文段落内容");
  });

  it("injects two blocks per side and caps each at 2000 chars on max tier", async () => {
    const blocks = [
      paragraph("b1", 0, "far-before"),
      paragraph("b2", 1, "p".repeat(2_500)),
      paragraph("b3", 2, "选中段落"),
      paragraph("b4", 3, "near-after"),
      paragraph("b5", 4, "far-after"),
    ];
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks },
      selectionBlockIds: ["b3"],
      contextTier: "max",
      documentModeLeanLock: true,
    });
    expect(lastPrompt()).toContain("far-before");
    expect(lastPrompt()).toContain("p".repeat(2_000));
    expect(lastPrompt()).not.toContain("p".repeat(2_001));
    expect(lastPrompt()).toContain("near-after");
    expect(lastPrompt()).toContain("far-after");
  });

  it("does not inject adjacent blocks on eco or without a locatable selection", async () => {
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
      contextTier: "eco",
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
      selectionHint: "x".repeat(13_000),
      contextTier: "ludicrous" as never,
    });
    expect(lastPrompt()).toContain("x".repeat(12_000));
    expect(lastPrompt()).not.toContain("x".repeat(12_001));
    expect(lastOpts().maxContextMessages).toBe(120);
    expect(lastOpts().toolCompactionFloor).toBe(512);
  });

  it("lets a valid custom selection cap override the context tier", async () => {
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      selectionHint: "x".repeat(64_001),
      selectionContextChars: 64_000,
      contextTier: "eco",
    });
    expect(lastPrompt()).toContain("x".repeat(64_000));
    expect(lastPrompt()).not.toContain("x".repeat(64_001));
  });

  it("budgets and preserves a 100k quote-heavy selection by serialized size", async () => {
    const selection = '"'.repeat(100_000);
    await runPiSessionTurn({
      message: "继续修订",
      bridge,
      bag: { revision: 0, blocks: [] },
      selectionHint: selection,
      selectionContextChars: 100_000,
      contextTier: "eco",
    });

    const prompt = lastPrompt();
    const selectionStart = prompt.indexOf('：\n"""\n') + '：\n"""\n'.length;
    const selectionEnd = prompt.indexOf('\n"""', selectionStart);
    expect(prompt.slice(selectionStart, selectionEnd)).toBe(selection);
    expect(lastOpts().maxContextChars).toBeGreaterThan(
      JSON.stringify({ role: "user", content: prompt }).length,
    );
  });
});
