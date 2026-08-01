import { randomUUID } from "node:crypto";
import {
  ReviewChecklistDecisionSchema,
  ReviewChecklistItemSchema,
  ReviewChecklistRunDraftSchema,
  ReviewChecklistRunSchema,
  type ReviewChecklistDecision,
  type ReviewChecklistItem,
  type ReviewChecklistRun,
  type ReviewChecklistRunDraft,
} from "@margin/domain";
import type { Workspace } from "./workspace-fs.js";

export type StoredReviewChecklist = {
  run: ReviewChecklistRun;
  items: ReviewChecklistItem[];
};

export class ReviewChecklistValidationError extends Error {}
export class ReviewChecklistNotFoundError extends Error {}
export class ReviewChecklistConflictError extends Error {}

const initialized = new WeakSet<Workspace>();

export function initializeReviewChecklistStore(ws: Workspace): void {
  if (initialized.has(ws)) return;
  ws.db.exec(`
    CREATE TABLE IF NOT EXISTS review_checklist_runs (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      checker TEXT NOT NULL CHECK (checker IN ('cite_check', 'style_lint')),
      disclaimer TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_checklist_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      label TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      detail TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warn')),
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
      heuristic_only INTEGER NOT NULL,
      verification TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS review_checklist_decisions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      item_ids_json TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('resolve', 'dismiss')),
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_checklist_active_checker
      ON review_checklist_runs(document_id, checker) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_review_checklist_runs_document_created
      ON review_checklist_runs(document_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_checklist_items_run_status
      ON review_checklist_items(run_id, status, issue_type, block_id);
    CREATE INDEX IF NOT EXISTS idx_review_checklist_decisions_run_created
      ON review_checklist_decisions(run_id, created_at DESC);
  `);
  initialized.add(ws);
}

function runFromRow(row: Record<string, unknown>): ReviewChecklistRun {
  return ReviewChecklistRunSchema.parse({
    schemaVersion: 1,
    id: String(row.id),
    documentId: String(row.document_id),
    checker: row.checker,
    disclaimer: String(row.disclaimer),
    status: row.status,
    createdAt: String(row.created_at),
  });
}

function itemFromRow(row: Record<string, unknown>): ReviewChecklistItem {
  return ReviewChecklistItemSchema.parse({
    schemaVersion: 1,
    id: String(row.id),
    runId: String(row.run_id),
    documentId: String(row.document_id),
    blockId: String(row.block_id),
    issueType: String(row.issue_type),
    label: String(row.label),
    excerpt: String(row.excerpt),
    detail: String(row.detail),
    severity: row.severity,
    status: row.status,
    heuristicOnly: Boolean(row.heuristic_only),
    verification: row.verification == null ? undefined : String(row.verification),
    createdAt: String(row.created_at),
    decidedAt: row.decided_at == null ? undefined : String(row.decided_at),
  });
}

function listItemsForRun(ws: Workspace, runId: string): ReviewChecklistItem[] {
  const rows = ws.db.prepare(
    `SELECT * FROM review_checklist_items
     WHERE run_id = ? ORDER BY issue_type ASC, block_id ASC, created_at ASC, rowid ASC`,
  ).all(runId) as Array<Record<string, unknown>>;
  return rows.map(itemFromRow);
}

export function getReviewChecklist(
  ws: Workspace,
  runId: string,
): StoredReviewChecklist {
  initializeReviewChecklistStore(ws);
  const row = ws.db.prepare(
    "SELECT * FROM review_checklist_runs WHERE id = ?",
  ).get(runId) as Record<string, unknown> | undefined;
  if (!row) throw new ReviewChecklistNotFoundError("checklist run not found");
  return { run: runFromRow(row), items: listItemsForRun(ws, runId) };
}

export function listActiveReviewChecklists(
  ws: Workspace,
  documentId: string,
): StoredReviewChecklist[] {
  initializeReviewChecklistStore(ws);
  const rows = ws.db.prepare(
    `SELECT * FROM review_checklist_runs
     WHERE document_id = ? AND status = 'active'
     ORDER BY CASE checker WHEN 'cite_check' THEN 0 ELSE 1 END, created_at DESC`,
  ).all(documentId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const run = runFromRow(row);
    return { run, items: listItemsForRun(ws, run.id) };
  });
}

export function listReviewChecklistHistory(
  ws: Workspace,
  documentId: string,
): StoredReviewChecklist[] {
  initializeReviewChecklistStore(ws);
  const rows = ws.db.prepare(
    `SELECT * FROM review_checklist_runs
     WHERE document_id = ? ORDER BY created_at ASC, rowid ASC`,
  ).all(documentId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const run = runFromRow(row);
    return { run, items: listItemsForRun(ws, run.id) };
  });
}

