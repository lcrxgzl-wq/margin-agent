import {
  EvidenceCacheEntrySchema,
  type EvidenceCacheEntry,
} from "@margin/domain";

export const MAX_SESSION_EVIDENCE_ENTRIES = 80;
const MAX_PROMPT_EVIDENCE_ENTRIES = 12;
const MAX_PROMPT_PREVIEW_CHARS = 180;

const normalizePath = (value: string): string =>
  value.trim().replace(/\\/g, "/").replace(/^\.\//, "");

export function normalizeAttachedEvidenceCache(
  entries: readonly unknown[],
  sourcePaths: readonly string[],
): EvidenceCacheEntry[] {
  const attached = new Set(sourcePaths.map(normalizePath).filter(Boolean));
  const byRef = new Map<string, EvidenceCacheEntry>();
  for (const candidate of entries) {
    const parsed = EvidenceCacheEntrySchema.safeParse(candidate);
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (
      normalizePath(entry.relativePath) !== entry.relativePath ||
      !attached.has(entry.relativePath)
    ) continue;
    for (const [sourceRef, cached] of byRef) {
      if (
        cached.relativePath === entry.relativePath &&
        cached.versionHash !== entry.versionHash
      ) {
        byRef.delete(sourceRef);
      }
    }
    byRef.delete(entry.sourceRef);
    byRef.set(entry.sourceRef, entry);
  }
  return [...byRef.values()].slice(-MAX_SESSION_EVIDENCE_ENTRIES);
}

export function mergeEvidenceCacheEntry(
  entries: readonly EvidenceCacheEntry[],
  entry: EvidenceCacheEntry,
): EvidenceCacheEntry[] {
  const parsed = EvidenceCacheEntrySchema.parse(entry);
  return [
    ...entries.filter((candidate) =>
      candidate.sourceRef !== parsed.sourceRef &&
      (
        candidate.relativePath !== parsed.relativePath ||
        candidate.versionHash === parsed.versionHash
      )),
    parsed,
  ].slice(-MAX_SESSION_EVIDENCE_ENTRIES);
}

export function removeEvidenceCacheRefs(
  entries: readonly EvidenceCacheEntry[],
  refs: readonly string[],
): EvidenceCacheEntry[] {
  if (!refs.length) return [...entries];
  const removed = new Set(refs);
  return entries.filter((entry) => !removed.has(entry.sourceRef));
}

export function buildEvidenceCacheDirectory(
  entries: readonly EvidenceCacheEntry[],
  sourcePaths: readonly string[],
): string {
  const visible = normalizeAttachedEvidenceCache(entries, sourcePaths)
    .slice(-MAX_PROMPT_EVIDENCE_ENTRIES);
  if (!visible.length) return "";
  const lines = visible.map((entry) => {
    const preview = entry.preview.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_PREVIEW_CHARS);
    return `- ${entry.sourceRef}${preview ? ` | ${preview}` : ""}`;
  });
  return [
    "[会话已读证据目录]",
    "以下 sourceRef 来自本会话实际读取；使用时宿主会重新校验原文件 SHA-256。若校验失败，须重新读取，不能猜测引用。",
    ...lines,
  ].join("\n");
}
