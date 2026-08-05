import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveAgentSession,
  getDocument,
  latestAgentCompactionSummary,
  listActiveReviewChecklists,
  listAgentCompactions,
  listBlocks,
  loadAgentSession,
  loadAgentSessionEnvelope,
  openDocument,
  openWorkspace,
  saveAgentSession,
  saveDecision,
  saveLlmSettings,
  saveProposal,
  type Workspace,
} from "@margin/storage-local";
import type { CompactionEvent } from "@margin/agent";
import { ChatMemory } from "./chat-memory.js";
import {
  appendConversationNote,
  buildTranscriptPayload,
  chatAgentStateFromSession,
  clearChatAgentConversation,
  closeChatAgentDocument,
  compactChatAgentConversation,
  createChatAgentState,
  createWorkspaceBridge,
  isCloseDocumentRequest,
  replaceAttachedSources,
  restoreChatAgentState,
  rotateChatSessionWithSummary,
  runChatAgentTurn,
  settleCompactionEvent,
  syncBagFromDocument,
  type AgentMessage,
} from "./chat-agent.js";

const dirs: string[] = [];

const evidenceEntry = {
  sourceRef: "notes.txt#sha256=0123456789abcdef&chars=0-4",
  relativePath: "notes.txt",
  start: 0,
  end: 4,
  extractedHash: "0123456789abcdef",
  versionHash: "a".repeat(64),
  preview: "note",
  readAt: "2026-08-01T00:00:00.000Z",
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may briefly retain SQLite handles. */
    }
  }
});

describe("buildTranscriptPayload", () => {
  it("keeps transcript metadata bounded without cumulative messages", () => {
    const payload = buildTranscriptPayload({
      steps: Array.from({ length: 40 }, (_, index) => `step-${index}`),
      reply: "x".repeat(2_000),
      proposalCount: 2,
      clarificationRounds: 1,
      sessionId: "session",
      engine: "pi",
      notes: Array.from({ length: 20 }, () => "n".repeat(600)),
      loadedSkills: [],
      sourcePaths: Array.from({ length: 60 }, (_, index) => `source-${index}.md`),
      toolAudit: Array.from({ length: 30 }, (_, index) => ({
        toolCallId: `call-${index}`,
        toolName: "get_block",
        status: "completed" as const,
        durationMs: index + 0.9,
        args: { blockId: `b${index}` },
      })),
    });

    expect(payload.steps).toHaveLength(24);
    expect(payload.replySummary).toHaveLength(1_000);
    expect(payload.notes).toHaveLength(12);
    expect(payload.notes?.every((note) => note.length === 500)).toBe(true);
    expect(payload.sourcePaths).toHaveLength(50);
    expect(payload.toolAudit).toHaveLength(24);
    expect(payload.toolAudit?.at(-1)).toMatchObject({ durationMs: 29 });
    expect(payload).not.toHaveProperty("toolTrail");
  });

  it("restores the current document bag from the persisted session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-agent-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "# Title\n\nBody text.\n", "utf8");
    const workspace = await openWorkspace(root);
    try {
      const document = openDocument(workspace, "paper.md");
      saveAgentSession(workspace, {
        sessionId: "session",
        documentId: document.id,
        messages: [],
        clarificationRounds: 0,
        chatTurns: [],
        sourcePaths: [],
        task: {
          objective: "continue research",
          status: "running",
          documentId: document.id,
          documentRevision: document.revision,
          currentStep: "正在读取文件…",
          sourcePaths: [],
          sourceRefs: [],
          proposalCount: 0,
          inspectedDocument: false,
          consistencyChecked: false,
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
      });

      const restored = restoreChatAgentState(workspace);

      expect(restored.bag.documentId).toBe(document.id);
      expect(restored.bag.relativePath).toBe("paper.md");
      expect(restored.bag.blocks).toHaveLength(2);
      expect(restored.task?.status).toBe("interrupted");
    } finally {
      workspace.db.close();
      await workspace.releaseLock();
    }
  });
});

