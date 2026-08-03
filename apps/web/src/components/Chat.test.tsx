import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Chat retry and context status", () => {
  const installBrowserGlobals = () => {
    vi.stubGlobal("location", { href: "http://127.0.0.1/#token=test-token" });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
    });
  };

  it("shows one explicit retry action for the latest failed turn", async () => {
    installBrowserGlobals();
    const { Chat } = await import("./Chat");
    const html = renderToStaticMarkup(createElement(Chat, {
      messages: [{ id: "user-1", role: "user", text: "继续" }, {
        id: "error-1",
        role: "assistant",
        text: "Connection error",
        retry: {
          failedUserMessageId: "user-1",
          requestId: "request-1",
          text: "继续",
          selection: { blockId: null, text: "" },
          documentId: "doc-1",
          documentRevision: 7,
        },
      }],
      busy: false,
      documentId: "doc-1",
      documentRevision: 7,
      docTitle: "paper.docx",
      llmMode: "byok",
      onSend: () => undefined,
      onRetryChat: () => undefined,
    }));

    expect(html).toContain("请求未完成");
    expect(html).toContain("重试");
    expect(html.match(/>重试</g)).toHaveLength(1);
  });

  it("hides a retry action after the document revision changes", async () => {
    installBrowserGlobals();
    const { Chat } = await import("./Chat");
    const html = renderToStaticMarkup(createElement(Chat, {
      messages: [{ id: "user-1", role: "user", text: "继续" }, {
        id: "error-1",
        role: "assistant",
        text: "Connection error",
        retry: {
          failedUserMessageId: "user-1",
          requestId: "request-1",
          text: "继续",
          selection: { blockId: null, text: "" },
          documentId: "doc-1",
          documentRevision: 7,
        },
      }],
      busy: false,
      documentId: "doc-1",
      documentRevision: 8,
      docTitle: "other.docx",
      llmMode: "byok",
      onSend: () => undefined,
      onRetryChat: () => undefined,
    }));

    expect(html).not.toContain("请求未完成");
    expect(html).not.toContain(">重试<");
  });

  it("hides a retry action while the canvas has unsaved changes", async () => {
    installBrowserGlobals();
    const { Chat } = await import("./Chat");
    const html = renderToStaticMarkup(createElement(Chat, {
      messages: [{ id: "user-1", role: "user", text: "继续" }, {
        id: "error-1",
        role: "assistant",
        text: "Connection error",
        retry: {
          failedUserMessageId: "user-1",
          requestId: "request-1",
          text: "继续",
          selection: { blockId: "block-1", text: "原文" },
          documentId: "doc-1",
          documentRevision: 7,
        },
      }],
      busy: false,
      documentDirty: true,
      documentId: "doc-1",
      documentRevision: 7,
      docTitle: "paper.docx",
      llmMode: "byok",
      onSend: () => undefined,
      onRetryChat: () => undefined,
    }));

    expect(html).not.toContain("请求未完成");
    expect(html).not.toContain(">重试<");
  });

  it("hides a stale global retry after a newer thread-only message", async () => {
    installBrowserGlobals();
    const { Chat } = await import("./Chat");
    const html = renderToStaticMarkup(createElement(Chat, {
      messages: [{ id: "user-1", role: "user", text: "继续" }, {
        id: "error-1",
        role: "assistant",
        text: "Connection error",
        retry: {
          failedUserMessageId: "user-1",
          requestId: "request-1",
          text: "继续",
          selection: { blockId: null, text: "" },
          documentId: "doc-1",
          documentRevision: 7,
        },
      }, {
        id: "thread-later",
        role: "assistant",
        text: "线程中的后续回复",
        threadId: "thread-1",
      }],
      busy: false,
      documentId: "doc-1",
      documentRevision: 7,
      threads: [{
        id: "thread-1",
        anchor: { blockId: "block-1", selectionText: "原文" },
        pos: null,
        collapsed: true,
        createdAt: "2026-08-03T00:00:00.000Z",
      }],
      onSend: () => undefined,
      onRetryChat: () => undefined,
    }));

    expect(html).not.toContain("请求未完成");
    expect(html).not.toContain(">重试<");
  });

  it("shows estimated session usage against the model context window", async () => {
    installBrowserGlobals();
    const { Chat } = await import("./Chat");
    const html = renderToStaticMarkup(createElement(Chat, {
      messages: [{ id: "assistant-1", role: "assistant", text: "在。" }],
      busy: false,
      landing: true,
      llmMode: "byok",
      contextUsage: {
        contextWindowTokens: 128_000,
        usedTokens: 12_345,
        usageEstimated: true,
      },
      onSend: () => undefined,
    }));

    expect(html).toContain("上下文（估算） 12.3k / 128k");
    expect(html).toContain("模型上下文窗口 128,000 tokens");
  });
});
