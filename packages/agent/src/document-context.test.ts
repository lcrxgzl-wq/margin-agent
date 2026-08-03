import { describe, expect, it } from "vitest";
import {
  buildFullDocumentInjection,
  DOCUMENT_FULL_REMOVED_PLACEHOLDER,
  resolveDocumentMode,
  stripDocumentInjections,
} from "./document-context.js";

describe("resolveDocumentMode", () => {
  it("keeps eco and overflow locks on lean", () => {
    expect(resolveDocumentMode({
      tier: "eco",
      contextWindow: 200_000,
      documentInjectionChars: 1_000,
      transcriptChars: 0,
      leanLocked: false,
    })).toBe("lean");
    expect(resolveDocumentMode({
      tier: "standard",
      contextWindow: 200_000,
      documentInjectionChars: 1_000,
      transcriptChars: 0,
      leanLocked: true,
    })).toBe("lean");
  });

  it("uses full when the conservative budget fits", () => {
    expect(resolveDocumentMode({
      tier: "standard",
      contextWindow: 128_000,
      documentInjectionChars: 20_000,
      transcriptChars: 10_000,
      leanLocked: false,
    })).toBe("full");
  });

  it("falls back to lean when the document exceeds remaining budget", () => {
    expect(resolveDocumentMode({
      tier: "standard",
      contextWindow: 32_000,
      documentInjectionChars: 20_000,
      transcriptChars: 8_000,
      leanLocked: false,
    })).toBe("lean");
  });

  it("falls back to lean when turn overhead leaves no room", () => {
    expect(resolveDocumentMode({
      tier: "standard",
      contextWindow: 128_000,
      documentInjectionChars: 20_000,
      transcriptChars: 10_000,
      turnOverheadChars: 90_000,
      leanLocked: false,
    })).toBe("lean");
  });

  it("falls back to lean when contextWindow is missing", () => {
    expect(resolveDocumentMode({
      tier: "standard",
      contextWindow: 0,
      documentInjectionChars: 1_000,
      transcriptChars: 0,
      leanLocked: false,
    })).toBe("lean");
  });
});

describe("full document injection slot", () => {
  it("builds a revision-tagged block map and strips stale copies", () => {
    const injection = buildFullDocumentInjection({
      blocks: [
        { id: "b2", kind: "paragraph", text: "第二段", order: 1, contentHash: "h2" },
        { id: "b1", kind: "heading", text: "# 标题", order: 0, contentHash: "h1" },
      ],
      revision: 7,
      relativePath: "paper.md",
    });
    expect(injection).toContain("[Margin 文稿全文 revision=7 path=paper.md blocks=2]");
    expect(injection).toContain("### b1 (heading)");
    expect(injection).toContain("### b2 (paragraph)");
    expect(injection.indexOf("b1")).toBeLessThan(injection.indexOf("b2"));

    const cleaned = stripDocumentInjections([
      { role: "user", content: `上一轮\n${injection}\n结尾` } as never,
      {
        role: "user",
        content: [{ type: "text", text: `数组形态\n${injection}` }],
      } as never,
    ]);
    expect(cleaned[0]).toMatchObject({
      content: expect.stringContaining(DOCUMENT_FULL_REMOVED_PLACEHOLDER),
    });
    expect(String((cleaned[0] as { content: string }).content)).not.toContain("第二段");
    expect(cleaned[1]).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining(DOCUMENT_FULL_REMOVED_PLACEHOLDER) }],
    });
  });
});
