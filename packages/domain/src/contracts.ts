import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const DecisionKindSchema = z.enum(["Y", "N", "E"]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const RiskLevelSchema = z.enum(["language", "structure", "argument", "fact"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ProposalStatusSchema = z.enum([
  "draft",
  "proposed",
  "decided",
  "superseded",
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const BlockKindSchema = z.enum([
  "heading",
  "paragraph",
  "blockquote",
  "list_item",
  "code_block",
  "table",
]);
export type BlockKind = z.infer<typeof BlockKindSchema>;

export const BlockSnapshotSchema = z.object({
  id: z.string().min(1),
  kind: BlockKindSchema,
  text: z.string(),
  order: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
});
export type BlockSnapshot = z.infer<typeof BlockSnapshotSchema>;

export const SelectionCommandKindSchema = z.enum(["rewrite", "rewrite_directed", "discuss"]);
export type SelectionCommandKind = z.infer<typeof SelectionCommandKindSchema>;

export const ProposalOperationKindSchema = z.enum(["rewrite", "translate", "polish"]);
export type ProposalOperationKind = z.infer<typeof ProposalOperationKindSchema>;

export const ProposalTargetLanguageSchema = z.enum(["zh-CN", "en"]);
export type ProposalTargetLanguage = z.infer<typeof ProposalTargetLanguageSchema>;

function tableColumnAddress(column: number): string {
  let value = column;
  let address = "";
  while (value > 0) {
    value -= 1;
    address = String.fromCharCode(65 + (value % 26)) + address;
    value = Math.floor(value / 26);
  }
  return address;
}

export const TableCellSelectionSchema = z.object({
  address: z.string().regex(/^[A-Z]+[1-9]\d*$/),
  row: z.number().int().positive(),
  column: z.number().int().positive(),
  before: z.string(),
}).superRefine((cell, context) => {
  if (cell.address !== `${tableColumnAddress(cell.column)}${cell.row}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "table cell address does not match row and column" });
  }
});

export const TableCellChangeSchema = z.object({
  address: z.string().regex(/^[A-Z]+[1-9]\d*$/),
  row: z.number().int().positive(),
  column: z.number().int().positive(),
  before: z.string(),
  after: z.string().min(1),
}).superRefine((cell, context) => {
  if (cell.address !== `${tableColumnAddress(cell.column)}${cell.row}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "table cell address does not match row and column" });
  }
  if (cell.after === cell.before) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "table cell proposal must change the cell text" });
  }
});
export type TableCellChange = z.infer<typeof TableCellChangeSchema>;

export const TableCellProposalDraftSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  documentId: z.string().min(1),
  blockId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  baseHash: z.string().min(1),
  applyMode: z.literal("host_table_cell_patch"),
  cell: TableCellChangeSchema,
  rationale: z.string().min(1),
  risk: RiskLevelSchema.default("language"),
  evidence: z.array(z.string()).default([]),
});
export type TableCellProposalDraft = z.infer<typeof TableCellProposalDraftSchema>;

export const TableCellProposalSchema = z.intersection(
  TableCellProposalDraftSchema,
  z.object({
    id: z.string().min(1),
    status: ProposalStatusSchema,
    createdAt: z.string().datetime(),
  }),
);
export type TableCellProposal = z.infer<typeof TableCellProposalSchema>;

export const ProposalOperationSchema = z.object({
  kind: ProposalOperationKindSchema,
  scope: z.enum(["selection", "block"]),
  targetLanguage: ProposalTargetLanguageSchema.optional(),
  selection: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    before: z.string().min(1),
    after: z.string().min(1),
  }).optional(),
}).superRefine((operation, context) => {
  if (operation.kind === "translate" && !operation.targetLanguage) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "translation requires targetLanguage" });
  }
  if (operation.scope === "selection" && !operation.selection) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "selection operation requires a range" });
  }
  if (operation.scope === "block" && operation.selection) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "block operation cannot carry a selection" });
  }
  if (operation.selection) {
    const selection = operation.selection;
    if (selection.end !== selection.start + selection.before.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "selection range does not match before text" });
    }
  }
});
export type ProposalOperation = z.infer<typeof ProposalOperationSchema>;

