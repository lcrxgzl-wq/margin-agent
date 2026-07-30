import type { ChatMessage } from "./components/Chat";

export function documentIdSwitched(
  previousDocumentId: string | null | undefined,
  nextDocumentId: string | null | undefined,
): boolean {
  return Boolean(
    previousDocumentId && nextDocumentId && previousDocumentId !== nextDocumentId,
  );
}
export function clearChatAfterDirectDocumentOpen(
  previousDocumentId: string | null | undefined,
  nextDocumentId: string | null | undefined,
  setMessages: (messages: ChatMessage[]) => void,
): boolean {
  if (!documentIdSwitched(previousDocumentId, nextDocumentId)) return false;
  setMessages([]);
  return true;
}

export async function resyncChatAfterAgentDocumentOpen<T>(opts: {
  previousDocumentId: string | null | undefined;
  nextDocumentId: string | null | undefined;
  clearMessages: () => void;
  loadSnapshot: () => Promise<T>;
  applySnapshot: (snapshot: T) => Promise<void>;
}): Promise<boolean> {
  if (!documentIdSwitched(opts.previousDocumentId, opts.nextDocumentId)) return false;
  opts.clearMessages();
  const snapshot = await opts.loadSnapshot();
  await opts.applySnapshot(snapshot);
  return true;
}
