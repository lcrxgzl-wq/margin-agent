import { memo, type ReactNode } from "react";

/** Minimal, safe Markdown renderer for chat bubbles (no dangerouslySetInnerHTML). */

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; header: string[]; align: Array<"left" | "center" | "right">; rows: string[][] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" };

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseTableAlign(line: string): Array<"left" | "center" | "right"> | null {
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const align: Array<"left" | "center" | "right"> = [];
  for (const cell of cells) {
    if (!/^:?-{2,}:?$/.test(cell.replace(/\s/g, ""))) return null;
    const compact = cell.replace(/\s/g, "");
    align.push(compact.startsWith(":") && compact.endsWith(":") ? "center"
      : compact.endsWith(":") ? "right"
      : "left");
  }
  return align;
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|") && i + 1 < lines.length) {
      const align = parseTableAlign(lines[i + 1]!);
      if (align) {
        const header = splitTableRow(trimmed);
        const rows: string[][] = [];
        i += 2;
        while (
          i < lines.length &&
          lines[i]!.trim().startsWith("|") &&
          lines[i]!.trim().endsWith("|")
        ) {
          rows.push(splitTableRow(lines[i]!));
          i += 1;
        }
        blocks.push({ kind: "table", header, align, rows });
        continue;
      }
    }

    if (/^[-*+]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      const ordered = /^\d+[.)]\s+/.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i]!.trim();
        const match = ordered ? /^\d+[.)]\s+(.*)$/.exec(item) : /^[-*+]\s+(.*)$/.exec(item);
        if (!match) break;
        items.push(match[1]!);
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        body.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }

    const body: string[] = [trimmed];
    i += 1;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|```|>|\||[-*+]\s|\d+[.)]\s)/.test(lines[i]!.trim()) &&
      !/^(?:-{3,}|\*{3,}|_{3,})$/.test(lines[i]!.trim())
    ) {
      body.push(lines[i]!.trim());
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: body.join(" ") });
  }
  return blocks;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // inline code | bold | italic | strikethrough | link
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (match[1]) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (match[2] || match[3]) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (match[4] || match[5]) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (match[6]) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (match[7]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link && /^https?:\/\//.test(link[2]!)) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case "heading": {
            const Tag = (`h${Math.min(block.level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
            return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
          }
          case "paragraph":
            return <p key={key}>{renderInline(block.text, key)}</p>;
          case "code":
            return <pre key={key}><code>{block.text}</code></pre>;
          case "table":
            return (
              <div key={key} className="md-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? "left" }}>
                          {renderInline(cell, `${key}h${cellIndex}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {block.header.map((_, cellIndex) => (
                          <td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? "left" }}>
                            {renderInline(row[cellIndex] ?? "", `${key}r${rowIndex}c${cellIndex}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item, `${key}i${itemIndex}`)}</li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return <blockquote key={key}>{renderInline(block.text, key)}</blockquote>;
          case "hr":
            return <hr key={key} />;
        }
      })}
    </div>
  );
});

/** Cheap detector so short plain replies skip block parsing entirely. */
export function hasMarkdown(text: string): boolean {
  return /[\*\_\~\[\(#{|\->]/.test(text) || text.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("|") && trimmed.endsWith("|");
  });
}
