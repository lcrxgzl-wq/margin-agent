import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveAgentSession,
  clearAgentSession,
  deleteAgentSession,
  ensureAgentSessionSchema,
  listAgentSessions,
  loadAgentSession,
  loadAgentSessionEnvelope,
  openWorkspace,
  saveAgentSession,
} from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("agent session persistence", () => {
  it("saves and restores messages across reopen", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "a.md"), "# hi\n", "utf8");
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "sess-1",
        documentId: "doc-1",
        messages: [
          { role: "user", content: "打开样章" },
          { role: "assistant", content: "好" },
        ],
        clarificationRounds: 2,
        chatTurns: [
          { role: "user", text: "打开样章" },
          { role: "assistant", text: "好" },
        ],
        sourcePaths: ["notes/interview.txt", "data/cases.csv", "sources/paper.pdf"],
        task: {
          objective: "依据访谈材料修订本节",
          status: "completed",
          sourcePaths: ["notes/interview.txt"],
          sourceRefs: ["notes/interview.txt#chars=0-120"],
          proposalCount: 2,
          inspectedDocument: true,
          consistencyChecked: true,
          selection: { blockIds: ["b1"], text: "选中的句子", start: 17 },
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
      });
      const loaded = loadAgentSession(ws);
      expect(loaded?.sessionId).toBe("sess-1");
      expect(loaded?.documentId).toBe("doc-1");
      expect(loaded?.messages).toHaveLength(2);
      expect(loaded?.clarificationRounds).toBe(2);
      expect(loaded?.chatTurns).toEqual([
        { role: "user", text: "打开样章" },
        { role: "assistant", text: "好" },
      ]);
      expect(loaded?.sourcePaths).toEqual([
        "notes/interview.txt",
        "data/cases.csv",
        "sources/paper.pdf",
      ]);
      expect(loaded?.task).toMatchObject({
        objective: "依据访谈材料修订本节",
        status: "completed",
        sourceRefs: ["notes/interview.txt#chars=0-120"],
        proposalCount: 2,
        inspectedDocument: true,
        consistencyChecked: true,
        selection: { blockIds: ["b1"], text: "选中的句子", start: 17 },
      });
      clearAgentSession(ws);
      expect(loadAgentSession(ws)).toBeNull();
    } finally {
      try {
        ws.db.close();
      } catch {
        /* ignore */
      }
      await ws.releaseLock();
    }
  });

  it("loads legacy array payload as empty chat meta", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-legacy-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "a.md"), "# hi\n", "utf8");
    const ws = await openWorkspace(root);
    try {
      ensureAgentSessionSchema(ws);
      ws.db
        .prepare(
          `INSERT INTO agent_sessions (id, session_id, messages_json, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          "current",
          "legacy",
          JSON.stringify([{ role: "user", content: "hi" }]),
          new Date().toISOString(),
        );
      const loaded = loadAgentSession(ws);
      expect(loaded?.sessionId).toBe("legacy");
      expect(loaded?.documentId).toBeUndefined();
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.clarificationRounds).toBe(0);
      expect(loaded?.chatTurns).toEqual([]);
      expect(loaded?.threads).toEqual([]);
      expect(loaded?.sourcePaths).toEqual([]);
    } finally {
      try {
        ws.db.close();
      } catch {
        /* ignore */
      }
      await ws.releaseLock();
    }
  });

  it("restores a running task as interrupted after process restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-task-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "running-task",
        messages: [],
        task: {
          objective: "核对三份资料并修订",
          status: "running",
          currentStep: "正在读取文件…",
          sourcePaths: ["notes.txt"],
          sourceRefs: [],
          proposalCount: 0,
          inspectedDocument: false,
          consistencyChecked: false,
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
      });

      expect(loadAgentSession(ws)?.task).toMatchObject({
        objective: "核对三份资料并修订",
        status: "interrupted",
        currentStep: "正在读取文件…",
      });
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("trims persisted messages at a complete user-turn boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-trim-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      const messages = Array.from({ length: 100 }, (_, index) => [
        { role: "user", content: `user-${index}` },
        { role: "assistant", content: `assistant-${index}` },
        { role: "toolResult", content: `tool-${index}` },
      ]).flat();
      saveAgentSession(ws, { sessionId: "trimmed", messages });
      const loaded = loadAgentSession(ws);
      expect(loaded?.messages).toHaveLength(180);
      expect((loaded?.messages[0] as { role?: string })?.role).toBe("user");
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("persists the latest eighty visible chat turns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-chat-trim-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "long-chat",
        messages: [],
        chatTurns: Array.from({ length: 100 }, (_, index) => ({
          role: index % 2 === 0 ? "user" as const : "assistant" as const,
          text: `turn-${index}`,
        })),
      });
      const loaded = loadAgentSession(ws);
      expect(loaded?.chatTurns).toHaveLength(80);
      expect(loaded?.chatTurns[0]?.text).toBe("turn-20");
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("drops an oversized protocol turn and caps chat text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-bytes-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "bounded",
        messages: [
          { role: "user", content: "x".repeat(2_200_000) },
          { role: "assistant", content: "done" },
        ],
        chatTurns: [{ role: "user", text: "y".repeat(20_000) }],
      });
      const row = ws.db
        .prepare("SELECT messages_json FROM agent_sessions WHERE id = 'current'")
        .get() as { messages_json: string };
      const loaded = loadAgentSession(ws);
      expect(Buffer.byteLength(row.messages_json, "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(loaded?.messages).toEqual([]);
      expect(loaded?.chatTurns[0]?.text).toHaveLength(8_000);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("restores an 800k transcript together with bounded writing metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-large-context-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "large-context",
        documentId: "doc-1",
        messages: [
          { role: "user", content: "m".repeat(790_000) },
          { role: "assistant", content: "done" },
        ],
        chatTurns: Array.from({ length: 80 }, (_, index) => ({
          role: index % 2 === 0 ? "user" as const : "assistant" as const,
          text: `visible-${index}`,
        })),
        threads: [{
          id: "thread-large",
          documentId: "doc-1",
          anchor: {
            blockId: "block-1",
            selectionText: "s".repeat(100_000),
          },
          collapsed: false,
          createdAt: "2026-07-30T00:00:00.000Z",
        }],
        task: {
          objective: "继续长文修订",
          status: "completed",
          sourcePaths: [],
          sourceRefs: [],
          proposalCount: 0,
          inspectedDocument: true,
          consistencyChecked: false,
          selection: {
            blockIds: ["block-1"],
            text: "t".repeat(100_000),
          },
          updatedAt: "2026-07-30T00:00:00.000Z",
        },
      });

      const row = ws.db
        .prepare("SELECT messages_json FROM agent_sessions WHERE id = 'current'")
        .get() as { messages_json: string };
      const loaded = loadAgentSession(ws);
      expect(Buffer.byteLength(row.messages_json, "utf8")).toBeGreaterThan(800_000);
      expect(Buffer.byteLength(row.messages_json, "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(loaded?.messages).toHaveLength(2);
      expect((loaded?.messages[0] as { content?: string }).content).toHaveLength(790_000);
      expect(loaded?.chatTurns).toHaveLength(80);
      expect(loaded?.threads[0]?.anchor.selectionText).toHaveLength(100_000);
      expect(loaded?.task?.selection?.text).toHaveLength(100_000);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("persists bounded review threads and thread chat metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-threads-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "threaded",
        documentId: "doc-1",
        messages: [],
        chatTurns: [
          { role: "user", text: "Why change this?", threadId: "thread-1" },
          { role: "assistant", text: "For clarity.", threadId: "thread-1" },
        ],
        threads: [{
          id: "thread-1",
          documentId: "doc-1",
          anchor: {
            blockId: "block-1",
            blockIds: ["block-1", "block-2"],
            selectionText: "x".repeat(110_000),
            selectionStart: 12,
            crossTableCells: true,
            tableCell: {
              row: 1,
              column: 2,
              address: "C2",
              before: "y".repeat(110_000),
            },
          },
          collapsed: false,
          createdAt: "2026-07-23T00:00:00.000Z",
        }, {
          id: "invalid-thread",
          documentId: "doc-1",
          anchor: { blockId: "", selectionText: "invalid" },
          collapsed: true,
          createdAt: "not-a-date",
        }],
      });

      const loaded = loadAgentSession(ws);
      expect(loaded?.chatTurns).toEqual([
        { role: "user", text: "Why change this?", threadId: "thread-1" },
        { role: "assistant", text: "For clarity.", threadId: "thread-1" },
      ]);
      expect(loaded?.threads).toHaveLength(1);
      expect(loaded?.threads[0]).toMatchObject({
        id: "thread-1",
        documentId: "doc-1",
        anchor: {
          blockId: "block-1",
          blockIds: ["block-1", "block-2"],
          selectionStart: 12,
          crossTableCells: true,
        },
        collapsed: false,
      });
      expect(loaded?.threads[0]?.anchor.selectionText).toHaveLength(100_000);
      expect(loaded?.threads[0]?.anchor.tableCell?.before).toHaveLength(100_000);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("preserves up to 24 block ids in a cross-block thread anchor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-thread-blocks-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      const blockIds = Array.from({ length: 30 }, (_, index) => `block-${index + 1}`);
      saveAgentSession(ws, {
        sessionId: "thread-blocks",
        documentId: "doc-1",
        messages: [],
        task: {
          objective: "继续处理跨段选区",
          status: "completed",
          sourcePaths: [],
          sourceRefs: [],
          proposalCount: 0,
          inspectedDocument: true,
          consistencyChecked: false,
          selection: {
            blockIds,
            text: "选".repeat(110_000),
            start: 4,
          },
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
        threads: [{
          id: "thread-1",
          documentId: "doc-1",
          anchor: {
            blockId: blockIds[0]!,
            blockIds: blockIds.slice(0, 24),
            selectionRanges: blockIds.slice(0, 24).map((blockId, index) => ({
              blockId,
              start: index === 0 ? 4 : 0,
              end: index === 0 ? 5 : 1,
              before: "选",
            })),
            selectionText: "选".repeat(24),
          },
          collapsed: true,
          createdAt: "2026-07-23T00:00:00.000Z",
        }, {
          id: "invalid-range",
          documentId: "doc-1",
          anchor: {
            blockId: "block-bad",
            selectionText: "选",
            selectionRanges: [{
              blockId: "block-bad",
              start: 0,
              end: 2,
              before: "选",
            }],
          },
          collapsed: true,
          createdAt: "2026-07-23T00:00:00.000Z",
        }],
      });

      const loaded = loadAgentSession(ws);
      expect(loaded?.threads).toHaveLength(1);
      expect(loaded?.threads[0]?.anchor.blockIds).toEqual(blockIds.slice(0, 24));
      expect(loaded?.threads[0]?.anchor.selectionRanges).toEqual(
        blockIds.slice(0, 24).map((blockId, index) => ({
          blockId,
          start: index === 0 ? 4 : 0,
          end: index === 0 ? 5 : 1,
          before: "选",
        })),
      );
      expect(loaded?.task?.selection?.blockIds).toEqual(blockIds.slice(0, 24));
      expect(loaded?.task?.selection?.text).toHaveLength(100_000);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("preserves review threads when a later agent save omits them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-thread-merge-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "before",
        documentId: "doc-1",
        messages: [],
        threads: [{
          id: "thread-1",
          documentId: "doc-1",
          anchor: { blockId: "block-1", selectionText: "anchor" },
          collapsed: true,
          createdAt: "2026-07-23T00:00:00.000Z",
        }],
      });

      saveAgentSession(ws, {
        sessionId: "after",
        documentId: "doc-1",
        messages: [{ role: "user", content: "continue" }],
        chatTurns: [{ role: "user", text: "continue", threadId: "thread-1" }],
      });

      expect(loadAgentSession(ws)?.threads).toMatchObject([{ id: "thread-1" }]);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });
});

describe("agent session history", () => {
  it("archives, lists, restores and deletes sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-hist-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "s-1",
        documentId: "doc-1",
        messages: [{ role: "user", content: "帮我修订导论" }],
        chatTurns: [
          { role: "user", text: "帮我修订导论" },
          { role: "assistant", text: "好的" },
        ],
      });
      // Archiving a different sessionId is a no-op.
      expect(archiveAgentSession(ws, "other")).toBe(false);
      expect(archiveAgentSession(ws, "s-1")).toBe(true);

      const list = listAgentSessions(ws);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        sessionId: "s-1",
        title: "帮我修订导论",
        documentId: "doc-1",
        turnCount: 2,
      });

      const envelope = loadAgentSessionEnvelope(ws, "s-1");
      expect(envelope?.sessionId).toBe("s-1");
      expect(envelope?.documentId).toBe("doc-1");
      expect(envelope?.messages).toHaveLength(1);
      expect(envelope?.chatTurns).toHaveLength(2);
      expect(loadAgentSessionEnvelope(ws, "missing")).toBeNull();

      deleteAgentSession(ws, "s-1");
      expect(listAgentSessions(ws)).toHaveLength(0);
      expect(loadAgentSessionEnvelope(ws, "s-1")).toBeNull();
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("re-archiving upserts the latest content instead of duplicating", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-hist-upsert-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "s-1",
        messages: [{ role: "user", content: "first" }],
        chatTurns: [{ role: "user", text: "first" }],
      });
      archiveAgentSession(ws, "s-1");

      saveAgentSession(ws, {
        sessionId: "s-1",
        messages: [{ role: "user", content: "first" }, { role: "assistant", content: "second" }],
        chatTurns: [{ role: "user", text: "first" }, { role: "assistant", text: "second" }],
      });
      archiveAgentSession(ws, "s-1");

      const list = listAgentSessions(ws);
      expect(list).toHaveLength(1);
      expect(list[0]?.turnCount).toBe(2);
      expect(loadAgentSessionEnvelope(ws, "s-1")?.messages).toHaveLength(2);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("falls back to 新会话 when no user turn exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-hist-title-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "s-no-user",
        messages: [],
        chatTurns: [{ role: "assistant", text: "只有助手回复" }],
      });
      archiveAgentSession(ws, "s-no-user");
      expect(listAgentSessions(ws)[0]).toMatchObject({ title: "新会话", turnCount: 1 });
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("prunes history to the latest 50 sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-hist-prune-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      for (let index = 0; index < 55; index += 1) {
        const sessionId = `s-${index}`;
        saveAgentSession(ws, {
          sessionId,
          messages: [{ role: "user", content: `topic ${index}` }],
          chatTurns: [{ role: "user", text: `topic ${index}` }],
        });
        archiveAgentSession(ws, sessionId);
        // Deterministic ordering: updated_at otherwise ties at ms resolution.
        ws.db
          .prepare(`UPDATE agent_session_history SET updated_at = ? WHERE id = ?`)
          .run(`2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`, sessionId);
      }
      const list = listAgentSessions(ws);
      expect(list).toHaveLength(50);
      expect(list[0]?.sessionId).toBe("s-54");
      expect(list.some((entry) => entry.sessionId === "s-4")).toBe(false);
      expect(list.some((entry) => entry.sessionId === "s-5")).toBe(true);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("clearing the active session does not touch history", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-hist-clear-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    try {
      saveAgentSession(ws, {
        sessionId: "s-1",
        messages: [{ role: "user", content: "hi" }],
        chatTurns: [{ role: "user", text: "hi" }],
      });
      archiveAgentSession(ws, "s-1");
      clearAgentSession(ws);
      expect(loadAgentSession(ws)).toBeNull();
      expect(listAgentSessions(ws)).toHaveLength(1);
      expect(loadAgentSessionEnvelope(ws, "s-1")?.chatTurns).toHaveLength(1);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });
});

describe("chat turn system role", () => {
  it("persists system chat turns through save/load", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sess-system-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "a.md"), "# hi\n", "utf8");
    const ws = await openWorkspace(root);
    saveAgentSession(ws, {
      sessionId: "sess-sys",
      messages: [],
      chatTurns: [
        { role: "user", text: "问题" },
        { role: "system", text: "上下文已压缩：约 90000 → 20000 tokens（压缩前记录已存档）" },
        { role: "assistant", text: "回答" },
      ],
      sourcePaths: [],
    });
    const loaded = loadAgentSession(ws);
    expect(loaded?.chatTurns.map((turn) => turn.role)).toEqual(["user", "system", "assistant"]);
  });
});
