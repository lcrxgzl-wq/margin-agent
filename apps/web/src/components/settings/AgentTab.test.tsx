import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("AgentTab runtime presets", () => {
  it("renders retry, timeout and selection-context controls", async () => {
    vi.stubGlobal("location", { href: "http://127.0.0.1/#token=test-token" });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
    });
    const { AgentTab } = await import("./AgentTab");

    const html = renderToStaticMarkup(createElement(AgentTab, { open: true }));
    expect(html).toContain("选区上下文上限");
    expect(html).toContain('max="100000"');
    expect(html).toContain("100,000");
    expect(html).toContain("请求超时");
    expect(html).toContain('max="1800"');
    expect(html).toContain("20 分钟");
    expect(html).toContain("30 分钟");
    expect(html).not.toContain("2 分钟");
    expect(html).toContain("失败重试总尝试数");
    expect(html).toContain('placeholder="5"');
    expect(html).toContain("重试间隔（秒）");
    expect(html).toContain('placeholder="30"');
    expect(html).toContain("包含首次请求");
    expect(html).toContain("工作区外读取");
    expect(html).toContain("允许通过绝对路径读取工作区外资料（默认开启）");
    expect(html).toContain("默认全工具可用");
  });
});