describe("chat checklist persistence", () => {
  it("persists an actually invoked checker even when the turn has no Proposal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-checklist-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "（张三，2020）提出这一判断。\n", "utf8");
    const workspace = await openWorkspace(root);
    const previousEngine = process.env.MARGIN_ENGINE;
    process.env.MARGIN_ENGINE = "simple";
    try {
      const document = openDocument(workspace, "paper.md");
      const blocks = listBlocks(workspace, document.id);
      const state = createChatAgentState({ sessionId: "chat-checklist" });
      syncBagFromDocument(state, document, blocks);

      const result = await runChatAgentTurn({
        workspace,
        chat: new ChatMemory(),
        agentState: state,
        message: "检查引用形态",
      });

      expect(result.proposalCount).toBe(0);
      expect(listActiveReviewChecklists(workspace, document.id)).toMatchObject([{
        run: { checker: "cite_check", status: "active" },
        items: [expect.objectContaining({ issueType: "citation.author_year" })],
      }]);
    } finally {
      if (previousEngine === undefined) delete process.env.MARGIN_ENGINE;
      else process.env.MARGIN_ENGINE = previousEngine;
      workspace.db.close();
      await workspace.releaseLock();
    }
  });
});

describe("workspace bridge extensions", () => {
  it("opens Markdown and DOCX through the agent open_document bridge", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-agent-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "# Title\n\nBody text.\n", "utf8");
    const { Document, Packer, Paragraph } = await import("docx");
    const buffer = Buffer.from(
      await Packer.toBuffer(
        new Document({
          sections: [{ children: [new Paragraph("Native DOCX paragraph")] }],
        }),
      ),
    );
    fs.writeFileSync(path.join(root, "paper.docx"), buffer);
    const workspace = await openWorkspace(root);
    try {
      const bridge = createWorkspaceBridge(workspace);
      await expect(bridge.openDocument("paper.md")).resolves.toMatchObject({
        document: { relativePath: "paper.md" },
      });
      await expect(bridge.openDocument("paper.docx")).resolves.toMatchObject({
        document: { relativePath: "paper.docx" },
        blocks: expect.arrayContaining([
          expect.objectContaining({ text: "Native DOCX paragraph" }),
        ]),
      });
    } finally {
      workspace.db.close();
      await workspace.releaseLock();
    }
  });

  it("keeps an unchanged active path cached but reindexes an external edit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-agent-reopen-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "Original text.\n", "utf8");
    const workspace = await openWorkspace(root);
    try {
      const document = openDocument(workspace, "paper.md");
      const bag = {
        documentId: document.id,
        revision: document.revision,
        relativePath: document.relativePath,
        blocks: listBlocks(workspace, document.id),
      };
      const bridge = createWorkspaceBridge(workspace, bag);
      const unchanged = await bridge.openDocument("./paper.md");
      expect(unchanged.document).toEqual(document);
      expect(unchanged.blocks).toEqual(bag.blocks);
      expect(unchanged.alreadyOpen).toBe(true);

      fs.writeFileSync(path.join(root, "paper.md"), "Externally changed text.\n", "utf8");

      const reopened = await bridge.openDocument("./paper.md");

      expect(reopened.document).toMatchObject({
        id: document.id,
        revision: document.revision + 1,
      });
      expect(reopened.blocks.map((block) => block.text)).toEqual(["Externally changed text."]);
      expect(reopened.alreadyOpen).toBe(false);
      expect(getDocument(workspace, document.id)).toEqual(reopened.document);
    } finally {
      workspace.db.close();
      await workspace.releaseLock();
    }
  });

  it("never exposes configured MCP tools to the agent bridge", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-agent-"));
    dirs.push(root);
    const workspace = { root } as Workspace;

    expect("mcp" in createWorkspaceBridge(workspace)).toBe(false);

    fs.mkdirSync(path.join(root, ".margin"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".margin", "mcp-settings.json"),
      JSON.stringify({
        servers: [{
          id: "ignored",
          name: "Library",
          url: "https://example.test/mcp",
          enabledTools: [{ name: "lookup", description: "Read evidence" }],
        }],
      }),
      "utf8",
    );

    expect("mcp" in createWorkspaceBridge(workspace)).toBe(false);
  });

  it("defaults unlimited-read ON through bridge.readText", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-agent-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "margin-outside-"));
    dirs.push(root, outside);
    const target = path.join(outside, "external.txt");
    fs.writeFileSync(target, "external evidence", "utf8");
    const workspace = await openWorkspace(root);
    const previous = process.env.MARGIN_UNLIMITED;
    try {
      const bridge = createWorkspaceBridge(workspace);
      delete process.env.MARGIN_UNLIMITED;
      await expect(bridge.readText(target)).resolves.toMatchObject({
        relativePath: target,
        text: "external evidence",
      });

      process.env.MARGIN_UNLIMITED = "0";
      await expect(bridge.readText(target)).rejects.toThrow(/outside workspace/);
    } finally {
      if (previous === undefined) delete process.env.MARGIN_UNLIMITED;
      else process.env.MARGIN_UNLIMITED = previous;
      workspace.db.close();
      await workspace.releaseLock();
    }
  });

  it("honors unlimited-read=false from llm settings without restart env", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-agent-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "margin-outside-"));
    dirs.push(root, outside);
    const target = path.join(outside, "external.txt");
    fs.writeFileSync(target, "settings evidence", "utf8");
    const workspace = await openWorkspace(root);
    const previous = process.env.MARGIN_UNLIMITED;
    try {
      delete process.env.MARGIN_UNLIMITED;
      const bridge = createWorkspaceBridge(workspace);
      await expect(bridge.readText(target)).resolves.toMatchObject({
        relativePath: target,
        text: "settings evidence",
      });

      await saveLlmSettings(root, { unlimitedRead: false });
      await expect(bridge.readText(target)).rejects.toThrow(/outside workspace/);
    } finally {
      if (previous === undefined) delete process.env.MARGIN_UNLIMITED;
      else process.env.MARGIN_UNLIMITED = previous;
      workspace.db.close();
      await workspace.releaseLock();
    }
  });
});

