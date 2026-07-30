import type { Block } from "../api";
import { MAX_SELECTION_BLOCKS, type SelectionBlockRange } from "@margin/domain";

type OfficeSelectionElement = {
  type?: string;
  value?: string;
  valueList?: OfficeSelectionElement[];
};

export type OfficeSelectionContext = {
  paragraphText?: string;
  selectionText?: string;
  paragraphNo?: number;
  isTable?: boolean;
};

export function resolveOfficeBlocksForRange(
  resolve: OfficeBlockResolver,
  context: { startParagraphNo: number; endParagraphNo: number; isTable?: boolean },
  selectionText: string,
  paragraphText: string,
  paragraphSelections: string[],
): { blockId: string | null; blockIds?: string[] } {
  if (context.startParagraphNo === context.endParagraphNo) {
    return {
      blockId: resolve({
        paragraphText,
        selectionText,
        paragraphNo: context.startParagraphNo,
        isTable: context.isTable,
      }),
    };
  }

  const ids: string[] = [];
  for (
    let paragraphNo = context.startParagraphNo, index = 0;
    paragraphNo <= context.endParagraphNo && ids.length <= MAX_SELECTION_BLOCKS;
    paragraphNo += 1, index += 1
  ) {
    const fragment = paragraphSelections[index];
    // Empty OOXML paragraphs are intentionally absent from the immutable block
    // list. Resolving them by ordinal aliases a later, non-empty block.
    if (!fragment.trim()) continue;
    const id = resolve({
      paragraphNo,
      isTable: context.isTable,
      paragraphText: fragment,
      selectionText: index === 0 ? selectionText : undefined,
    });
    if (id && !ids.includes(id)) ids.push(id);
  }
  return { blockId: ids[0] ?? null, blockIds: ids.length > 1 ? ids : undefined };
}

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

/** Convert keyword-search stream coordinates to executeSetRange boundaries. */
export function canvasFocusRangeIndexes(
  range: { startIndex: number; endIndex: number },
  streamDrift: number,
): { startIndex: number; endIndex: number } {
  return {
    startIndex: Math.max(0, range.startIndex + streamDrift - 1),
    endIndex: range.endIndex + streamDrift,
  };
}

/** Recover one selected text fragment per canvas paragraph without inventing offsets. */
export function splitOfficeSelectionParagraphs(
  elements: OfficeSelectionElement[],
  expectedParagraphs: number,
): string[] | null {
  if (!elements.length || expectedParagraphs < 1) return null;
  const paragraphs: string[] = [];
  let current = "";
  let skipNextSentinel = false;
  const finish = () => {
    paragraphs.push(current);
    current = "";
  };
  const appendValue = (value: string) => {
    const parts = value.split(/\u200b|\r?\n/);
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        if (skipNextSentinel) skipNextSentinel = false;
        else if (current || paragraphs.length) finish();
      }
      current += part;
    }
  };
  const visit = (items: OfficeSelectionElement[]) => {
    for (const element of items) {
      if (element.valueList?.length) {
        const isParagraphGroup = element.type === "title" || element.type === "list";
        if (isParagraphGroup && current) finish();
        visit(element.valueList);
        if (isParagraphGroup && current) {
          finish();
          skipNextSentinel = true;
        }
        continue;
      }
      appendValue(element.value ?? "");
    }
  };
  visit(elements);
  if (current || paragraphs.length < expectedParagraphs) finish();
  return paragraphs.length === expectedParagraphs ? paragraphs : null;
}

/** Convert trusted per-paragraph canvas fragments into immutable block-local ranges. */
export function buildOfficeSelectionRanges(
  blocks: Block[],
  blockIds: string[],
  selectionText: string,
  paragraphSelections: string[] | null,
  singleSelectionStart?: number,
): SelectionBlockRange[] | null {
  if (!selectionText || !paragraphSelections) {
    return null;
  }
  // canvas-editor 0.9.137 joins element values and removes paragraph sentinels.
  // Verify that the fragments still describe exactly the live canvas selection
  // before aligning their boundary whitespace to storage's trimmed block text.
  if (paragraphSelections.join("") !== selectionText) return null;
  const selectedFragments = paragraphSelections.filter((fragment) => fragment.trim().length > 0);
  if (selectedFragments.length !== blockIds.length) return null;
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const ranges: SelectionBlockRange[] = [];
  for (const [index, blockId] of blockIds.entries()) {
    const block = byId.get(blockId);
    const fragment = selectedFragments[index] ?? "";
    if (!block || !fragment) return null;
    let before = fragment;
    let start: number | null;
    if (blockIds.length === 1) {
      const candidates = [...new Set([
        fragment,
        fragment.trimStart(),
        fragment.trimEnd(),
        fragment.trim(),
      ])].filter(Boolean);
      start = null;
      for (const candidate of candidates) {
        const candidateStart = findSelectionStart(block.text, candidate, singleSelectionStart);
        if (candidateStart == null) continue;
        before = candidate;
        start = candidateStart;
        break;
      }
    } else if (index === 0) {
      const withoutTrailingBoundary = fragment.trimEnd();
      const candidates = [...new Set([
        withoutTrailingBoundary,
        withoutTrailingBoundary.trimStart(),
      ])].filter(Boolean);
      before = candidates.find((candidate) => block.text.endsWith(candidate)) ?? "";
      start = before ? block.text.length - before.length : null;
    } else if (index === blockIds.length - 1) {
      const withoutLeadingBoundary = fragment.trimStart();
      const candidates = [...new Set([
        withoutLeadingBoundary,
        withoutLeadingBoundary.trimEnd(),
      ])].filter(Boolean);
      before = candidates.find((candidate) => block.text.startsWith(candidate)) ?? "";
      start = before ? 0 : null;
    } else {
      before = fragment.trim();
      start = before === block.text ? 0 : null;
    }
    if (start == null) return null;
    ranges.push({ blockId, start, end: start + before.length, before });
  }
  return ranges;
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
