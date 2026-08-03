import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDocument,
  listBlocks,
  listActiveReviewChecklists,
  listComments,
  listProposals,
  loadAgentSession,
  openDocument,
  openWorkspace,
  replaceDocumentComments,
  saveAgentSession,
  saveProposal,
  saveReviewChecklistRun,
  type Workspace,
} from "@margin/storage-local";

const mocks = vi.hoisted(() => ({
  runSessionTurn: vi.fn(),
}));

vi.mock("@margin/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@margin/agent")>();
  return {
    ...actual,
    runSessionTurn: mocks.runSessionTurn,
  };
});

const { ChatMemory } = await import("./chat-memory.js");
const {
  createChatAgentState,
  restoreChatAgentState,
  runChatAgentTurn,
  syncBagFromDocument,
  taskForPersistence,
} = await import("./chat-agent.js");

const workspaces: Workspace[] = [];
const dirs: string[] = [];

beforeEach(() => {
  mocks.runSessionTurn.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const workspace of workspaces.splice(0)) {
    workspace.db.close();
    await workspace.releaseLock();
  }
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may briefly retain SQLite handles. */
    }
  }
});

describe("chat task continuation", () => {
  it("persists a recoverable loop stop as interrupted and restores its objective and selection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-continuation-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "# Title\n\nSelected paragraph.\n", "utf8");
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const document = openDocument(workspace, "paper.md");
    const blocks = listBlocks(workspace, document.id);
    const selected = blocks.at(-1)!;
    const unrelated = blocks[0]!;
    const state = createChatAgentState({ sessionId: "continuation-session" });
    syncBagFromDocument(state, document, blocks);
    const chat = new ChatMemory();

    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "本轮工具轮次已用尽，请回复「继续」。",
      messages: [{ role: "assistant", content: "partial result" }],
      proposals: [],
      comments: [],
      steps: ["正在通读文稿…"],
      notes: ["stopped after 40 turns"],
      continuationRequired: true,
    });

    const first = await runChatAgentTurn({
      workspace,
      chat,
      agentState: state,
      message: "通读全文并分析结构",
      selectionText: selected.text,
      selectionStart: 7,
      selectionBlockIds: [selected.id],
    });

    expect(first.task).toMatchObject({
      objective: "通读全文并分析结构",
      status: "interrupted",
      documentId: document.id,
      documentRevision: document.revision,
      selection: {
        blockIds: [selected.id],
        text: selected.text,
        start: 7,
      },
    });
    expect(loadAgentSession(workspace)?.task?.status).toBe("interrupted");

    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "结构分析完成。",
      messages: [{ role: "assistant", content: "complete result" }],
      proposals: [],
      comments: [],
      steps: [],
    });

    const resumed = await runChatAgentTurn({
      workspace,
      chat,
      agentState: state,
      message: "继续",
      selectionText: unrelated.text,
      selectionStart: 0,
      selectionBlockIds: [unrelated.id],
    });

    expect(mocks.runSessionTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: "继续此前任务：通读全文并分析结构",
      selectionHint: selected.text,
      selectionBlockIds: [selected.id],
    }));
    expect(resumed.task).toMatchObject({
      objective: "通读全文并分析结构",
      status: "completed",
      documentId: document.id,
      documentRevision: document.revision,
      selection: {
        blockIds: [selected.id],
        text: selected.text,
        start: 7,
      },
    });
  });

  it("does not restore an interrupted task selection after the document revision changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-stale-continuation-"));
    dirs.push(root);
    const paperPath = path.join(root, "paper.md");
    fs.writeFileSync(paperPath, "Original paragraph.\n", "utf8");
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const document = openDocument(workspace, "paper.md");
    const blocks = listBlocks(workspace, document.id);
    const selected = blocks[0]!;
    const state = createChatAgentState({ sessionId: "stale-continuation-session" });
    syncBagFromDocument(state, document, blocks);
    const chat = new ChatMemory();

    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "本轮工具轮次已用尽，请回复「继续」。",
      messages: [{ role: "assistant", content: "old revision cursor" }],
      proposals: [],
      comments: [],
      steps: [],
      continuationRequired: true,
    });
    await runChatAgentTurn({
      workspace,
      chat,
      agentState: state,
      message: "继续分析这段",
      selectionText: selected.text,
      selectionStart: 0,
      selectionBlockIds: [selected.id],
    });

    fs.writeFileSync(paperPath, "Revised paragraph.\n", "utf8");
    const revisedDocument = openDocument(workspace, "paper.md");
    syncBagFromDocument(state, revisedDocument, listBlocks(workspace, revisedDocument.id));
    expect(revisedDocument.revision).toBeGreaterThan(document.revision);
    expect(state.task).toBeUndefined();
    expect(taskForPersistence(state)?.objective).toBe("继续分析这段");

    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "Handled the current revision.",
      messages: [],
      proposals: [],
      comments: [],
      steps: [],
    });
    const resumed = await runChatAgentTurn({
      workspace,
      chat,
      agentState: state,
      message: "继续分析",
      threadId: "stale-thread",
    });

    expect(mocks.runSessionTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: expect.stringContaining("请从当前版本重新执行此前任务"),
      messages: [],
      history: [],
      selectionHint: undefined,
      selectionBlockIds: undefined,
    }));
    expect(resumed.task).toMatchObject({
      objective: "继续分析这段",
      status: "completed",
      documentId: document.id,
      documentRevision: revisedDocument.revision,
    });
    expect(resumed.task?.selection).toBeUndefined();
    expect(resumed.conversationReset).toBe(true);
    expect(chat.list()).toEqual([{
      role: "user",
      text: "继续分析",
    }, {
      role: "assistant",
      text: "Handled the current revision.",
    }]);
  });

  it("keeps a failed revision reset pending until a successful UI response", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-reset-pending-"));
    dirs.push(root);
    const paperPath = path.join(root, "paper.md");
    fs.writeFileSync(paperPath, "Original paragraph.\n", "utf8");
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const document = openDocument(workspace, "paper.md");
    const blocks = listBlocks(workspace, document.id);
    const state = createChatAgentState({ sessionId: "reset-pending-session" });
    syncBagFromDocument(state, document, blocks);
    state.task = {
      objective: "审阅全文论证",
      status: "interrupted",
      documentId: document.id,
      documentRevision: document.revision,
      sourcePaths: [],
      sourceRefs: [],
      proposalCount: 0,
      inspectedDocument: true,
      consistencyChecked: false,
      selection: { blockIds: [blocks[0]!.id], text: blocks[0]!.text, start: 0 },
      updatedAt: "2026-08-03T00:00:00.000Z",
    };
    const chat = new ChatMemory();
    chat.remember("user", "old revision request", "old-thread");
    chat.remember("assistant", "old revision reply", "old-thread");

    fs.writeFileSync(paperPath, "Revised paragraph.\n", "utf8");
    const revised = openDocument(workspace, "paper.md");
    syncBagFromDocument(state, revised, listBlocks(workspace, revised.id));
    mocks.runSessionTurn.mockRejectedValueOnce(new Error("provider temporarily unavailable"));

    await expect(runChatAgentTurn({
      workspace,
      chat,
      agentState: state,
      message: "继续",
    })).rejects.toThrow("provider temporarily unavailable");

    expect(state.conversationResetPending).toBe(true);
    expect(chat.list()).toEqual([]);
    expect(state.task).toMatchObject({
      objective: "审阅全文论证",
      status: "interrupted",
      documentRevision: revised.revision,
    });

    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "Current revision reviewed.",
      messages: [],
      proposals: [],
      comments: [],
      steps: [],
    });
    const recovered = await runChatAgentTurn({
      workspace,
      chat,
      agentState: state,
      message: "continue.",
    });

    expect(recovered.conversationReset).toBe(true);
    expect(state.conversationResetPending).toBe(false);
    expect(chat.list()).toEqual([
      { role: "user", text: "continue." },
      { role: "assistant", text: "Current revision reviewed." },
    ]);
  });

  it("never resumes a documentless task carrying malformed legacy selection data", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-legacy-selection-"));
    dirs.push(root);
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const state = createChatAgentState({
      sessionId: "legacy-selection-session",
      task: {
        objective: "old selection task",
        status: "interrupted",
        sourcePaths: [],
        sourceRefs: [],
        proposalCount: 0,
        inspectedDocument: false,
        consistencyChecked: false,
        selection: { blockIds: [], text: "stale private selection", start: 0 },
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    });
    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "Please restate the task.",
      messages: [],
      proposals: [],
      comments: [],
      steps: [],
    });

    const result = await runChatAgentTurn({
      workspace,
      chat: new ChatMemory(),
      agentState: state,
      message: "请继续.",
    });

    expect(mocks.runSessionTurn).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("无法安全绑定到当前文稿"),
      selectionHint: undefined,
      selectionBlockIds: undefined,
    }));
    expect(result.conversationReset).toBe(true);
  });

  it("treats a longer continue-prefixed sentence as a new request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-new-continue-request-"));
    dirs.push(root);
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const state = createChatAgentState({ sessionId: "new-continue-request" });
    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "New question handled.",
      messages: [],
      proposals: [],
      comments: [],
      steps: [],
    });

    await runChatAgentTurn({
      workspace,
      chat: new ChatMemory(),
      agentState: state,
      message: "继续分析这个新问题",
    });

    expect(mocks.runSessionTurn).toHaveBeenCalledWith(expect.objectContaining({
      message: "继续分析这个新问题",
    }));
  });

  it("isolates a stale restored task and restarts its objective on the current revision", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-restored-stale-"));
    dirs.push(root);
    const paperPath = path.join(root, "paper.md");
    fs.writeFileSync(paperPath, "Original paragraph.\n", "utf8");
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const document = openDocument(workspace, "paper.md");
    const blocks = listBlocks(workspace, document.id);
    const selected = blocks[0]!;
    const state = createChatAgentState({ sessionId: "restored-stale-session" });
    syncBagFromDocument(state, document, blocks);

    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "本轮工具轮次已用尽，请回复「继续」。",
      messages: [{ role: "assistant", content: "old persisted cursor" }],
      proposals: [],
      comments: [],
      steps: [],
      continuationRequired: true,
    });
    await runChatAgentTurn({
      workspace,
      chat: new ChatMemory(),
      agentState: state,
      message: "审阅全文并检查论证",
      selectionText: selected.text,
      selectionStart: 3,
      selectionBlockIds: [selected.id],
    });

    fs.writeFileSync(paperPath, "Revised paragraph.\n", "utf8");
    const revisedDocument = openDocument(workspace, "paper.md");
    expect(revisedDocument.revision).toBeGreaterThan(document.revision);

    const restored = restoreChatAgentState(workspace);
    expect(restored.bag.revision).toBe(revisedDocument.revision);
    expect(restored.task).toBeUndefined();
    expect(restored.agentMessages).toEqual([]);
    expect(taskForPersistence(restored)).toMatchObject({
      objective: "审阅全文并检查论证",
      documentId: document.id,
      documentRevision: document.revision,
    });

    const restoredChat = new ChatMemory();
    restoredChat.remember("user", "old persisted request", "old-thread");
    restoredChat.remember("assistant", "old persisted reply", "old-thread");
    saveAgentSession(workspace, {
      sessionId: restored.sessionId,
      documentId: restored.bag.documentId,
      messages: restored.agentMessages,
      clarificationRounds: restored.clarificationRounds,
      chatTurns: restoredChat.list(),
      sourcePaths: restored.sourcePaths,
      evidenceCache: restored.evidenceCache,
      task: taskForPersistence(restored),
    });
    const reloaded = restoreChatAgentState(workspace);
    expect(reloaded.task).toBeUndefined();
    expect(taskForPersistence(reloaded)?.objective).toBe("审阅全文并检查论证");

    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "Reviewed the current revision.",
      messages: [],
      proposals: [],
      comments: [],
      steps: [],
    });

    const resumed = await runChatAgentTurn({
      workspace,
      chat: restoredChat,
      agentState: reloaded,
      message: "接着做吧",
      threadId: "old-thread",
    });

    expect(mocks.runSessionTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: expect.stringContaining("请从当前版本重新执行此前任务"),
      messages: [],
      history: [],
      selectionHint: undefined,
      selectionBlockIds: undefined,
      bag: expect.objectContaining({
        documentId: document.id,
        revision: revisedDocument.revision,
      }),
    }));
    expect(resumed.task).toMatchObject({
      objective: "审阅全文并检查论证",
      status: "completed",
      documentId: document.id,
      documentRevision: revisedDocument.revision,
    });
    expect(resumed.task?.selection).toBeUndefined();
    expect(resumed.conversationReset).toBe(true);
    expect(restoredChat.list()).toEqual([{
      role: "user",
      text: "接着做吧",
    }, {
      role: "assistant",
      text: "Reviewed the current revision.",
    }]);
  });

  it("keeps the shared active document unchanged when a turn fails after opening another document", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-open-failure-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "a.md"), "Document A.\n", "utf8");
    fs.writeFileSync(path.join(root, "b.md"), "Document B.\n", "utf8");
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const documentA = openDocument(workspace, "a.md");
    const documentB = openDocument(workspace, "b.md");
    const blocksA = listBlocks(workspace, documentA.id);
    const blocksB = listBlocks(workspace, documentB.id);
    const retainedEvidence = {
      sourceRef: "notes.txt#sha256=0123456789abcdef&chars=0-4",
      relativePath: "notes.txt",
      start: 0,
      end: 4,
      extractedHash: "0123456789abcdef",
      versionHash: "a".repeat(64),
      preview: "note",
      readAt: "2026-08-03T00:00:00.000Z",
    };
    const state = createChatAgentState({
      sessionId: "open-failure-session",
      sourcePaths: ["notes.txt"],
      evidenceCache: [retainedEvidence],
    });
    syncBagFromDocument(state, documentA, blocksA);

    mocks.runSessionTurn.mockImplementationOnce(async (input) => {
      input.bag.documentId = documentB.id;
      input.bag.revision = documentB.revision;
      input.bag.relativePath = documentB.relativePath;
      input.bag.blocks = blocksB;
      input.onEvidenceCacheChange?.([]);
      throw new Error("provider failed after open_document");
    });

    await expect(runChatAgentTurn({
      workspace,
      chat: new ChatMemory(),
      agentState: state,
      message: "打开 b.md 并检查",
    })).rejects.toThrow("provider failed after open_document");

    expect(state.bag).toMatchObject({
      documentId: documentA.id,
      relativePath: "a.md",
    });
    expect(state.sourceDocumentId).toBe(documentA.id);
    expect(state.evidenceCache).toEqual([retainedEvidence]);
    expect(loadAgentSession(workspace)).toMatchObject({
      documentId: documentA.id,
      task: { status: "interrupted" },
    });
  });

  it("resynchronizes the active bag when a failed turn reindexes the same document", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-reindex-failure-"));
    dirs.push(root);
    const paperPath = path.join(root, "paper.md");
    fs.writeFileSync(paperPath, "Original revision.\n", "utf8");
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const document = openDocument(workspace, "paper.md");
    const state = createChatAgentState({ sessionId: "reindex-failure-session" });
    syncBagFromDocument(state, document, listBlocks(workspace, document.id));

    mocks.runSessionTurn.mockImplementationOnce(async (input) => {
      fs.writeFileSync(paperPath, "Externally revised.\n", "utf8");
      const revised = openDocument(workspace, "paper.md");
      input.bag.documentId = revised.id;
      input.bag.revision = revised.revision;
      input.bag.relativePath = revised.relativePath;
      input.bag.blocks = listBlocks(workspace, revised.id);
      throw new Error("provider failed after same-document reindex");
    });

    await expect(runChatAgentTurn({
      workspace,
      chat: new ChatMemory(),
      agentState: state,
      message: "重新打开并审阅当前文稿",
    })).rejects.toThrow("provider failed after same-document reindex");

    const revised = getDocument(workspace, document.id);
    expect(revised.revision).toBe(document.revision + 1);
    expect(state.bag).toMatchObject({
      documentId: document.id,
      revision: revised.revision,
    });
    expect(state.task).toBeUndefined();
    expect(state.conversationResetPending).toBe(true);
    expect(taskForPersistence(state)).toMatchObject({
      objective: "重新打开并审阅当前文稿",
      status: "interrupted",
      documentRevision: document.revision,
    });
  });

  it("clears cross-document context and old selection when a turn returns to its starting document", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-return-switch-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "a.md"), "Document A.\n", "utf8");
    fs.writeFileSync(path.join(root, "notes.txt"), "old evidence", "utf8");
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const documentA = openDocument(workspace, "a.md");
    const blocksA = listBlocks(workspace, documentA.id);
    const selected = blocksA[0]!;
    const retainedEvidence = {
      sourceRef: "notes.txt#sha256=0123456789abcdef&chars=0-4",
      relativePath: "notes.txt",
      start: 0,
      end: 4,
      extractedHash: "0123456789abcdef",
      versionHash: "a".repeat(64),
      preview: "note",
      readAt: "2026-08-03T00:00:00.000Z",
    };
    const state = createChatAgentState({
      sessionId: "return-switch-session",
      agentMessages: [{ role: "user", content: "old document context" }],
      sourcePaths: ["notes.txt"],
      evidenceCache: [retainedEvidence],
      sourceDocumentId: documentA.id,
    });
    syncBagFromDocument(state, documentA, blocksA);
    const chat = new ChatMemory();
    chat.remember("user", "old chat context");

    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "Stopped after returning to A.",
      messages: [{ role: "assistant", content: "cross-document tool transcript" }],
      proposals: [],
      comments: [],
      steps: [],
      opened: { document: documentA, blocks: blocksA },
      documentSwitchOccurred: true,
      continuationRequired: true,
    });

    const result = await runChatAgentTurn({
      workspace,
      chat,
      agentState: state,
      message: "compare documents",
      threadId: "old-document-thread",
      selectionText: selected.text,
      selectionStart: 0,
      selectionBlockIds: [selected.id],
    });

    expect(state.bag.documentId).toBe(documentA.id);
    expect(state.agentMessages).toEqual([]);
    expect(state.sourcePaths).toEqual([]);
    expect(state.evidenceCache).toEqual([]);
    expect(state.sessionId).not.toBe("return-switch-session");
    expect(result.task).toMatchObject({ status: "completed" });
    expect(result.conversationReset).toBe(true);
    expect(result.task?.selection).toBeUndefined();
    expect(chat.list()).toEqual([
      { role: "user", text: "compare documents" },
      { role: "assistant", text: "Stopped after returning to A." },
    ]);
  });

  it("rolls back every chat artifact when a later checklist insert fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-artifact-atomic-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "Original paragraph.\n", "utf8");
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const document = openDocument(workspace, "paper.md");
    const blocks = listBlocks(workspace, document.id);
    const block = blocks[0]!;
    const state = createChatAgentState({ sessionId: "artifact-atomic-session" });
    syncBagFromDocument(state, document, blocks);
    saveProposal(workspace, {
      schemaVersion: 1,
      id: "proposal-before-chat",
      documentId: document.id,
      blockId: block.id,
      baseRevision: document.revision,
      baseHash: block.contentHash,
      before: block.text,
      after: "Existing proposal",
      rationale: "must survive rollback",
      risk: "language",
      evidence: [],
      status: "proposed",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    replaceDocumentComments(workspace, document.id, [{
      id: "comment-before-chat",
      blockId: block.id,
      text: "existing comment",
      severity: "info",
      runId: "before-chat",
      source: "test",
    }]);
    const checklist = (id: string, checker: "cite_check" | "style_lint") => ({
      run: {
        schemaVersion: 1 as const,
        id,
        documentId: document.id,
        checker,
        disclaimer: "test boundary",
        status: "active" as const,
        createdAt: "2026-08-03T00:00:00.000Z",
      },
      items: [],
    });
    saveReviewChecklistRun(workspace, checklist("check-before-chat", "cite_check"));

    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "Generated review artifacts.",
      messages: [],
      proposals: [{
        schemaVersion: 1,
        documentId: document.id,
        blockId: block.id,
        baseRevision: document.revision,
        baseHash: block.contentHash,
        before: block.text,
        after: "New proposal",
        rationale: "new artifact",
        risk: "language",
        evidence: [],
      }],
      comments: [{
        id: "comment-from-chat",
        documentId: document.id,
        blockId: block.id,
        text: "new comment",
        severity: "warn",
        source: "agent",
        ephemeral: true,
      }],
      reviewChecklists: [
        checklist("check-from-chat-1", "cite_check"),
        checklist("check-from-chat-2", "style_lint"),
      ],
      steps: [],
    });
    const prepare = workspace.db.prepare.bind(workspace.db);
    let checklistInsertCount = 0;
    vi.spyOn(workspace.db, "prepare").mockImplementation((sql: string) => {
      if (/INSERT INTO review_checklist_runs/.test(sql) && ++checklistInsertCount === 2) {
        throw new Error("injected chat checklist failure");
      }
      return prepare(sql);
    });

    await expect(runChatAgentTurn({
      workspace,
      chat: new ChatMemory(),
      agentState: state,
      message: "review this paragraph",
    })).rejects.toThrow("injected chat checklist failure");

    expect(listProposals(workspace, document.id)).toMatchObject([{
      id: "proposal-before-chat",
      status: "proposed",
    }]);
    expect(listComments(workspace, document.id)).toMatchObject([{
      id: "comment-before-chat",
      text: "existing comment",
    }]);
    expect(listActiveReviewChecklists(workspace, document.id)).toMatchObject([{
      run: { id: "check-before-chat", status: "active" },
    }]);
    expect(loadAgentSession(workspace)?.task?.status).toBe("interrupted");
  });

  it("does not persist old-document artifacts after a successful document switch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-artifact-switch-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "a.md"), "Shared paragraph.\n", "utf8");
    fs.writeFileSync(path.join(root, "b.md"), "Shared paragraph.\n", "utf8");
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const documentA = openDocument(workspace, "a.md");
    const documentB = openDocument(workspace, "b.md");
    const blocksA = listBlocks(workspace, documentA.id);
    const blocksB = listBlocks(workspace, documentB.id);
    const targetB = blocksB[0]!;
    const state = createChatAgentState({ sessionId: "artifact-switch-session" });
    syncBagFromDocument(state, documentA, blocksA);

    mocks.runSessionTurn.mockResolvedValueOnce({
      engine: "pi",
      reply: "Opened B.",
      messages: [],
      proposals: [{
        schemaVersion: 1,
        documentId: documentA.id,
        blockId: targetB.id,
        baseRevision: documentB.revision,
        baseHash: targetB.contentHash,
        before: targetB.text,
        after: "Stale proposal",
        rationale: "belongs to A",
        risk: "language",
        evidence: [],
      }],
      tableCellProposals: [{
        schemaVersion: 1,
        documentId: documentA.id,
        blockId: targetB.id,
        baseRevision: documentB.revision,
        baseHash: targetB.contentHash,
        applyMode: "host_table_cell_patch",
        cell: { address: "A1", row: 1, column: 1, before: "old", after: "new" },
        rationale: "belongs to A",
        risk: "language",
        evidence: [],
      }],
      comments: [{
        id: "comment-a",
        documentId: documentA.id,
        blockId: targetB.id,
        text: "belongs to A",
        severity: "warn",
        source: "agent",
        ephemeral: true,
      }],
      reviewChecklists: [{
        run: {
          schemaVersion: 1,
          id: "check-a",
          documentId: documentA.id,
          checker: "style_lint",
          disclaimer: "old document",
          status: "active",
          createdAt: "2026-08-03T00:00:00.000Z",
        },
        items: [],
      }],
      steps: [],
      opened: { document: documentB, blocks: blocksB },
    });

    const result = await runChatAgentTurn({
      workspace,
      chat: new ChatMemory(),
      agentState: state,
      message: "打开 b.md",
    });

    expect(result.proposalCount).toBe(0);
    expect(state.bag.documentId).toBe(documentB.id);
    expect(listProposals(workspace, documentB.id)).toEqual([]);
    expect(listComments(workspace, documentB.id)).toEqual([]);
    expect(listActiveReviewChecklists(workspace, documentB.id)).toEqual([]);
  });
});