describe("chat session lifecycle", () => {
  it("clears chat memory without detaching the current document or sources", () => {
    const state = createChatAgentState({
      sessionId: "before",
      agentMessages: [{ role: "user", content: "revise" }],
      clarificationRounds: 2,
      sourcePaths: ["notes.txt"],
      evidenceCache: [evidenceEntry],
      sourceDocumentId: "document-1",
    });
    state.bag = {
      documentId: "document-1",
      relativePath: "paper.docx",
      revision: 3,
      blocks: [],
    };

    clearChatAgentConversation(state);

    expect(state.agentMessages).toEqual([]);
    expect(state.clarificationRounds).toBe(0);
    expect(state.bag.documentId).toBe("document-1");
    expect(state.sourcePaths).toEqual(["notes.txt"]);
    expect(state.evidenceCache).toEqual([]);
    expect(state.sourceDocumentId).toBe("document-1");
    expect(state.sessionId).not.toBe("before");
  });

  it("closes all document-scoped state", () => {
    const state = createChatAgentState({
      agentMessages: [{ role: "user", content: "revise" }],
      clarificationRounds: 3,
      sourcePaths: ["notes.txt"],
      evidenceCache: [evidenceEntry],
      sourceDocumentId: "document-1",
    });
    state.bag = {
      documentId: "document-1",
      relativePath: "paper.docx",
      revision: 3,
      blocks: [{ id: "block-1" } as never],
    };

    closeChatAgentDocument(state);

    expect(state.bag).toEqual({ revision: 0, blocks: [] });
    expect(state.agentMessages).toEqual([]);
    expect(state.clarificationRounds).toBe(0);
    expect(state.sourcePaths).toEqual([]);
    expect(state.evidenceCache).toEqual([]);
    expect(state.sourceDocumentId).toBeUndefined();
  });

  it("starts a clean agent conversation when switching documents", () => {
    const state = createChatAgentState({
      sessionId: "before",
      agentMessages: [{ role: "user", content: "private context" }],
      clarificationRounds: 2,
      sourcePaths: ["notes.txt"],
      evidenceCache: [evidenceEntry],
      sourceDocumentId: "document-1",
    });
    state.bag = { documentId: "document-1", revision: 1, blocks: [] };

    const switched = syncBagFromDocument(
      state,
      {
        id: "document-2",
        relativePath: "other.docx",
        revision: 0,
        contentHash: "hash",
      },
      [],
    );

    expect(switched).toBe(true);
    expect(state.bag.documentId).toBe("document-2");
    expect(state.agentMessages).toEqual([]);
    expect(state.clarificationRounds).toBe(0);
    expect(state.sourcePaths).toEqual([]);
    expect(state.evidenceCache).toEqual([]);
    expect(state.sessionId).not.toBe("before");
  });

  it("clears document-scoped context when open_document switches the active document", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-tool-switch-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "first.md"), "# First\n\nPrivate draft.\n", "utf8");
    fs.writeFileSync(path.join(root, "second.md"), "# Second\n\nFresh draft.\n", "utf8");
    fs.writeFileSync(path.join(root, "notes.txt"), "private evidence", "utf8");
    const workspace = await openWorkspace(root);
    const previousEngine = process.env.MARGIN_ENGINE;
    process.env.MARGIN_ENGINE = "simple";
    try {
      const first = openDocument(workspace, "first.md");
      const state = createChatAgentState({
        sessionId: "first-session",
        agentMessages: [{ role: "user", content: "private transcript" }],
        clarificationRounds: 2,
      });
      syncBagFromDocument(state, first, listBlocks(workspace, first.id));
      replaceAttachedSources(state, workspace, ["notes.txt"]);
      state.evidenceCache = [evidenceEntry];
      const chat = new ChatMemory();
      chat.remember("user", "private chat memory");
      chat.remember("assistant", "private answer");

      const result = await runChatAgentTurn({
        workspace,
        chat,
        agentState: state,
        message: "打开 second.md",
      });

      expect(result.opened?.document.relativePath).toBe("second.md");
      expect(state.bag.documentId).toBe(result.opened?.document.id);
      expect(state.agentMessages).toEqual([]);
      expect(state.clarificationRounds).toBe(0);
      expect(state.sourcePaths).toEqual([]);
      expect(state.evidenceCache).toEqual([]);
      expect(state.sourceDocumentId).toBe(result.opened?.document.id);
      expect(state.sessionId).not.toBe("first-session");
      expect(chat.list()).toEqual([
        { role: "user", text: "打开 second.md" },
        { role: "assistant", text: result.reply },
      ]);
    } finally {
      if (previousEngine === undefined) delete process.env.MARGIN_ENGINE;
      else process.env.MARGIN_ENGINE = previousEngine;
      workspace.db.close();
      await workspace.releaseLock();
    }
  });

  it("recognizes explicit close commands without matching ordinary discussion", () => {
    expect(isCloseDocumentRequest("退出这个word")).toBe(true);
    expect(isCloseDocumentRequest("关闭当前文稿")).toBe(true);
    expect(isCloseDocumentRequest("请关闭 DOCX")).toBe(true);
    expect(isCloseDocumentRequest("讨论如何关闭文章结尾")).toBe(false);
  });

  it("evicts evidence when its attachment is removed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-evidence-detach-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "notes.txt"), "note", "utf8");
    fs.writeFileSync(path.join(root, "other.txt"), "other", "utf8");
    const workspace = await openWorkspace(root);
    try {
      const state = createChatAgentState({
        sourcePaths: ["notes.txt"],
        evidenceCache: [evidenceEntry],
      });

      replaceAttachedSources(state, workspace, ["other.txt"]);

      expect(state.sourcePaths).toEqual(["other.txt"]);
      expect(state.evidenceCache).toEqual([]);
    } finally {
      workspace.db.close();
      await workspace.releaseLock();
    }
  });

  it("attaches absolute external paths when unlimited-read is on", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-attach-ext-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "margin-outside-attach-"));
    dirs.push(root, outside);
    const target = path.join(outside, "external.txt");
    fs.writeFileSync(target, "external evidence", "utf8");
    const workspace = await openWorkspace(root);
    const previous = process.env.MARGIN_UNLIMITED;
    try {
      delete process.env.MARGIN_UNLIMITED;
      const state = createChatAgentState();
      const normalized = target.replace(/\\/g, "/");
      replaceAttachedSources(state, workspace, [target]);
      expect(state.sourcePaths).toEqual([normalized]);

      process.env.MARGIN_UNLIMITED = "0";
      expect(() => replaceAttachedSources(state, workspace, [target])).toThrow(/outside workspace/);
    } finally {
      if (previous === undefined) delete process.env.MARGIN_UNLIMITED;
      else process.env.MARGIN_UNLIMITED = previous;
      workspace.db.close();
      await workspace.releaseLock();
    }
  });
});

