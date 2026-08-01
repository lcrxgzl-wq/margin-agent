import { describe, expect, it } from "vitest";
import { EvidenceCacheEntrySchema } from "./index.js";

const entry = {
  sourceRef: "notes/interview.txt#sha256=0123456789abcdef&chars=10-20",
  relativePath: "notes/interview.txt",
  start: 10,
  end: 20,
  extractedHash: "0123456789abcdef",
  versionHash: "a".repeat(64),
  preview: "bounded excerpt",
  readAt: "2026-08-01T00:00:00.000Z",
};

describe("EvidenceCacheEntrySchema", () => {
  it("accepts an internally consistent byte-versioned sourceRef", () => {
    expect(EvidenceCacheEntrySchema.parse(entry)).toEqual(entry);
  });

  it.each([
    { relativePath: "notes/other.txt" },
    { extractedHash: "f".repeat(16) },
    { start: 11 },
    { end: 21 },
  ])("rejects sourceRef field mismatches: %o", (change) => {
    expect(() => EvidenceCacheEntrySchema.parse({ ...entry, ...change })).toThrow(
      /does not match sourceRef/,
    );
  });

  it("requires a full SHA-256 source-byte version", () => {
    expect(() => EvidenceCacheEntrySchema.parse({
      ...entry,
      versionHash: "a".repeat(63),
    })).toThrow();
  });
});
