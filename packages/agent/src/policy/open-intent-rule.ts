export type OpenIntent =
  | { kind: "none" }
  | { kind: "list" }
  | { kind: "path"; relativePath: string };

const GENERIC = /^(文稿|文章|文件|文档|论文)$/;

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

  const named = /^(?:打开|open)\s*[《"'「]?(.+?)[》"'」]?\s*$/i.exec(m);
  if (!named) return { kind: "none" };

  const rel = named[1].trim();
  if (!rel || GENERIC.test(rel)) return { kind: "list" };
  if (/样章|示范|示例/.test(rel)) {
    return { kind: "path", relativePath: "fixtures/agent-chapter.md" };
  }
  return { kind: "path", relativePath: rel };
}

/** Resolve a user path token against workspace markdown files. */
export function resolveOpenPath(relativePath: string, files: string[]): string | null {
  const rel = relativePath.replace(/\\/g, "/").trim();
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
  if (rel.includes("/") || /\.(md|markdown)$/i.test(rel)) return rel;
  return null;
}
