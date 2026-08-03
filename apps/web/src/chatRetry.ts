import type { SelectionBlockRange } from "@margin/domain";
import type { TableCellSelection } from "./components/canvasTypes";

export type ChatRetrySelection = {
  blockId: string | null;
  blockIds?: string[];
  selectionRanges?: SelectionBlockRange[];
  text: string;
  selectionStart?: number;
  tableCell?: TableCellSelection;
  crossTableCells?: boolean;
};

export type ChatRetryPayload = {
  failedUserMessageId: string;
  failedAssistantMessageId?: string;
  requestId: string;
  text: string;
  selectedSkills?: string[];
  threadId?: string;
  cascadeBlockIds?: string[];
  sourcePaths?: string[];
  chatMode?: "direct" | "socratic";
  harnessId?: string;
  selection: ChatRetrySelection;
  documentId?: string;
  documentRevision?: number;
};

export type ChatRetrySendOptions = {
  requestId: string;
  selectedSkills?: string[];
  threadId?: string;
  cascadeBlockIds?: string[];
  sourcePaths?: string[];
  chatMode?: "direct" | "socratic";
  harnessId?: string;
  selection: ChatRetrySelection;
};

type RetryMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  retry?: ChatRetryPayload;
};

type ExecutableChatRetryInput<T extends RetryMessage> = {
  messages: T[];
  currentDocument?: { id: string; revision: number };
  documentDirty: boolean;
  currentThreadIds: string[];
  errorMessageId?: string;
};

export function snapshotChatRetrySelection(
  selection: ChatRetrySelection,
): ChatRetrySelection {
  return {
    blockId: selection.blockId,
    blockIds: selection.blockIds ? [...selection.blockIds] : undefined,
    selectionRanges: selection.selectionRanges?.map((range) => ({ ...range })),
    text: selection.text,
    selectionStart: selection.selectionStart,
    tableCell: selection.tableCell ? { ...selection.tableCell } : undefined,
    crossTableCells: selection.crossTableCells,
  };
}

/** Replace the failed visible turn only while its document revision is current. */
export function prepareChatRetry<T extends RetryMessage>(
  messages: T[],
  errorMessageId: string,
  currentDocument?: { id: string; revision: number },
): {
    messages: T[];
    requestId: string;
    text: string;
    selectedSkills?: string[];
    threadId?: string;
    cascadeBlockIds?: string[];
    sourcePaths?: string[];
    chatMode?: "direct" | "socratic";
    harnessId?: string;
    selection: ChatRetrySelection;
} | null {
  const errorMessage = messages.at(-1);
  if (errorMessage?.id !== errorMessageId || !errorMessage.retry) return null;
  const retry = errorMessage.retry;
  if (
    (retry.documentId ?? null) !== (currentDocument?.id ?? null) ||
    (retry.documentRevision ?? null) !== (currentDocument?.revision ?? null)
  ) return null;
  if (!messages.some((message) =>
    message.id === retry.failedUserMessageId && message.role === "user"
  )) return null;
  return {
    messages: messages.filter((message) =>
      message.id !== errorMessageId &&
      message.id !== retry.failedUserMessageId &&
      message.id !== retry.failedAssistantMessageId
    ),
    requestId: retry.requestId,
    text: retry.text,
    selectedSkills: retry.selectedSkills?.length ? [...retry.selectedSkills] : undefined,
    threadId: retry.threadId,
    cascadeBlockIds: retry.cascadeBlockIds?.length ? [...retry.cascadeBlockIds] : undefined,
    sourcePaths: retry.sourcePaths ? [...retry.sourcePaths] : undefined,
    chatMode: retry.chatMode,
    harnessId: retry.harnessId,
    selection: snapshotChatRetrySelection(retry.selection),
  };
}

/** Resolve the one retry action that is both visible and executable right now. */
export function executableChatRetry<T extends RetryMessage>(
  input: ExecutableChatRetryInput<T>,
) {
  if (input.documentDirty) return null;
  const errorMessage = input.messages.at(-1);
  if (!errorMessage || (input.errorMessageId && errorMessage.id !== input.errorMessageId)) {
    return null;
  }
  const retry = prepareChatRetry(
    input.messages,
    errorMessage.id,
    input.currentDocument,
  );
  if (!retry) return null;
  if (retry.threadId && !input.currentThreadIds.includes(retry.threadId)) return null;
  return { errorMessageId: errorMessage.id, ...retry };
}

export async function retryFailedChat<T extends RetryMessage>(input: {
  messages: T[];
  errorMessageId: string;
  currentDocument?: { id: string; revision: number };
  documentDirty: boolean;
  currentThreadIds: string[];
  setMessages: (messages: T[]) => void;
  focusThread?: (threadId: string) => void;
  send: (text: string, options: ChatRetrySendOptions) => void | Promise<unknown>;
}): Promise<boolean> {
  const retry = executableChatRetry({
    messages: input.messages,
    errorMessageId: input.errorMessageId,
    currentDocument: input.currentDocument,
    documentDirty: input.documentDirty,
    currentThreadIds: input.currentThreadIds,
  });
  if (!retry) return false;
  if (retry.threadId) input.focusThread?.(retry.threadId);
  input.setMessages(retry.messages);
  await input.send(retry.text, {
    requestId: retry.requestId,
    selectedSkills: retry.selectedSkills,
    threadId: retry.threadId,
    cascadeBlockIds: retry.cascadeBlockIds,
    sourcePaths: retry.sourcePaths,
    chatMode: retry.chatMode,
    harnessId: retry.harnessId,
    selection: retry.selection,
  });
  return true;
}