export const SelectionCommandSchema = z.object({
  kind: SelectionCommandKindSchema,
  blockId: z.string().min(1),
  blockIds: z.array(z.string().min(1)).max(12).optional(),
  selectionText: z.string().optional(),
  selectionStart: z.number().int().nonnegative().optional(),
  instruction: z.string().max(600).optional(),
  operation: ProposalOperationKindSchema.optional(),
  targetLanguage: ProposalTargetLanguageSchema.optional(),
  tableCell: TableCellSelectionSchema.optional(),
});
export type SelectionCommand = z.infer<typeof SelectionCommandSchema>;

export const ProposalSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  documentId: z.string().min(1),
  blockId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  baseHash: z.string().min(1),
  before: z.string(),
  after: z.string(),
  rationale: z.string().min(1),
  risk: RiskLevelSchema.default("language"),
  evidence: z.array(z.string()).default([]),
  operation: ProposalOperationSchema.optional(),
  tableCell: TableCellChangeSchema.optional(),
  status: ProposalStatusSchema,
  createdAt: z.string().datetime(),
}).superRefine((proposal, context) => {
  if (proposal.tableCell) {
    if (proposal.operation) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "table cell proposal cannot carry a text operation" });
    }
    if (proposal.before !== proposal.tableCell.before || proposal.after !== proposal.tableCell.after) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "table cell proposal text does not match its cell change" });
    }
  }
  const selection = proposal.operation?.scope === "selection"
    ? proposal.operation.selection
    : undefined;
  if (!selection) return;
  if (proposal.before.slice(selection.start, selection.end) !== selection.before) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "proposal selection does not match before" });
    return;
  }
  const expected = `${proposal.before.slice(0, selection.start)}${selection.after}${proposal.before.slice(selection.end)}`;
  if (proposal.after !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "proposal after is not the selected replacement" });
  }
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const DecisionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  proposalId: z.string().min(1),
  kind: DecisionKindSchema,
  editedText: z.string().optional(),
  reason: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ApplyEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  documentId: z.string().min(1),
  proposalId: z.string().min(1),
  decisionId: z.string().min(1),
  ok: z.boolean(),
  reason: z.enum(["ok", "stale", "missing", "rejected", "unsupported"]).optional(),
  beforeRevision: z.number().int().nonnegative(),
  afterRevision: z.number().int().nonnegative().optional(),
  beforeHash: z.string(),
  afterHash: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type ApplyEvent = z.infer<typeof ApplyEventSchema>;

export const DocumentMetaSchema = z.object({
  id: z.string().min(1),
  relativePath: z.string().min(1),
  revision: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  updatedAt: z.string().datetime(),
});
export type DocumentMeta = z.infer<typeof DocumentMetaSchema>;

export const LlmProposalOutputSchema = z.object({
  blockId: z.string().min(1),
  after: z.string().min(1),
  rationale: z.string().min(1),
  risk: RiskLevelSchema.default("language"),
  evidence: z.array(z.string()).default([]),
});
export type LlmProposalOutput = z.infer<typeof LlmProposalOutputSchema>;

export function assertDecisionInput(kind: DecisionKind, editedText?: string): void {
  if (kind === "E" && (!editedText || editedText.trim().length === 0)) {
    throw new Error("E decision requires editedText");
  }
  if (kind !== "E" && editedText !== undefined && editedText.length > 0) {
    throw new Error("editedText is only allowed for E decisions");
  }
}

export function textToApply(proposal: Proposal, decision: Decision): string | null {
  if (decision.proposalId !== proposal.id) {
    throw new Error("decision/proposal mismatch");
  }
  if (decision.kind === "N") return null;
  if (decision.kind === "Y") return proposal.after;
  if (decision.kind === "E") {
    if (!decision.editedText) throw new Error("E missing editedText");
    return decision.editedText;
  }
  throw new Error("unknown decision");
}

export function tableCellTextToApply(
  proposal: TableCellProposal,
  decision: Decision,
): string | null {
  if (decision.proposalId !== proposal.id) throw new Error("decision/proposal mismatch");
  if (decision.kind === "N") return null;
  if (decision.kind === "Y") return proposal.cell.after;
  if (decision.kind === "E") {
    if (!decision.editedText) throw new Error("E missing editedText");
    return decision.editedText;
  }
  throw new Error("unknown decision");
}

export function canApply(proposal: Proposal, decision: Decision | undefined): boolean {
  if (!decision) return false;
  if (proposal.status !== "proposed" && proposal.status !== "decided") return false;
  return decision.kind === "Y" || decision.kind === "E";
}
