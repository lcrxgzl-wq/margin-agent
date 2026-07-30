export type OpenIntent =
  | { kind: "none" }
  | { kind: "list" }
  | { kind: "path"; relativePath: string };

const GENERIC = /^(文稿|文章|文件|文档|论文)$/;

const PATH_QUOTE_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["\u201c", "\u201d"],
  ["\u300a", "\u300b"],
  ["\u300c", "\u300d"],
];

/** Strip one layer of wrapping quotes from an open/read path token. */
export function unwrapPathToken(raw: string): string {
  const value = raw.trim();
  for (const [left, right] of PATH_QUOTE_PAIRS) {
    if (
      value.startsWith(left) &&
      value.endsWith(right) &&
      value.length > left.length + right.length
    ) {
      return value.slice(left.length, -right.length).trim();
    }
  }
  return value;
}

/** Parse “打开 …” without treating bare “打开文稿” as a filename. */
export function parseOpenIntent(message: string): OpenIntent {
  const m = message.trim();
  if (!m) return { kind: "none" };

  if (
    /样章|示范|示例|agent-chapter/i.test(m) &&
    !/重写|讨论|改|读取|新建|写入/.test(m) &&
    (/打开/.test(m) || /^(样章|示范|示例)$/.test(m))
  ) {
    return { kind: "path", relativePath: "fixtures/agent-chapter.md" };
  }

  if (/^(?:打开|open)\s*(文稿|文章|文件|文档|论文)?\s*$/i.test(m)) {
    return { kind: "list" };
  }

  const typed = /^(?:打开|open)\s*(?:一下\s+)?(?:文件|文稿|文章|文档)\s+(.+)$/i.exec(m);
  if (typed) {
    const rel = unwrapPathToken(typed[1]);
    if (!rel || GENERIC.test(rel)) return { kind: "list" };
    if (/样章|示范|示例/.test(rel)) {
      return { kind: "path", relativePath: "fixtures/agent-chapter.md" };
    }
    return { kind: "path", relativePath: rel.replace(/\\/g, "/") };
  }

  const named = /^(?:打开|open)\s*(.+)$/i.exec(m);
  if (!named) return { kind: "none" };

  const rel = unwrapPathToken(named[1]);
  if (!rel || GENERIC.test(rel)) return { kind: "list" };
  if (/样章|示范|示例/.test(rel)) {
    return { kind: "path", relativePath: "fixtures/agent-chapter.md" };
  }
  return { kind: "path", relativePath: rel.replace(/\\/g, "/") };
}

/** Resolve a user path token against workspace material files. */
export function resolveOpenPath(relativePath: string, files: string[]): string | null {
  const rel = unwrapPathToken(relativePath).replace(/\\/g, "/").trim();
  if (!rel) return null;
  if (/样章|示范|示例/.test(rel) || rel === "fixtures/agent-chapter.md") {
    return "fixtures/agent-chapter.md";
  }
  if (files.includes(rel)) return rel;
  const byEnd =
    files.find((f) => f.endsWith(`/${rel}`) || f === rel) ??
    files.find((f) => f.endsWith(rel));
  if (byEnd) return byEnd;
  const fuzzy =
    files.find((f) => f.includes(rel)) ??
    files.find((f) => f.toLowerCase().includes(rel.toLowerCase()));
  if (fuzzy) return fuzzy;
  if (rel.includes("/") || /\.(md|markdown|docx)$/i.test(rel)) return rel;
  return null;
}

/** Parse “读取 …” paths, including quoted names with spaces. */
export function parseReadIntent(message: string): string | null {
  const named = /^(?:读取|读一下|read)\s+(.+)$/i.exec(message.trim());
  if (!named) return null;
  const rel = unwrapPathToken(named[1]).replace(/\\/g, "/").trim();
  return rel || null;
}
