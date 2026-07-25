import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasMarkdown, Markdown } from "./Markdown";

describe("Markdown chat rendering", () => {
  it("renders a pipe table as a real table", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"| 部分 | 状态 |\n| --- | --- |\n| 摘要 | 空白 |\n| 结果 | 空白 |"} />,
    );
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("部分");
    expect(html).toContain("摘要");
  });

  it("renders headings, bold and lists", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"## 标题\n\n- **重点** 一项\n- 二项"} />,
    );
    expect(html).toContain("<h4");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<ul>");
  });

  it("does not treat plain prose as markdown", () => {
    expect(hasMarkdown("读完全文，以下是我的评估。")).toBe(false);
    expect(hasMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
  });

  it("keeps streaming partial tables as plain text until complete", () => {
    const html = renderToStaticMarkup(<Markdown text={"| 部分 | 状态 |"} />);
    expect(html).not.toContain("<table");
  });
});
