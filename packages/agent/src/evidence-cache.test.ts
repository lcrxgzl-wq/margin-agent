import { describe, expect, it } from "vitest";
import type { EvidenceCacheEntry } from "@margin/domain";
import {
  buildEvidenceCacheDirectory,
  mergeEvidenceCacheEntry,
  normalizeAttachedEvidenceCache,
} from "./evidence-cache.js";

function entry(index: number): EvidenceCacheEntry {
  const extractedHash = index.toString(16).padStart(16, "0");
  return {
    sourceRef: `notes.txt#sha256=${extractedHash}&chars=${index}-${index + 1}`,
    relativePath: "notes.txt",
    start: index,
    end: index + 1,
    extractedHash,
    versionHash: "a".repeat(64),
    preview: `preview ${index} ${"x".repeat(300)}`.slice(0, 800),
    readAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("evidence cache bounds", () => {
  it("moves duplicate refs to newest and evicts the oldest beyond 80", () => {
    let cache: EvidenceCacheEntry[] = [];
    for (let index = 0; index < 85; index += 1) {
      cache = mergeEvidenceCacheEntry(cache, entry(index));
    }
    cache = mergeEvidenceCacheEntry(cache, { ...entry(84), preview: "latest" });
    expect(cache).toHaveLength(80);
    expect(cache[0]?.sourceRef).toBe(entry(5).sourceRef);
    expect(cache.at(-1)?.preview).toBe("latest");
  });

  it("evicts every older fragment when the same source has a new byte version", () => {
    const oldEntries = [entry(1), entry(2)];
    const current = { ...entry(3), versionHash: "b".repeat(64) };

    expect(mergeEvidenceCacheEntry(oldEntries, current)).toEqual([current]);
    expect(normalizeAttachedEvidenceCache([...oldEntries, current], ["notes.txt"]))
      .toEqual([current]);
  });

  it("filters detached entries and bounds the prompt directory to the latest 12", () => {
    const attached = Array.from({ length: 20 }, (_, index) => entry(index));
    const detached = { ...entry(20), relativePath: "other.txt" };
    expect(normalizeAttachedEvidenceCache([...attached, detached], ["notes.txt"]))
      .toEqual(attached);

    const directory = buildEvidenceCacheDirectory(attached, ["notes.txt"]);
    expect(directory).toContain("[会话已读证据目录]");
    expect(directory).toContain("重新校验原文件 SHA-256");
    expect(directory).not.toContain(entry(7).sourceRef);
    expect(directory).toContain(entry(8).sourceRef);
    expect(directory).toContain(entry(19).sourceRef);
    expect(directory.length).toBeLessThan(12_500);
  });
});
