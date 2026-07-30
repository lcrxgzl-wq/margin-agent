import {
  MAX_SELECTION_BLOCKS,
  SelectionBlockRangeSchema,
  type BlockSnapshot,
  type SelectionBlockRange,
} from "@margin/domain";

export const MAX_SELECTION_CONTEXT_CHARS = 100_000;

export function resolveSelectionContextLimit(
  configuredChars: number | undefined,
  tierChars: number,
): number {
  const value = configuredChars ?? tierChars;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("invalid selection context limit");
  }
  return Math.min(value, MAX_SELECTION_CONTEXT_CHARS);
}

export function assertSelectionBlockCount(blockIds: readonly string[]): void {
  if (blockIds.length > MAX_SELECTION_BLOCKS) {
    throw new Error(`跨段落选区一次最多覆盖 ${MAX_SELECTION_BLOCKS} 个段落，请缩小选区后重试。`);
  }
}

export function validateProposalSelectionRanges(input: {
  selected: Array<Pick<BlockSnapshot, "id" | "text">>;
  selectionText?: string;
  selectionStart?: number;
  selectionRanges?: unknown;
}): SelectionBlockRange[] | undefined {
  const parsed = SelectionBlockRangeSchema.array()
    .max(MAX_SELECTION_BLOCKS)
    .safeParse(input.selectionRanges);
  if (input.selectionRanges !== undefined && !parsed.success) {
    throw new Error("选区的逐段范围无效，请重新选择后重试。");
  }
  const ranges = parsed.success ? parsed.data : undefined;
  if (!ranges?.length) {
    if (input.selectionText?.trim() && input.selected.length > 1) {
      throw new Error("当前格式无法精确定位跨段选区；请改用 Word 文档，或缩小到单段后重试。");
    }
    return undefined;
  }
  if (!input.selectionText?.length) {
    throw new Error("逐段选区范围缺少原始选区文本。");
  }
  if (ranges.length !== input.selected.length) {
    throw new Error("逐段选区范围必须覆盖每个目标段落。");
  }
  for (const [index, block] of input.selected.entries()) {
    const range = ranges[index];
    if (!range || range.blockId !== block.id) {
      throw new Error("逐段选区范围与目标段落顺序不一致。");
    }
    if (block.text.slice(range.start, range.end) !== range.before) {
      throw new Error(`选区与段落 ${block.id} 的当前内容不一致，请重新选择。`);
    }
    if (input.selected.length > 1) {
      const isFirst = index === 0;
      const isLast = index === input.selected.length - 1;
      if (isFirst && range.end !== block.text.length) {
        throw new Error("跨段选区的首段范围必须延伸到段尾。");
      }
      if (isLast && range.start !== 0) {
        throw new Error("跨段选区的末段范围必须从段首开始。");
      }
      if (!isFirst && !isLast && (range.start !== 0 || range.end !== block.text.length)) {
        throw new Error("跨段选区的中间段必须被完整覆盖。");
      }
    }
  }
  if (ranges.map((range) => range.before).join("") !== input.selectionText) {
    throw new Error("逐段范围无法还原原始选区，请重新选择后重试。");
  }
  if (input.selectionStart != null && ranges[0]?.start !== input.selectionStart) {
    throw new Error("选区起点与逐段范围不一致，请重新选择后重试。");
  }
  return ranges;
}