describe("chatAgentStateFromSession (session switch)", () => {
  it("restores documentModeLeanLock from persisted session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-leanlock-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "# Title\n\nBody text.\n", "utf8");
    const workspace = await openWorkspace(root);
    try {
      const document = openDocument(workspace, "paper.md");
      saveAgentSession(workspace, {
        sessionId: "s-lean-lock",
        documentId: document.id,
        messages: [{ role: "user", content: "hi" }],
        chatTurns: [{ role: "user", text: "hi" }],
        documentModeLeanLock: true,
      });
      const restored = chatAgentStateFromSession(workspace, loadAgentSession(workspace));
      expect(restored.documentModeLeanLock).toBe(true);
      const fresh = createChatAgentState();
      expect(fresh.documentModeLeanLock).toBe(false);
    } finally {
      workspace.db.close();
      await workspace.releaseLock();
    }
  });

  it("rebuilds agent state from an archived envelope, degrading on a missing document", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-switch-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "# Title\n\nBody text.\n", "utf8");
    const workspace = await openWorkspace(root);
    try {
      const document = openDocument(workspace, "paper.md");
      saveAgentSession(workspace, {
        sessionId: "s-1",
        documentId: document.id,
        messages: [{ role: "user", content: "hi" }],
        chatTurns: [{ role: "user", text: "hi" }],
        sourcePaths: ["paper.md"],
        evidenceCache: [{
          ...evidenceEntry,
          sourceRef: "paper.md#sha256=0123456789abcdef&chars=0-4",
          relativePath: "paper.md",
        }],
      });
      archiveAgentSession(workspace, "s-1");

      const envelope = loadAgentSessionEnvelope(workspace, "s-1");
      expect(envelope?.sessionId).toBe("s-1");

      const restored = chatAgentStateFromSession(workspace, envelope);
      expect(restored.sessionId).toBe("s-1");
      expect(restored.bag.documentId).toBe(document.id);
      expect(restored.bag.blocks.length).toBeGreaterThan(0);
      expect(restored.sourcePaths).toEqual(["paper.md"]);
      expect(restored.evidenceCache).toHaveLength(1);

      // A document that no longer exists: bag stays empty, sources detach.
      const ghost = chatAgentStateFromSession(workspace, {
        ...envelope!,
        documentId: "doc-gone",
      });
      expect(ghost.sessionId).toBe("s-1");
      expect(ghost.bag.documentId).toBeUndefined();
      expect(ghost.sourcePaths).toEqual([]);
      expect(ghost.evidenceCache).toEqual([]);
      expect(ghost.sourceDocumentId).toBeUndefined();

      // No envelope: a fresh state with a new sessionId.
      const fresh = chatAgentStateFromSession(workspace, null);
      expect(fresh.sessionId).not.toBe("s-1");
      expect(fresh.agentMessages).toEqual([]);
    } finally {
      try {
        workspace.db.close();
      } catch {
        /* ignore */
      }
      await workspace.releaseLock();
    }
  });
});