export function saveReviewChecklistRun(
  ws: Workspace,
  input: ReviewChecklistRunDraft,
): ReviewChecklistRunDraft {
  initializeReviewChecklistStore(ws);
  const draft = ReviewChecklistRunDraftSchema.parse(input);
  ws.db.prepare("BEGIN IMMEDIATE").run();
  try {
    ws.db.prepare(
      `UPDATE review_checklist_runs SET status = 'superseded'
       WHERE document_id = ? AND checker = ? AND status = 'active'`,
    ).run(draft.run.documentId, draft.run.checker);
    ws.db.prepare(
      `INSERT INTO review_checklist_runs (
        id, document_id, checker, disclaimer, status, created_at
      ) VALUES (?, ?, ?, ?, 'active', ?)`,
    ).run(
      draft.run.id,
      draft.run.documentId,
      draft.run.checker,
      draft.run.disclaimer,
      draft.run.createdAt,
    );
    const insert = ws.db.prepare(
      `INSERT INTO review_checklist_items (
        id, run_id, document_id, block_id, issue_type, label, excerpt, detail,
        severity, status, heuristic_only, verification, created_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)`,
    );
    for (const item of draft.items) {
      insert.run(
        item.id,
        item.runId,
        item.documentId,
        item.blockId,
        item.issueType,
        item.label,
        item.excerpt,
        item.detail,
        item.severity,
        item.heuristicOnly ? 1 : 0,
        item.verification ?? null,
        item.createdAt,
      );
    }
    ws.db.prepare("COMMIT").run();
  } catch (error) {
    try { ws.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
    throw error;
  }
  return draft;
}

export function supersedeActiveReviewChecklists(
  ws: Workspace,
  documentId: string,
): number {
  initializeReviewChecklistStore(ws);
  const result = ws.db.prepare(
    `UPDATE review_checklist_runs SET status = 'superseded'
     WHERE document_id = ? AND status = 'active'`,
  ).run(documentId);
  return Number(result.changes ?? 0);
}

export function decideReviewChecklistItems(
  ws: Workspace,
  runId: string,
  itemIds: string[],
  kind: ReviewChecklistDecision["kind"],
): { decision: ReviewChecklistDecision; checklist: StoredReviewChecklist } {
  initializeReviewChecklistStore(ws);
  const decision = ReviewChecklistDecisionSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    runId,
    itemIds,
    kind,
    createdAt: new Date().toISOString(),
  });
  ws.db.prepare("BEGIN IMMEDIATE").run();
  try {
    const runRow = ws.db.prepare(
      "SELECT * FROM review_checklist_runs WHERE id = ?",
    ).get(runId) as Record<string, unknown> | undefined;
    if (!runRow) throw new ReviewChecklistNotFoundError("checklist run not found");
    const run = runFromRow(runRow);
    if (run.status !== "active") {
      throw new ReviewChecklistConflictError("checklist run is superseded");
    }

    const itemRows = decision.itemIds.map((itemId) => ws.db.prepare(
      "SELECT id, run_id, status FROM review_checklist_items WHERE id = ?",
    ).get(itemId) as { id: string; run_id: string; status: string } | undefined);
    if (itemRows.some((row) => !row)) {
      throw new ReviewChecklistNotFoundError("checklist item not found");
    }
    if (itemRows.some((row) => row!.run_id !== runId)) {
      throw new ReviewChecklistValidationError("checklist items must belong to one run");
    }
    if (itemRows.some((row) => row!.status !== "open")) {
      throw new ReviewChecklistConflictError("checklist item is already decided");
    }

    ws.db.prepare(
      `INSERT INTO review_checklist_decisions (id, run_id, item_ids_json, kind, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      decision.id,
      decision.runId,
      JSON.stringify(decision.itemIds),
      decision.kind,
      decision.createdAt,
    );
    const nextStatus = decision.kind === "resolve" ? "resolved" : "dismissed";
    const update = ws.db.prepare(
      `UPDATE review_checklist_items SET status = ?, decided_at = ?
       WHERE id = ? AND run_id = ? AND status = 'open'`,
    );
    for (const itemId of decision.itemIds) {
      const result = update.run(nextStatus, decision.createdAt, itemId, runId);
      if (Number(result.changes ?? 0) !== 1) {
        throw new ReviewChecklistConflictError("checklist item changed during decision");
      }
    }
    ws.db.prepare("COMMIT").run();
  } catch (error) {
    try { ws.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
    throw error;
  }
  return { decision, checklist: getReviewChecklist(ws, runId) };
}
