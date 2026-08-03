import type {
  BlockSnapshot,
  Proposal,
  ProposalOperationKind,
  ProposalTargetLanguage,
  SelectionBlockRange,
  TableCellChange,
  ReviewChecklistRunDraft,
} from "@margin/domain";

/** Product-level reasoning mode; auto omits provider-specific reasoning controls. */
export type ReasoningMode = "auto" | "fast" | "standard" | "deep";

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
  /** Host-verified UTF-16 ranges for every block covered by a precise selection. */
  selectionRanges?: SelectionBlockRange[];
  /** Maximum full-selection context accepted by the Host for this run. */
  selectionContextChars?: number;
  operation?: ProposalOperationKind;
  targetLanguage?: ProposalTargetLanguage;
  /** Host-verified table cell target. Direct mode may replace text only inside this cell. */
  tableCell?: Omit<TableCellChange, "after">;
  /** Host-read, bounded material excerpts available to a direct selection proposal. */
  sourceContext?: Array<{ sourceRef: string; text: string }>;
  /** Workspace Skill root used only to compile explicitly selected Quick Edit skills. */
  skillsRoot?: string;
  /** Persistently disabled Skills (workspace store off-set); auto = absent. */
  disabledSkills?: string[];
  /** Explicit one-turn Skills (structured ids) for this Quick Edit run. */
  selectedSkills?: string[];
  signal?: AbortSignal;
  /** Prefer single-shot LLM proposals over full pi tool loop (snappier UX). */
  preferSimple?: boolean;
  /** Product reasoning mode; explicit levels apply only to compatible/opted-in models. */
  reasoningMode?: ReasoningMode;
  /** Custom provider opt-in to reasoning controls (set after a passing connection test). */
  reasoningOptIn?: boolean;
  /** User-configured request timeout (ms); wins over env/profile fallback. */
  timeoutMs?: number;
  /** Total attempts for transient provider/transport failures. */
  retryAttempts?: number;
  /** Fixed delay between transient retries in milliseconds. */
  retryDelayMs?: number;
};

export type AgentComment = {
  id: string;
  /** Document owning this comment when produced by document tools. */
  documentId?: string;
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
  reviewChecklists?: ReviewChecklistRunDraft[];
  notes?: string[];
  /** Human-readable tool/step trail for UI. */
  steps?: string[];
  toolAudit?: import("./pi-loop.js").ToolAuditEvent[];
};