describe("appendConversationNote", () => {
  it("appends a [Margin 记录] user message in the pi user-message shape", () => {
    const state = createChatAgentState({
      agentMessages: [{ role: "user", content: "hi" }],
    });

    appendConversationNote(state, "[Margin 记录] 用户裁决：提案 p1 = 接受");

    expect(state.agentMessages).toHaveLength(2);
    const note = state.agentMessages.at(-1) as {
      role?: string;
      content?: unknown;
      timestamp?: unknown;
    };
    expect(note.role).toBe("user");
    expect(note.content).toBe("[Margin 记录] 用户裁决：提案 p1 = 接受");
    expect(typeof note.timestamp).toBe("number");
  });

  it("ignores blank notes", () => {
    const state = createChatAgentState();
    appendConversationNote(state, "   ");
    expect(state.agentMessages).toEqual([]);
  });

  it("persists and restores notes through the existing session storage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-note-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "# Title\n\nBody text.\n", "utf8");
    const workspace = await openWorkspace(root);
    try {
      const document = openDocument(workspace, "paper.md");
      const state = createChatAgentState({ sessionId: "s-note" });
      state.bag = {
        documentId: document.id,
        revision: document.revision,
        relativePath: document.relativePath,
        blocks: [],
      };
      appendConversationNote(state, "[Margin 记录] 用户裁决：提案 p1 = 接受");
      saveAgentSession(workspace, {
        sessionId: state.sessionId,
        documentId: state.bag.documentId,
        messages: state.agentMessages,
        chatTurns: [],
        sourcePaths: [],
      });

      const restored = restoreChatAgentState(workspace);

      const note = restored.agentMessages.at(-1) as { role?: string; content?: unknown };
      expect(note.role).toBe("user");
      expect(note.content).toBe("[Margin 记录] 用户裁决：提案 p1 = 接受");
    } finally {
      try {
        workspace.db.close();
      } catch {
        /* ignore */
      }
      await workspace.releaseLock();
    }
  });
});

