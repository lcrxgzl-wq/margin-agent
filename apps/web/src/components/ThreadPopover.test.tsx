import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ThreadPopover retry", () => {
  it("renders the retry action beside the failed thread message", async () => {
    vi.stubGlobal("window", {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const { ThreadPopover } = await import("./ThreadPopover");
    const html = renderToStaticMarkup(createElement(ThreadPopover, {
      thread: {
        id: "thread-1",
        anchor: { blockId: "block-1", selectionText: "source" },
        pos: null,
        collapsed: false,
        createdAt: "2026-08-03T00:00:00.000Z",
      },
      anchorAlive: true,
      proposals: [],
      comments: [],
      messages: [{
        id: "error-1",
        role: "assistant",
        text: "Connection error",
      }],
      retryMessageId: "error-1",
      busy: false,
      statusLine: "",
      dirty: false,
      onSend: () => undefined,
      onRetry: () => undefined,
      onAccept: () => undefined,
      onEdit: () => undefined,
      onUndo: () => undefined,
      onRewrite: () => undefined,
      onCollapse: () => undefined,
      onClose: () => undefined,
    }));

    expect(html).toContain("请求未完成");
    expect(html).toContain("重试");
  });
});
