import type { Block, Comment, DocumentMeta, Proposal } from "../api";
import type { SelectionBlockRange } from "@margin/domain";

export type TableCellSelection = {
  row: number;
  column: number;
  address: string;
  before: string;
};

export type CanvasFocusRequest = {
  key: string;
  query: string;
  proposalId?: string;
  blockId?: string | null;
  tableCell?: TableCellSelection;
};

export type CanvasProps = {
  document: DocumentMeta;
  blocks: Block[];
  proposals: Proposal[];
  comments: Comment[];
  busy: boolean;
  statusLine?: string;
  activeProposalId?: string | null;
  focusRequest?: CanvasFocusRequest | null;
  onAccept: (proposalId: string) => void;
  onEdit: (proposalId: string, editedText: string) => void;
  onUndo: (proposalId: string) => void;
  onRewrite: (proposalId: string, blockId: string) => void;
  onSelectionChange: (info: {
    blockId: string | null;
    blockIds?: string[];
    selectionRanges?: SelectionBlockRange[];
    text: string;
    selectionStart?: number;
    tableCell?: TableCellSelection;
    anchor?: { x: number; y: number } | null;
  }) => void;
  onContextMenu: (info: {
    x: number;
    y: number;
    blockId: string | null;
    blockIds?: string[];
    selectionRanges?: SelectionBlockRange[];
    text: string;
    selectionStart?: number;
    tableCell?: TableCellSelection;
  }) => void;
  onDirtyChange: (dirty: boolean) => void;
  onDocumentSaved: (document: DocumentMeta, blocks: Block[]) => void;
  /** Registers the canvas save() so chat/agent actions can save-and-continue when dirty. */
  onSaveHandlerChange?: (save: (() => Promise<boolean>) | null) => void;
  onReadyChange?: (ready: boolean) => void;
  /** Office 修订标记被手动改动并强制还原后给出提示（仅 OfficeCanvas 触发）。 */
  onMarkNotice?: (text: string) => void;
  /** Bumped when the app-level selection is cleared; collapses the editor range. */
  clearSelectionSignal?: number;
};