describe("rotateChatSessionWithSummary", () => {
  it("archives the old session and seeds the new one with a rule-based summary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-rotate-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "first paragraph\n\nsecond paragraph\n", "utf8");
    const workspace = await openWorkspace(root);
    try {
      const document = openDocument(workspace, "paper.md");
      const blocks = listBlocks(workspace, document.id);
      saveProposal(workspace, {
        schemaVersion: 1,
        id: "proposal-rotate",
        documentId: document.id,
        blockId: blocks[0]!.id,
        baseRevision: document.revision,
        baseHash: blocks[0]!.contentHash,
        before: blocks[0]!.text,
        after: `${blocks[0]!.text} revised`,
        rationale: "test revision",
        risk: "language",
        evidence: [],
        status: "proposed",
        createdAt: "2026-07-28T00:00:00.000Z",
      });
      saveDecision(workspace, "proposal-rotate", "Y");
      saveAgentSession(workspace, {
        sessionId: "s-old",
        documentId: document.id,
        messages: [{ role: "user", content: "润色引言" }],
        chatTurns: [{ role: "user", text: "润色引言" }],
        sourcePaths: [],
      });
      const state = restoreChatAgentState(workspace);
      expect(state.sessionId).toBe("s-old");

      rotateChatSessionWithSummary(workspace, state, true);

      expect(state.sessionId).not.toBe("s-old");
      expect(state.agentMessages).toHaveLength(1);
      const note = state.agentMessages[0] as { role?: string; content?: unknown };
      expect(note.role).toBe("user");
      expect(String(note.content)).toContain("[Margin 记录] 上一会话摘要");
      expect(String(note.content)).toContain("主题「润色引言」");
      expect(String(note.content)).toContain("已接受 1、已拒绝 0、已编辑 0");
      expect(loadAgentSessionEnvelope(workspace, "s-old")).not.toBeNull();
    } finally {
      try {
        workspace.db.close();
      } catch {
        /* ignore */
      }
      await workspace.releaseLock();
    }
  });

  it("archives a task-only stale continuation before starting a new session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-rotate-stale-task-"));
    dirs.push(root);
    const paperPath = path.join(root, "paper.md");
    fs.writeFileSync(paperPath, "Original paragraph.\n", "utf8");
    const workspace = await openWorkspace(root);
    try {
      const document = openDocument(workspace, "paper.md");
      saveAgentSession(workspace, {
        sessionId: "s-stale-task",
        documentId: document.id,
        messages: [],
        chatTurns: [],
        sourcePaths: [],
        task: {
          objective: "审阅全文论证",
          status: "interrupted",
          documentId: document.id,
          documentRevision: document.revision,
          sourcePaths: [],
          sourceRefs: [],
          proposalCount: 0,
          inspectedDocument: false,
          consistencyChecked: false,
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
      });
      fs.writeFileSync(paperPath, "Revised paragraph.\n", "utf8");
      openDocument(workspace, "paper.md");
      const state = restoreChatAgentState(workspace);
      expect(state.task).toBeUndefined();

      rotateChatSessionWithSummary(workspace, state, false);

      expect(loadAgentSessionEnvelope(workspace, "s-stale-task")?.task).toMatchObject({
        objective: "审阅全文论证",
        status: "interrupted",
        documentRevision: document.revision,
      });
    } finally {
      try {
        workspace.db.close();
      } catch {
        /* ignore */
      }
      await workspace.releaseLock();
    }
  });

  it("injects nothing when there is no prior session content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-rotate-empty-"));
    dirs.push(root);
    const workspace = await openWorkspace(root);
    try {
      const state = createChatAgentState({ sessionId: "s-fresh" });

      rotateChatSessionWithSummary(workspace, state, false);

      expect(state.sessionId).not.toBe("s-fresh");
      expect(state.agentMessages).toEqual([]);
    } finally {
      try {
        workspace.db.close();
      } catch {
        /* ignore */
      }
      await workspace.releaseLock();
    }
  });
});

