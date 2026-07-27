import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDocument,
  openWorkspace,
  saveAgentSession,
  type Workspace,
} from "@margin/storage-local";
import {
  buildTranscriptPayload,
  clearChatAgentConversation,
  closeChatAgentDocument,
  createChatAgentState,
  createWorkspaceBridge,
  isCloseDocumentRequest,
  restoreChatAgentState,
  syncBagFromDocument,
} from "./chat-agent.js";

const dirs: string[] = [];

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

describe("workspace bridge extensions", () => {
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

  it("passes the unlimited-read switch through bridge.readText", async () => {
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
      await expect(bridge.readText(target)).rejects.toThrow(/outside workspace/);

      process.env.MARGIN_UNLIMITED = "1";
      await expect(bridge.readText(target)).resolves.toMatchObject({
        relativePath: target,
        text: "external evidence",
      });
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
    expect(state.sourceDocumentId).toBe("document-1");
    expect(state.sessionId).not.toBe("before");
  });

  it("closes all document-scoped state", () => {
    const state = createChatAgentState({
      agentMessages: [{ role: "user", content: "revise" }],
      clarificationRounds: 3,
      sourcePaths: ["notes.txt"],
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
    expect(state.sourceDocumentId).toBeUndefined();
  });

  it("starts a clean agent conversation when switching documents", () => {
    const state = createChatAgentState({
      sessionId: "before",
      agentMessages: [{ role: "user", content: "private context" }],
      clarificationRounds: 2,
      sourcePaths: ["notes.txt"],
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
    expect(state.sessionId).not.toBe("before");
  });

  it("recognizes explicit close commands without matching ordinary discussion", () => {
    expect(isCloseDocumentRequest("退出这个word")).toBe(true);
    expect(isCloseDocumentRequest("关闭当前文稿")).toBe(true);
    expect(isCloseDocumentRequest("请关闭 DOCX")).toBe(true);
    expect(isCloseDocumentRequest("讨论如何关闭文章结尾")).toBe(false);
  });
});
