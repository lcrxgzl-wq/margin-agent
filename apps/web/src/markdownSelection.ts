import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Block } from "./api";
import { displayText } from "./api";

function sourceOffsetForDisplayOffset(block: Block, displayOffset: number): number | undefined {
  const rendered = displayText(block);
  if (!Number.isInteger(displayOffset) || displayOffset < 0 || displayOffset > rendered.length) {
    return undefined;
  }
  if (block.kind === "heading") {
    const prefixLength = block.text.match(/^#{1,6}\s+/)?.[0].length ?? 0;
    return prefixLength + displayOffset;
  }
  if (block.kind !== "blockquote") return displayOffset;

  let sourceCursor = 0;
  let displayCursor = 0;
  const lines = block.text.split("\n");
  for (const [index, line] of lines.entries()) {
    const prefixLength = line.match(/^>\s?/)?.[0].length ?? 0;
    const contentLength = line.length - prefixLength;
    if (displayOffset <= displayCursor + contentLength) {
      return sourceCursor + prefixLength + displayOffset - displayCursor;
    }
    displayCursor += contentLength;
    sourceCursor += line.length;
    if (index < lines.length - 1) {
      displayCursor += 1;
      sourceCursor += 1;
    }
  }
  return undefined;
}

/** Convert a single rendered Markdown-block selection to immutable source coordinates. */
export function resolveMarkdownSelectionStart(
  doc: ProseMirrorNode,
  blocks: readonly Block[],
  blockId: string | null,
  from: number,
  to: number,
  renderedText: string,
): number | undefined {
  if (!blockId || !renderedText || from >= to) return undefined;
  const block = blocks.find((candidate) => candidate.id === blockId);
  if (!block) return undefined;

  let localRange: { start: number; end: number } | undefined;
  doc.forEach((node, offset) => {
    if (localRange || node.type.name !== "marginBlock" || node.attrs.blockId !== blockId) return;
    const contentStart = offset + 1;
    const contentEnd = contentStart + node.content.size;
    if (from < contentStart || to > contentEnd || node.textContent !== displayText(block)) return;
    localRange = { start: from - contentStart, end: to - contentStart };
  });
  if (!localRange) return undefined;
  const displayedSlice = displayText(block).slice(localRange.start, localRange.end);
  if (displayedSlice !== renderedText) return undefined;

  const sourceStart = sourceOffsetForDisplayOffset(block, localRange.start);
  if (sourceStart === undefined) return undefined;
  return block.text.slice(sourceStart, sourceStart + renderedText.length) === renderedText
    ? sourceStart
    : undefined;
}
