import { describe, expect, it, vi } from "vitest";
import {
  prepareChatRetry,
  executableChatRetry,
  retryFailedChat,
  snapshotChatRetrySelection,
  type ChatRetryPayload,
} from "./chatRetry";

type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  retry?: ChatRetryPayload;
};

describe("prepareChatRetry", () => {
  const failed: Message[] = [
    { id: "older", role: "assistant", text: "之前" },
    { id: "user-1", role: "user", text: "继续通读" },
    { id: "partial-1", role: "assistant", text: "已读到" },
    {
      id: "error-1",
      role: "assistant",
      text: "Connection error",
      retry: {
        failedUserMessageId: "user-1",
        failedAssistantMessageId: "partial-1",
        requestId: "request-1",
        text: "继续通读",
        selectedSkills: ["social-science-zh"],
        threadId: "thread-1",
        cascadeBlockIds: ["block-2"],
        sourcePaths: ["sources/evidence.pdf"],
        chatMode: "socratic",
        harnessId: "social-science-zh",
        selection: {
          blockId: "block-1",
          blockIds: ["block-1", "block-2"],
          selectionRanges: [
            { blockId: "block-1", start: 3, end: 5, before: "原文" },
            { blockId: "block-2", start: 0, end: 2, before: "续段" },
          ],
          text: "原文续段",
          selectionStart: 3,
          tableCell: { row: 1, column: 2, address: "B2", before: "原文" },
          crossTableCells: true,
        },
        documentId: "doc-1",
        documentRevision: 7,
      },
    },
  ];

  it("replaces the failed pair and restores the exact structured request", () => {
    const result = prepareChatRetry(failed, "error-1", { id: "doc-1", revision: 7 });

    expect(result).toEqual({
      messages: [failed[0]],
      requestId: "request-1",
      text: "继续通读",
      selectedSkills: ["social-science-zh"],
      threadId: "thread-1",
      cascadeBlockIds: ["block-2"],
      sourcePaths: ["sources/evidence.pdf"],
      chatMode: "socratic",
      harnessId: "social-science-zh",
      selection: failed[3]!.retry!.selection,
    });
    expect(result!.selection).not.toBe(failed[3]!.retry!.selection);
    expect(result!.selection.selectionRanges).not.toBe(
      failed[3]!.retry!.selection.selectionRanges,
    );
  });

  it("rejects a stale button after another turn or document/revision switch", () => {
    expect(prepareChatRetry([...failed, {
      id: "user-2",
      role: "user",
      text: "新问题",
    }], "error-1", { id: "doc-1", revision: 7 })).toBeNull();
    expect(prepareChatRetry(failed, "error-1", { id: "doc-2", revision: 7 })).toBeNull();
    expect(prepareChatRetry(failed, "error-1", { id: "doc-1", revision: 8 })).toBeNull();
  });

  it("does not retry when the failed user bubble is no longer present", () => {
    expect(prepareChatRetry(
      [failed[0]!, failed[3]!],
      "error-1",
      { id: "doc-1", revision: 7 },
    )).toBeNull();
  });

  it("replaces the failed messages before resending the original request options", async () => {
    const setMessages = vi.fn();
    const focusThread = vi.fn();
    const send = vi.fn().mockResolvedValue(undefined);

    await expect(retryFailedChat({
      messages: failed,
      errorMessageId: "error-1",
      currentDocument: { id: "doc-1", revision: 7 },
      documentDirty: false,
      currentThreadIds: ["thread-1"],
      setMessages,
      focusThread,
      send,
    })).resolves.toBe(true);

    expect(setMessages).toHaveBeenCalledWith([failed[0]]);
    expect(focusThread).toHaveBeenCalledWith("thread-1");
    expect(send).toHaveBeenCalledWith("继续通读", {
      requestId: "request-1",
      selectedSkills: ["social-science-zh"],
      threadId: "thread-1",
      cascadeBlockIds: ["block-2"],
      sourcePaths: ["sources/evidence.pdf"],
      chatMode: "socratic",
      harnessId: "social-science-zh",
      selection: failed[3]!.retry!.selection,
    });
    expect(focusThread.mock.invocationCallOrder[0]).toBeLessThan(
      setMessages.mock.invocationCallOrder[0]!,
    );
    expect(setMessages.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0]!,
    );
  });

  it("uses the same last-message predicate for rendering and execution", () => {
    expect(executableChatRetry({
      messages: failed,
      currentDocument: { id: "doc-1", revision: 7 },
      documentDirty: false,
      currentThreadIds: ["thread-1"],
    })?.errorMessageId).toBe("error-1");

    expect(executableChatRetry({
      messages: [...failed, {
        id: "thread-later",
        role: "assistant",
        text: "later thread reply",
      }],
      currentDocument: { id: "doc-1", revision: 7 },
      documentDirty: false,
      currentThreadIds: ["thread-1"],
    })).toBeNull();
  });

  it("does not mutate messages or send when the canvas or thread is stale", async () => {
    const setMessages = vi.fn();
    const send = vi.fn();
    const base = {
      messages: failed,
      errorMessageId: "error-1",
      currentDocument: { id: "doc-1", revision: 7 },
      currentThreadIds: ["thread-1"],
      setMessages,
      send,
    };

    await expect(retryFailedChat({ ...base, documentDirty: true })).resolves.toBe(false);
    await expect(retryFailedChat({
      ...base,
      documentDirty: false,
      currentThreadIds: [],
    })).resolves.toBe(false);
    expect(setMessages).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("takes an immutable snapshot of selection arrays and table metadata", () => {
    const source = snapshotChatRetrySelection(failed[3]!.retry!.selection);
    const snapshot = snapshotChatRetrySelection(source);

    source.blockIds![0] = "changed";
    source.selectionRanges![0]!.before = "变化";
    source.tableCell!.before = "变化";

    expect(snapshot.blockIds).toEqual(["block-1", "block-2"]);
    expect(snapshot.selectionRanges?.[0]?.before).toBe("原文");
    expect(snapshot.tableCell?.before).toBe("原文");
  });
});