describe("settleCompactionEvent", () => {
  const u = (content: string, timestamp: number) =>
    ({ role: "user", content, timestamp }) as AgentMessage;
  const a = (text: string, timestamp: number) =>
    ({ role: "assistant", content: [{ type: "text", text }], timestamp }) as AgentMessage;

  const beforeTranscript = () => [u("u1", 1), a("a1", 2), u("u2", 3), a("a2", 4)];
  const summaryHead = (summary: string) =>
    u(`此前对话已压缩为以下摘要：\n\n${summary}`, 100);

  const compactionEvent = (overrides: Partial<CompactionEvent> = {}): CompactionEvent => {
    const before = beforeTranscript();
    return {
      eventId: "evt-1",
      reason: "threshold",
      tokensBefore: 90_000,
      tokensAfter: 20_000,
      summary: "压缩摘要",
      messagesBefore: before,
      messagesAfter: [summaryHead("压缩摘要"), ...before.slice(2)],
      ...overrides,
    };
  };

  it("archives messagesBefore and swaps the grown transcript's prefix for messagesAfter", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-compact-"));
    dirs.push(root);
    const workspace = await openWorkspace(root);
    try {
      // The turn appended more messages after the compaction snapshot.
      const state = createChatAgentState({
        sessionId: "s-compact",
        agentMessages: [...beforeTranscript(), u("u3", 5), a("a3", 6)],
      });
      const chat = new ChatMemory();
      const event = compactionEvent();

      const settled = settleCompactionEvent(workspace, state, chat, event);

      expect(settled).toBe(true);
      const contents = state.agentMessages.map((message) =>
        JSON.stringify((message as { content?: unknown }).content),
      );
      // [summary head, kept tail (u2, a2), post-compaction turn (u3, a3), note]
      expect(String((state.agentMessages[0] as { content?: unknown }).content))
        .toBe("此前对话已压缩为以下摘要：\n\n压缩摘要");
      expect((state.agentMessages[1] as { content?: unknown }).content).toBe("u2");
      expect((state.agentMessages[2] as { content?: unknown }).content)
        .toEqual([{ type: "text", text: "a2" }]);
      expect((state.agentMessages[3] as { content?: unknown }).content).toBe("u3");
      expect((state.agentMessages[4] as { content?: unknown }).content)
        .toEqual([{ type: "text", text: "a3" }]);
      const note = state.agentMessages.at(-1) as { role?: string; content?: unknown };
      expect(note.role).toBe("user");
      expect(String(note.content)).toContain("[Margin 记录] 上下文已压缩：约 90000 → 20000 tokens");
      expect(String(note.content)).toContain("压缩前记录已存档");
      expect(contents.filter((c) => c.includes("u1"))).toHaveLength(0);

      // C2: the archive holds the compaction-time snapshot, not the grown transcript.
      const archived = listAgentCompactions(workspace, "s-compact");
      expect(archived).toHaveLength(1);
      expect(archived[0]).toMatchObject({
        reason: "threshold",
        tokensBefore: 90_000,
        tokensAfter: 20_000,
        summary: "压缩摘要",
        messageCount: 4,
      });
      expect(latestAgentCompactionSummary(workspace, "s-compact")).toBe("压缩摘要");
      expect(chat.list().map((turn) => turn.role)).toEqual(["system"]);
      expect(chat.list()[0]?.text).toContain("90000 → 20000");
    } finally {
      try { workspace.db.close(); } catch { /* ignore */ }
      await workspace.releaseLock();
    }
  });

  it("is idempotent per eventId: a repeated settle is a no-op", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-compact-dup-"));
    dirs.push(root);
    const workspace = await openWorkspace(root);
    try {
      const state = createChatAgentState({
        sessionId: "s-dup",
        agentMessages: beforeTranscript(),
      });
      const chat = new ChatMemory();
      const event = compactionEvent();

      expect(settleCompactionEvent(workspace, state, chat, event)).toBe(true);
      const afterFirst = state.agentMessages.map((message) =>
        JSON.stringify(message),
      );
      expect(settleCompactionEvent(workspace, state, chat, event)).toBe(false);

      expect(state.agentMessages.map((message) => JSON.stringify(message))).toEqual(afterFirst);
      expect(listAgentCompactions(workspace, "s-dup")).toHaveLength(1);
      expect(chat.list()).toHaveLength(1);
    } finally {
      try { workspace.db.close(); } catch { /* ignore */ }
      await workspace.releaseLock();
    }
  });

  it("detects the overflow path (pi-loop already wrote messagesAfter back)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-compact-overflow-"));
    dirs.push(root);
    const workspace = await openWorkspace(root);
    try {
      const event = compactionEvent({ reason: "overflow" });
      const state = createChatAgentState({
        sessionId: "s-overflow",
        // pi-loop wrote the compacted transcript back; the turn then appended u3.
        agentMessages: [...event.messagesAfter, u("u3", 5)],
      });
      const chat = new ChatMemory();

      const settled = settleCompactionEvent(workspace, state, chat, event);

      expect(settled).toBe(true);
      // No double splice: exactly one summary head, tail intact.
      expect(state.agentMessages.filter((message) =>
        String((message as { content?: unknown }).content).includes("此前对话已压缩为以下摘要"),
      )).toHaveLength(1);
      expect((state.agentMessages[1] as { content?: unknown }).content).toBe("u2");
      expect((state.agentMessages[3] as { content?: unknown }).content).toBe("u3");
      expect(listAgentCompactions(workspace, "s-overflow")).toHaveLength(1);
    } finally {
      try { workspace.db.close(); } catch { /* ignore */ }
      await workspace.releaseLock();
    }
  });

  it("archives but refuses the swap when the prefix check fails (宁缺毋错)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-compact-mismatch-"));
    dirs.push(root);
    const workspace = await openWorkspace(root);
    try {
      const event = compactionEvent();
      const diverged = [u("u1", 1), a("a1", 2), u("u2", 3), a("篡改的a2", 4), u("u3", 5)];
      const state = createChatAgentState({
        sessionId: "s-mismatch",
        agentMessages: diverged,
      });
      const chat = new ChatMemory();

      const settled = settleCompactionEvent(workspace, state, chat, event);

      expect(settled).toBe(true);
      // Transcript untouched: no summary head, no dropped prefix.
      expect(state.agentMessages.filter((message) =>
        String((message as { content?: unknown }).content).includes("此前对话已压缩为以下摘要"),
      )).toHaveLength(0);
      expect((state.agentMessages[3] as { content?: unknown }).content)
        .toEqual([{ type: "text", text: "篡改的a2" }]);
      // Warning note instead of the standard compaction note.
      const note = state.agentMessages.at(-1) as { role?: string; content?: unknown };
      expect(note.role).toBe("user");
      expect(String(note.content)).toContain("警告");
      expect(String(note.content)).toContain("evt-1");
      // Archive still written.
      const archived = listAgentCompactions(workspace, "s-mismatch");
      expect(archived).toHaveLength(1);
      expect(archived[0]?.messageCount).toBe(4);
    } finally {
      try { workspace.db.close(); } catch { /* ignore */ }
      await workspace.releaseLock();
    }
  });
});

