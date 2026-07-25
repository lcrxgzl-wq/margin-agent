import type { BlockSnapshot } from "@margin/domain";

export type ContentStats = {
  blockCount: number;
  headingCount: number;
  paragraphCount: number;
  charCount: number;
  nonWsCharCount: number;
};

export type LossFlag =
  | "heading_drop"
  | "block_drop"
  | "char_drop"
  | "empty_output";

export type RoundtripLossReport = {
  schemaVersion: 1;
  source: ContentStats;
  result: ContentStats;
  ratios: {
    blocks: number;
    headings: number;
    chars: number;
  };
  flags: LossFlag[];
  ok: boolean;
};

export function statsFromBlocks(blocks: BlockSnapshot[]): ContentStats {
  let headingCount = 0;
  let paragraphCount = 0;
  let charCount = 0;
  let nonWsCharCount = 0;
  for (const b of blocks) {
    if (b.kind === "heading") headingCount += 1;
    else paragraphCount += 1;
    charCount += b.text.length;
    nonWsCharCount += b.text.replace(/\s+/g, "").length;
  }
  return {
    blockCount: blocks.length,
    headingCount,
    paragraphCount,
    charCount,
    nonWsCharCount,
  };
}

export function statsFromMarkdown(md: string): ContentStats {
  const normalized = md.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return {
      blockCount: 0,
      headingCount: 0,
      paragraphCount: 0,
      charCount: 0,
      nonWsCharCount: 0,
    };
  }
  const parts = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  let headingCount = 0;
  let paragraphCount = 0;
  let charCount = 0;
  let nonWsCharCount = 0;
  for (const p of parts) {
    if (/^#{1,6}\s/.test(p)) headingCount += 1;
    else paragraphCount += 1;
    charCount += p.length;
    nonWsCharCount += p.replace(/\s+/g, "").length;
  }
  return {
    blockCount: parts.length,
    headingCount,
    paragraphCount,
    charCount,
    nonWsCharCount,
  };
}

function ratio(result: number, source: number): number {
  if (source <= 0) return result <= 0 ? 1 : Infinity;
  return result / source;
}

/**
 * Compare source vs round-tripped content.
 * Fail gates (ok=false): empty output, or headings/blocks/chars drop below 50%.
 */
export function compareContentStats(
  source: ContentStats,
  result: ContentStats,
): RoundtripLossReport {
  const ratios = {
    blocks: ratio(result.blockCount, source.blockCount),
    headings: ratio(result.headingCount, source.headingCount),
    chars: ratio(result.nonWsCharCount, source.nonWsCharCount),
  };
  const flags: LossFlag[] = [];
  if (result.blockCount === 0 || result.nonWsCharCount === 0) flags.push("empty_output");
  if (source.headingCount > 0 && ratios.headings < 0.5) flags.push("heading_drop");
  if (source.blockCount > 0 && ratios.blocks < 0.5) flags.push("block_drop");
  if (source.nonWsCharCount > 0 && ratios.chars < 0.5) flags.push("char_drop");
  return {
    schemaVersion: 1,
    source,
    result,
    ratios,
    flags,
    ok: flags.length === 0,
  };
}
