import type { Proposal } from "./api";

export type ProposalChange = {
  kind: "rewrite" | "translate" | "polish" | "table_cell";
  scope: "selection" | "block" | "table_cell";
  address?: string;
  beforeFragment: string;
  afterFragment: string;
  contextBefore: string;
  contextAfter: string;
  contextStartsMidway: boolean;
  contextEndsMidway: boolean;
  editValue: string;
  composeEditedText: (edited: string) => string;
};

function compactContext(text: string, start: number, end: number, radius = 42) {
  const contextStart = Math.max(0, start - radius);
  const contextEnd = Math.min(text.length, end + radius);
  return {
    contextBefore: text.slice(contextStart, start),
    contextAfter: text.slice(end, contextEnd),
    contextStartsMidway: contextStart > 0,
    contextEndsMidway: contextEnd < text.length,
  };
}

function changedRange(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd--;
    afterEnd--;
  }
  return { start, beforeEnd, afterEnd };
}

export function proposalChange(proposal: Proposal): ProposalChange {
  if (proposal.tableCell) {
    const cell = proposal.tableCell;
    if (proposal.before !== cell.before || proposal.after !== cell.after) {
      throw new Error("表格单元格提案数据不一致，已禁止处理。");
    }
    return {
      kind: "table_cell",
      scope: "table_cell",
      address: cell.address,
      beforeFragment: cell.before,
      afterFragment: cell.after,
      contextBefore: "",
      contextAfter: "",
      contextStartsMidway: false,
      contextEndsMidway: false,
      editValue: cell.after,
      composeEditedText: (edited) => edited,
    };
  }
  if (proposal.operation?.scope === "selection") {
    const selection = proposal.operation.selection;
    const valid = !!selection &&
      selection.end === selection.start + selection.before.length &&
      proposal.before.slice(selection.start, selection.end) === selection.before &&
      proposal.after ===
        `${proposal.before.slice(0, selection.start)}${selection.after}${proposal.before.slice(selection.end)}`;
    if (!selection || !valid) {
      throw new Error("选区提案数据不一致，已禁止按整段处理。");
    }
    return {
      kind: proposal.operation?.kind ?? "rewrite",
      scope: "selection",
      beforeFragment: selection.before,
      afterFragment: selection.after,
      ...compactContext(proposal.before, selection.start, selection.end),
      editValue: selection.after,
      composeEditedText: (edited) =>
        `${proposal.before.slice(0, selection.start)}${edited}${proposal.before.slice(selection.end)}`,
    };
  }

  const range = changedRange(proposal.before, proposal.after);
  return {
    kind: proposal.operation?.kind ?? "rewrite",
    scope: "block",
    beforeFragment: proposal.before.slice(range.start, range.beforeEnd),
    afterFragment: proposal.after.slice(range.start, range.afterEnd),
    ...compactContext(proposal.before, range.start, range.beforeEnd),
    editValue: proposal.after,
    composeEditedText: (edited) => edited,
  };
}
