export type ChatSelectionError = {
  statusCode: 400 | 413;
  error: string;
};

/** Validate the exact selection before a chat turn reaches prompt construction. */
export function chatSelectionError(
  selectionText: unknown,
  contextLimit: number,
): ChatSelectionError | undefined {
  if (selectionText === undefined) return undefined;
  if (typeof selectionText !== "string") {
    return { statusCode: 400, error: "selectionText must be a string" };
  }
  if (!Number.isInteger(contextLimit) || contextLimit < 1) {
    throw new Error("invalid selection context limit");
  }
  if (selectionText.length <= contextLimit) return undefined;
  return {
    statusCode: 413,
    error: `选区超过当前上限 ${contextLimit} 字符，请在 Agent 设置中提高“选区上下文”，或缩小选区后重试；Margin 不会静默截断正文。`,
  };
}
