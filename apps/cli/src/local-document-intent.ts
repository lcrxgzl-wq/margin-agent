import path from "node:path";

const WRAPPING_QUOTES: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["《", "》"],
];

function normalizeAbsoluteDocxPath(candidate: string): string | null {
  const value = candidate.trim();
  if (!/\.docx$/i.test(value)) return null;
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) return null;
  return path.normalize(value);
}

function quotedDocxPaths(message: string): string[] {
  const matches = new Set<string>();
  for (const [left, right] of WRAPPING_QUOTES) {
    let offset = 0;
    while (offset < message.length) {
      const start = message.indexOf(left, offset);
      if (start < 0) break;
      const contentStart = start + left.length;
      const end = message.indexOf(right, contentStart);
      if (end < 0) break;
      const normalized = normalizeAbsoluteDocxPath(
        message.slice(contentStart, end),
      );
      if (normalized) matches.add(normalized);
      offset = end + right.length;
    }
  }
  return [...matches];
}

/** Accept one explicit absolute DOCX path, optionally surrounded by a short request. */
export function parseExplicitLocalDocxPath(message: string): string | null {
  let candidate = message.trim();
  if (!candidate) return null;

  const quoted = quotedDocxPaths(candidate);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length > 1 || candidate.includes("\n")) return null;

  candidate = candidate.replace(/^(?:请\s*)?(?:打开|导入|读取|处理|open|import)\s*/i, "").trim();
  return normalizeAbsoluteDocxPath(candidate);
}

/** Opening-related turns are buffered until the Host can verify the document state. */
export function isDocumentOpenStatusMessage(message: string): boolean {
  const text = message.trim();
  return (
    /\.docx(?:\b|["'`”》])/i.test(text) ||
    /(?:打开|导入|加载).{0,20}(?:文档|文稿|文件)/i.test(text) ||
    /(?:文档|文稿|文件).{0,20}(?:打开|导入|加载|显示|看到)/i.test(text) ||
    /(?:没|未|不).{0,4}看到.{0,8}(?:文档|文稿|文件)/i.test(text)
  );
}

/** Detect success language that is invalid without a Host `opened` result. */
export function claimsDocumentOpened(reply: string): boolean {
  return (
    /已(?:经|完成)?(?:成功)?(?:导入|打开|加载)/.test(reply) ||
    /(?:导入|打开|加载)(?:操作)?已完成/.test(reply) ||
    /现在(?:你)?应(?:该)?能.{0,16}(?:看到|编辑)/.test(reply)
  );
}
