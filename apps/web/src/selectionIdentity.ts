import type { Block, Proposal } from "./api";

export type SelectionIdentity = {
  blockId: string;
  selectionText: string;
  selectionStart?: number;
  selectionRanges?: Array<{
    blockId: string;
    start: number;
    end: number;
    before: string;
  }>;
  tableCell?: {
    row: number;
    column: number;
    address: string;
    before: string;
  };
};

export function sameSelectionIdentity(
  left: SelectionIdentity,
  right: SelectionIdentity,
): boolean {
  if (left.blockId !== right.blockId) return false;
  const leftAddress = left.tableCell?.address;
  const rightAddress = right.tableCell?.address;
  if (leftAddress || rightAddress) return Boolean(leftAddress && leftAddress === rightAddress);
  const leftRanges = left.selectionRanges;
  const rightRanges = right.selectionRanges;
  if (leftRanges?.length || rightRanges?.length) {
    return Boolean(
      leftRanges &&
        rightRanges &&
        leftRanges.length === rightRanges.length &&
        leftRanges.every((range, index) => {
          const other = rightRanges[index];
          return Boolean(
            other &&
              range.blockId === other.blockId &&
              range.start === other.start &&
              range.end === other.end &&
              range.before === other.before,
          );
        }),
    );
  }
  return left.selectionStart === right.selectionStart && left.selectionText === right.selectionText;
}

export function selectionAnchorAlive(
  selection: SelectionIdentity,
  blocks: Array<Pick<Block, "id" | "text">>,
): boolean {
  const blockById = new Map(blocks.map((block) => [block.id, block.text]));
  if (selection.tableCell) {
    return blockById.get(selection.blockId)?.includes(selection.tableCell.before) ?? false;
  }

  if (selection.selectionRanges?.length) {
    return selection.selectionRanges.every((range) => {
      const text = blockById.get(range.blockId);
      return text !== undefined &&
        range.start >= 0 &&
        range.end >= range.start &&
        range.end <= text.length &&
        text.slice(range.start, range.end) === range.before;
    });
  }

  const text = blockById.get(selection.blockId);
  if (text === undefined) return false;
  if (!selection.selectionText) return true;
  if (selection.selectionStart !== undefined) {
    return text.slice(
      selection.selectionStart,
      selection.selectionStart + selection.selectionText.length,
    ) === selection.selectionText;
  }
  return text.includes(selection.selectionText);
}

export function proposalSelectionIdentity(proposal: Proposal): SelectionIdentity {
  if (proposal.tableCell) {
    return {
      blockId: proposal.blockId,
      selectionText: proposal.tableCell.before,
      tableCell: {
        row: proposal.tableCell.row,
        column: proposal.tableCell.column,
        address: proposal.tableCell.address,
        before: proposal.tableCell.before,
      },
    };
  }
  const selection = proposal.operation?.scope === "selection"
    ? proposal.operation.selection
    : undefined;
  return {
    blockId: proposal.blockId,
    selectionText: selection?.before ?? proposal.before,
    selectionStart: selection?.start,
  };
}

/** True when an open review thread already owns this exact selection (bubble should hide). */
export function selectionOwnedByOpenThread(
  thread: SelectionIdentity | null | undefined,
  selection: {
    blockId: string | null;
    text: string;
    selectionStart?: number;
    selectionRanges?: SelectionIdentity["selectionRanges"];
    tableCell?: SelectionIdentity["tableCell"];
  },
): boolean {
  if (!thread || !selection.blockId || !selection.text.trim()) return false;
  return sameSelectionIdentity(thread, {
    blockId: selection.blockId,
    selectionText: selection.text,
    selectionStart: selection.selectionStart,
    selectionRanges: selection.selectionRanges,
    tableCell: selection.tableCell,
  });
}

/** True when the live selection is a different span than the open thread (ignore precise-start drift). */
export function selectionClearlyDivergedFromThread(
  thread: SelectionIdentity | null | undefined,
  selection: {
    blockId: string | null;
    text: string;
    tableCell?: SelectionIdentity["tableCell"];
  },
): boolean {
  if (!thread || !selection.blockId || !selection.text.trim()) return false;
  const threadAddress = thread.tableCell?.address ?? null;
  const selectionAddress = selection.tableCell?.address ?? null;
  if (threadAddress || selectionAddress) {
    return thread.blockId !== selection.blockId || threadAddress !== selectionAddress;
  }
  return thread.blockId !== selection.blockId || thread.selectionText !== selection.text;
}

export function proposalMatchesSelection(
  proposal: Proposal,
  selection: SelectionIdentity,
): boolean {
  const proposalIdentity = proposalSelectionIdentity(proposal);
  if (selection.selectionRanges?.length && !proposal.tableCell) {
    const range = selection.selectionRanges.find((candidate) =>
      candidate.blockId === proposal.blockId,
    );
    if (!range) return false;
    if (proposal.operation?.scope === "selection") {
      return range.start === proposalIdentity.selectionStart &&
        range.before === proposalIdentity.selectionText;
    }
    return range.start === 0 &&
      range.end === proposal.before.length &&
      range.before === proposal.before;
  }
  return sameSelectionIdentity(proposalIdentity, selection);
}
