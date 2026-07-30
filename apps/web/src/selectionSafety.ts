import type { TableCellSelection } from "./components/canvasTypes";
import { MAX_SELECTION_BLOCKS, type SelectionBlockRange } from "@margin/domain";

export type SelectionTarget = {
  blockId: string | null;
  /** All blocks covered when the selection crosses paragraphs. */
  blockIds?: string[];
  selectionRanges?: SelectionBlockRange[];
  text: string;
  tableCell?: TableCellSelection;
  /** True when the range spans more than one table cell. */
  crossTableCells?: boolean;
};

/** Explain why a selection cannot safely produce immutable block proposals. */
export function selectionEditUnavailableReason(target: SelectionTarget): string | null {
  if (!target.text.trim()) return null;
  if (target.crossTableCells) {
    return "选区横跨多个单元格，目前只能在单个单元格内生成提案；仍可讨论。";
  }
  if (target.tableCell && /[\r\n]/.test(target.tableCell.before)) {
    return "该单元格包含多个段落，目前不能安全生成提案；仍可讨论，或改选单段正文。";
  }
  if (target.tableCell) return null;
  if (target.blockIds?.length) {
    if (target.blockIds.length > MAX_SELECTION_BLOCKS) {
      return `跨段落选区一次最多覆盖 ${MAX_SELECTION_BLOCKS} 个段落，请缩小选区后重试。`;
    }
    if (target.blockIds.length > 1 && !target.selectionRanges?.length) {
      return "当前格式无法精确定位跨段选区；仍可讨论，或改用 Word 文档后生成提案。";
    }
    return null;
  }
  if (target.blockId) return null;
  return "无法把选区定位到文档段落；请重新选择，或缩小选区。";
}

/** Drop table blocks from a multi-block selection, keeping the remaining order. */
export function filterEditableBlockIds(
  blockIds: string[],
  blocks: { id: string; kind: string }[],
  tableCell?: unknown,
): { editableIds: string[]; skippedTables: number } {
  if (tableCell) return { editableIds: blockIds, skippedTables: 0 };
  const editableIds = blockIds.filter(
    (id) => blocks.find((block) => block.id === id)?.kind !== "table",
  );
  return { editableIds, skippedTables: blockIds.length - editableIds.length };
}
