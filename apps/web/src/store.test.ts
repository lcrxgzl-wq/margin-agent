import { describe, expect, it } from "vitest";
import type { Proposal } from "./api";
import { initialMarginState, marginReducer } from "./store";

const documentA = { id: "a", relativePath: "a.docx", revision: 1, contentHash: "ha" };
const documentB = { id: "b", relativePath: "b.docx", revision: 1, contentHash: "hb" };
const proposal = {
  id: "p1",
  documentId: "a",
  blockId: "b1",
  baseRevision: 1,
  baseHash: "h1",
  before: "before",
  after: "after",
  rationale: "test",
  risk: "language",
  status: "proposed",
} satisfies Proposal;

describe("marginReducer document isolation", () => {
  it("clears document-scoped state when another document opens", () => {
    const state = {
      ...initialMarginState,
      doc: documentA,
      proposals: [proposal],
      selection: { blockId: "b1", text: "before", selectionStart: 0, anchor: { x: 1, y: 1 } },
      reviewError: "old error",
    };
    const next = marginReducer(state, { type: "setDocBundle", doc: documentB, blocks: [] });

    expect(next.proposals).toEqual([]);
    expect(next.selection.blockId).toBeNull();
    expect(next.reviewError).toBeNull();
  });

  it("invalidates a selection when the current revision changes", () => {
    const state = {
      ...initialMarginState,
      doc: documentA,
      selection: { blockId: "b1", text: "before", selectionStart: 0, anchor: { x: 1, y: 1 } },
    };
    const next = marginReducer(state, {
      type: "setDocBundle",
      doc: { ...documentA, revision: 2, contentHash: "ha2" },
      blocks: [],
    });

    expect(next.selection).toEqual(initialMarginState.selection);
  });

  it("preserves dirty canvas state when a session hydrates the same document", () => {
    const state = {
      ...initialMarginState,
      doc: documentA,
      documentDirty: true,
    };
    const next = marginReducer(state, {
      type: "setDocBundle",
      doc: documentA,
      blocks: [],
      preserveDocumentDirty: true,
    });

    expect(next.documentDirty).toBe(true);
  });

  it("resets dirty state when a session really switches documents", () => {
    const state = {
      ...initialMarginState,
      doc: documentA,
      documentDirty: true,
    };
    const next = marginReducer(state, {
      type: "setDocBundle",
      doc: documentB,
      blocks: [],
      preserveDocumentDirty: true,
    });

    expect(next.documentDirty).toBe(false);
  });

  it("clears dirty state after a normal same-document save", () => {
    const next = marginReducer({
      ...initialMarginState,
      doc: documentA,
      documentDirty: true,
    }, {
      type: "setDocBundle",
      doc: { ...documentA, revision: 2 },
      blocks: [],
    });

    expect(next.documentDirty).toBe(false);
  });

  it("bounds the in-memory chat transcript during long sessions", () => {
    let state = initialMarginState;
    for (let index = 0; index < 150; index += 1) {
      state = marginReducer(state, {
        type: "appendMessage",
        message: { id: `m-${index}`, role: "assistant", text: `message ${index}` },
      });
    }

    expect(state.messages).toHaveLength(120);
    expect(state.messages[0]?.id).toBe("m-30");
    expect(state.messages.at(-1)?.id).toBe("m-149");
  });

  it("keeps a thread anchor synchronized with its visible selection", () => {
    const state = {
      ...initialMarginState,
      threads: [{
        id: "thread-1",
        anchor: { blockId: "b1", selectionText: "before" },
        pos: { x: 40, y: 120 },
        collapsed: true,
        createdAt: "2026-07-23T00:00:00.000Z",
      }],
    };

    const next = marginReducer(state, {
      type: "updateThreadPosition",
      threadId: "thread-1",
      pos: { x: 52, y: 240 },
    });

    expect(next.threads[0]?.pos).toEqual({ x: 52, y: 240 });
  });

  it("hydrates persisted threads as collapsed anchors without screen positions", () => {
    const next = marginReducer(initialMarginState, {
      type: "setThreads",
      threads: [{
        id: "thread-1",
        anchor: { blockId: "b1", selectionText: "before", selectionStart: 4 },
        pos: null,
        collapsed: true,
        createdAt: "2026-07-23T00:00:00.000Z",
      }],
    });

    expect(next.threads).toMatchObject([{
      id: "thread-1",
      pos: null,
      collapsed: true,
      anchor: { blockId: "b1", selectionStart: 4 },
    }]);
    expect(next.activeThreadId).toBeNull();
  });

  it("does not merge equal text selected at different offsets", () => {
    const state = {
      ...initialMarginState,
      threads: [{
        id: "thread-1",
        anchor: { blockId: "b1", selectionText: "重复", selectionStart: 2 },
        pos: null,
        collapsed: true,
        createdAt: "2026-07-23T00:00:00.000Z",
      }],
    };
    const next = marginReducer(state, {
      type: "openThread",
      thread: {
        id: "thread-2",
        anchor: { blockId: "b1", selectionText: "重复", selectionStart: 12 },
        pos: null,
        collapsed: false,
        createdAt: "2026-07-23T00:01:00.000Z",
      },
    });

    expect(next.threads.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
    expect(next.activeThreadId).toBe("thread-2");
  });
});
