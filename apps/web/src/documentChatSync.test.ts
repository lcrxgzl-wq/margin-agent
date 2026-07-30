import { describe, expect, it, vi } from "vitest";
import {
  clearChatAfterDirectDocumentOpen,
  resyncChatAfterAgentDocumentOpen,
} from "./documentChatSync";

describe("visible chat synchronization after a document opens", () => {
  it("clears direct-open chat only after a different document succeeded", () => {
    const setMessages = vi.fn();
    expect(clearChatAfterDirectDocumentOpen("doc-a", "doc-b", setMessages)).toBe(true);
    expect(setMessages).toHaveBeenCalledWith([]);

    setMessages.mockClear();
    expect(clearChatAfterDirectDocumentOpen("doc-a", "doc-a", setMessages)).toBe(false);
    expect(clearChatAfterDirectDocumentOpen("doc-a", undefined, setMessages)).toBe(false);
    expect(setMessages).not.toHaveBeenCalled();
  });

  it("clears then hydrates the authoritative chat after an Agent document switch", async () => {
    const calls: string[] = [];
    const applied: unknown[] = [];
    const result = await resyncChatAfterAgentDocumentOpen({
      previousDocumentId: "doc-a",
      nextDocumentId: "doc-b",
      clearMessages: () => calls.push("clear"),
      loadSnapshot: async () => {
        calls.push("load");
        return { chat: { turns: [] } };
      },
      applySnapshot: async (snapshot) => {
        calls.push("apply");
        applied.push(snapshot);
      },
    });

    expect(result).toBe(true);
    expect(calls).toEqual(["clear", "load", "apply"]);
    expect(applied).toEqual([{ chat: { turns: [] } }]);
  });

  it("leaves visible chat untouched when the Agent did not switch documents", async () => {
    const clearMessages = vi.fn();
    const loadSnapshot = vi.fn(async () => ({}));
    const applySnapshot = vi.fn(async () => undefined);

    expect(await resyncChatAfterAgentDocumentOpen({
      previousDocumentId: "doc-a",
      nextDocumentId: "doc-a",
      clearMessages,
      loadSnapshot,
      applySnapshot,
    })).toBe(false);
    expect(clearMessages).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(applySnapshot).not.toHaveBeenCalled();
  });
});
