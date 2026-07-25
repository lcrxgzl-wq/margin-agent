import { createContext, useContext } from "react";
import type { Comment, Proposal } from "./api";

export type PendingActions = {
  byBlock: Map<string, Proposal[]>;
  commentsByBlock: Map<string, Comment[]>;
  onAccept: (proposalId: string) => void;
  onEdit: (proposalId: string, editedText: string) => void;
  onUndo: (proposalId: string) => void;
  onRewrite: (proposalId: string, blockId: string) => void;
  busy: boolean;
};

export const PendingContext = createContext<PendingActions>({
  byBlock: new Map(),
  commentsByBlock: new Map(),
  onAccept: () => undefined,
  onEdit: () => undefined,
  onUndo: () => undefined,
  onRewrite: () => undefined,
  busy: false,
});

export function usePending() {
  return useContext(PendingContext);
}