describe("compactChatAgentConversation", () => {
  const ENV_KEYS = ["MARGIN_API_KEY", "MARGIN_MODEL", "MARGIN_BASE_URL", "MARGIN_PROVIDER", "MARGIN_API_FORMAT"];
  let savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    savedEnv = {};
  });

  const seedTranscript = (): AgentMessage[] => [
    { role: "user", content: "第一轮问题", timestamp: 1 } as AgentMessage,
    { role: "assistant", content: [{ type: "text", text: "很长的回答".repeat(200) }], timestamp: 2 } as AgentMessage,
    { role: "user", content: "最新一轮", timestamp: 3 } as AgentMessage,
  ];

  it("rejects when the conversation has no content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-manual-empty-"));
    dirs.push(root);
    const workspace = await openWorkspace(root);
    try {
      const state = createChatAgentState({ sessionId: "s-empty" });
      await expect(
        compactChatAgentConversation({ workspace, agentState: state, chat: new ChatMemory() }),
      ).rejects.toThrow(/没有可压缩/);
    } finally {
      try { workspace.db.close(); } catch { /* ignore */ }
      await workspace.releaseLock();
    }
  });

  it("rejects on the eco tier (no LLM summarization)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-manual-eco-"));
    dirs.push(root);
    const workspace = await openWorkspace(root);
    try {
      await saveLlmSettings(root, { contextTier: "eco" });
      const state = createChatAgentState({ sessionId: "s-eco", agentMessages: seedTranscript() });
      await expect(
        compactChatAgentConversation({ workspace, agentState: state, chat: new ChatMemory() }),
      ).rejects.toThrow(/eco|节省/);
    } finally {
      try { workspace.db.close(); } catch { /* ignore */ }
      await workspace.releaseLock();
    }
  });

  it("compacts manually: archive + splice + persist + visible note", async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.MARGIN_API_KEY = "test-key";
    delete process.env.MARGIN_BASE_URL;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-manual-"));
    dirs.push(root);
    const workspace = await openWorkspace(root);
    try {
      const state = createChatAgentState({ sessionId: "s-manual", agentMessages: seedTranscript() });
      const chat = new ChatMemory();

      const result = await compactChatAgentConversation({
        workspace,
        agentState: state,
        chat,
        summarizer: async () => "手动压缩摘要",
      });

      expect(result.summary).toBe("手动压缩摘要");
      expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);
      const head = state.agentMessages[0] as { role?: string; content?: unknown };
      expect(String(head.content)).toBe("此前对话已压缩为以下摘要：\n\n手动压缩摘要");
      expect((state.agentMessages[1] as { content?: unknown }).content).toBe("最新一轮");

      const archived = listAgentCompactions(workspace, "s-manual");
      expect(archived).toHaveLength(1);
      expect(archived[0]?.reason).toBe("manual");
      expect(latestAgentCompactionSummary(workspace, "s-manual")).toBe("手动压缩摘要");
      expect(chat.list().map((turn) => turn.role)).toEqual(["system"]);

      const persisted = loadAgentSession(workspace);
      expect(String((persisted?.messages[0] as { content?: unknown })?.content))
        .toContain("手动压缩摘要");
      expect(persisted?.chatTurns.map((turn) => turn.role)).toContain("system");
    } finally {
      try { workspace.db.close(); } catch { /* ignore */ }
      await workspace.releaseLock();
    }
  });
});
