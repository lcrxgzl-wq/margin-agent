import type { Block } from "../api";

export type OfficeSelectionContext = {
  paragraphText?: string;
  selectionText?: string;
  paragraphNo?: number;
  isTable?: boolean;
};

export function findSelectionStart(
  blockText: string,
  selectionText: string,
  preferredStart?: number,
): number | null {
  if (!selectionText) return null;
  if (
    preferredStart != null &&
    preferredStart >= 0 &&
    blockText.slice(preferredStart, preferredStart + selectionText.length) === selectionText
  ) {
    return preferredStart;
  }
  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= blockText.length - selectionText.length) {
    const match = blockText.indexOf(selectionText, cursor);
    if (match < 0) break;
    matches.push(match);
    cursor = match + Math.max(selectionText.length, 1);
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1 && preferredStart != null) {
    return matches.reduce((best, candidate) =>
      Math.abs(candidate - preferredStart) < Math.abs(best - preferredStart) ? candidate : best,
    );
  }
  return null;
}

export type OfficeBlockResolver = (context: OfficeSelectionContext) => string | null;

function normalized(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, "").trim();
}

function textScore(blockText: string, query: string): number {
  const block = normalized(blockText);
  const candidate = normalized(query);
  if (!block || !candidate) return 0;
  if (block === candidate) return 4;
  if (block.includes(candidate)) return 3;
  if (candidate.includes(block)) return 2;
  return 0;
}

export function createOfficeBlockResolver(blocks: Block[]): OfficeBlockResolver {
  const paragraphs = blocks.filter((block) => block.kind !== "table");
  const tables = blocks.filter((block) => block.kind === "table");
  const byBodyIndex = new Map<number, Block>();
  for (const block of blocks) {
    const match = /^ooxml-[pt]-(\d+)-/.exec(block.id);
    if (match) byBodyIndex.set(Number(match[1]), block);
  }
  const exact = new Map<string, Block[]>();
  for (const block of blocks) {
    const key = normalized(block.text);
    if (!key) continue;
    const matches = exact.get(key) ?? [];
    matches.push(block);
    exact.set(key, matches);
  }

  return (context) => {
    const queries = [context.paragraphText, context.selectionText].filter(
      (value): value is string => !!value?.trim(),
    );
    if (context.paragraphNo != null) {
      const bodyBlock = byBodyIndex.get(context.paragraphNo);
      if (
        bodyBlock &&
        (context.isTable ? bodyBlock.kind === "table" : bodyBlock.kind !== "table") &&
        (!queries.length || queries.some((query) => textScore(bodyBlock.text, query) > 0))
      ) {
        return bodyBlock.id;
      }
    }
    if (!context.isTable && context.paragraphNo != null) {
      const ordinal = paragraphs[context.paragraphNo];
      if (ordinal && (!queries.length || queries.some((query) => textScore(ordinal.text, query) > 0))) {
        return ordinal.id;
      }
    }

    for (const query of queries) {
      const matches = exact.get(normalized(query));
      const sameKind = context.isTable
        ? matches?.find((block) => block.kind === "table")
        : matches?.find((block) => block.kind !== "table");
      if (sameKind) return sameKind.id;
    }

    const candidates = context.isTable ? tables : blocks;
    let winner: { id: string; score: number } | null = null;
    for (const block of candidates) {
      let score = context.isTable && block.kind === "table" ? 2 : 0;
      for (const query of queries) score += textScore(block.text, query);
      if (!winner || score > winner.score) winner = { id: block.id, score };
    }
    if (winner && winner.score > (context.isTable ? 2 : 0)) return winner.id;
    if (queries.length) return null;
    if (!context.isTable && context.paragraphNo != null) {
      return paragraphs[context.paragraphNo]?.id ?? null;
    }
    return context.isTable ? tables[0]?.id ?? null : null;
  };
}

/** Resolve a canvas paragraph or selection back to the immutable OOXML block index. */
export function findOfficeBlockId(blocks: Block[], context: OfficeSelectionContext): string | null {
  return createOfficeBlockResolver(blocks)(context);
}
