import type {
  BlockSnapshot,
  Proposal,
  ProposalOperationKind,
  ProposalTargetLanguage,
  TableCellChange,
} from "@margin/domain";

export type PaperAgentContext = {
  documentId: string;
  revision: number;
  blocks: BlockSnapshot[];
  harnessId?: string;
  /** User-directed rewrite instruction (selection “按指令重写”). */
  instruction?: string;
  /** Exact text selected inside the target block; direct mode only replaces this span. */
  selectionText?: string;
  /** UTF-16 offset inside the immutable block; disambiguates repeated selected text. */
  selectionStart?: number;
  operation?: ProposalOperationKind;
  targetLanguage?: ProposalTargetLanguage;
  /** Host-verified table cell target. Direct mode may replace text only inside this cell. */
  tableCell?: Omit<TableCellChange, "after">;
  /** Host-read, bounded material excerpts available to a direct selection proposal. */
  sourceContext?: Array<{ sourceRef: string; text: string }>;
  signal?: AbortSignal;
  /** Prefer single-shot LLM proposals over full pi tool loop (snappier UX). */
  preferSimple?: boolean;
};

export type AgentComment = {
  id: string;
  blockId: string;
  text: string;
  severity: "info" | "warn";
  source: "agent" | "heuristic";
  origin?: string;
  /** Session-scoped until host persists; tools never write FS/DB. */
  ephemeral: true;
};

export type ScanProgressEvent = {
  phase: string;
  tool?: string;
  detail?: string;
};

export type AgentWorkReport = {
  sourceRefs: string[];
  proposalCount: number;
  inspectedDocument: boolean;
  consistencyChecked: boolean;
};

export type ScanProgressHandler = (event: ScanProgressEvent) => void;

export type PaperAgentResult = {
  engine: "pi" | "simple";
  proposals: Omit<Proposal, "id" | "createdAt" | "status">[];
  comments?: AgentComment[];
  /** Set when requested engine was pi but simple ran instead. */
  fallbackFrom?: "pi";
  fallbackReason?: string;
  notes?: string[];
  /** Human-readable tool/step trail for UI. */
  steps?: string[];
};
