import { randomUUID } from "node:crypto";
import { ProposalSchema, type ApplyEvent, type Decision, type DecisionKind, type Proposal, assertDecisionInput, canApply, contentHash, tableCellTextToApply, textToApply } from "@margin/domain";
import type { Workspace } from "./workspace-fs.js";
import {
  MAX_DOCUMENT_BYTES,
  blocksToMarkdown,
  enqueueDocumentMutation,
  getDocument,
  listBlocks,
  recoverNativeSaveJournals,
  resolveWorkspacePath,
} from "./workspace-fs.js";
import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { applyDocxParagraphEdits, applyDocxTableCellEdit, docxContentHash } from "./office-docx.js";

export function saveProposal(ws: Workspace, proposal: Proposal): void {
  const validated = ProposalSchema.parse(proposal);
  ws.db.prepare(
    `INSERT INTO proposals (
      id, document_id, block_id, base_revision, base_hash,
      before_text, after_text, rationale, risk, evidence_json, operation_json,
      table_cell_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    validated.id, validated.documentId, validated.blockId, validated.baseRevision, validated.baseHash,
    validated.before, validated.after, validated.rationale, validated.risk, JSON.stringify(validated.evidence),
    validated.operation ? JSON.stringify(validated.operation) : null,
    validated.tableCell ? JSON.stringify(validated.tableCell) : null,
    validated.status, validated.createdAt,
  );
}

function proposalFromRow(r: Record<string, unknown>): Proposal {
  return ProposalSchema.parse({
    schemaVersion: 1,
    id: String(r.id),
    documentId: String(r.document_id),
    blockId: String(r.block_id),
    baseRevision: Number(r.base_revision),
    baseHash: String(r.base_hash),
    before: String(r.before_text),
    after: String(r.after_text),
    rationale: String(r.rationale),
    risk: r.risk as Proposal["risk"],
    evidence: JSON.parse(String(r.evidence_json)) as string[],
    operation: r.operation_json
      ? JSON.parse(String(r.operation_json)) as Proposal["operation"]
      : undefined,
    tableCell: r.table_cell_json
      ? JSON.parse(String(r.table_cell_json)) as Proposal["tableCell"]
      : undefined,
    status: r.status as Proposal["status"],
    createdAt: String(r.created_at),
  });
}

export function listProposals(
  ws: Workspace,
  documentId: string,
  status?: string,
): Proposal[] {
  const rows = (status
    ? ws.db
        .prepare(
          `SELECT * FROM proposals
           WHERE document_id = ? AND status = ?
           ORDER BY created_at ASC`,
        )
        .all(documentId, status)
    : ws.db
        .prepare(`SELECT * FROM proposals WHERE document_id = ? ORDER BY created_at ASC`)
        .all(documentId)) as Array<Record<string, unknown>>;
  return rows.map(proposalFromRow);
}

export function getProposal(ws: Workspace, proposalId: string): Proposal {
  const row = ws.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(proposalId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error("proposal not found");
  return proposalFromRow(row);
}

/** Drop unfinished / undecided queue before a new proposal round. */
export function supersedeOpenProposals(ws: Workspace, documentId: string): number {
  const result = ws.db.prepare(
    `UPDATE proposals SET status = 'superseded'
     WHERE document_id = ? AND status IN ('proposed', 'draft')`,
  ).run(documentId);
  return Number(result.changes ?? 0);
}

export type StoredAgentComment = {
  id: string;
  documentId: string;
  blockId: string;
  text: string;
  severity: "info" | "warn";
  runId: string;
  source: string;
  createdAt: string;
};

/** Replace all comments for a document (new scan round). */
export function replaceDocumentComments(
  ws: Workspace,
  documentId: string,
  comments: Omit<StoredAgentComment, "documentId" | "createdAt">[],
): void {
  ws.db.prepare(`DELETE FROM agent_comments WHERE document_id = ?`).run(documentId);
  const insert = ws.db.prepare(
    `INSERT INTO agent_comments (
      id, document_id, block_id, text, severity, run_id, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const c of comments) {
    insert.run(c.id, documentId, c.blockId, c.text, c.severity, c.runId, c.source, now);
  }
}

export function listComments(ws: Workspace, documentId: string): StoredAgentComment[] {
  const rows = ws.db.prepare(
    `SELECT id, document_id, block_id, text, severity, run_id, source, created_at
     FROM agent_comments WHERE document_id = ? ORDER BY created_at ASC`,
  ).all(documentId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    documentId: String(r.document_id),
    blockId: String(r.block_id),
    text: String(r.text),
    severity: r.severity as "info" | "warn",
    runId: String(r.run_id),
    source: String(r.source),
    createdAt: String(r.created_at),
  }));
}

export function saveDecision(
  ws: Workspace, proposalId: string, kind: DecisionKind, editedText?: string, reason?: string,
  markProposalDecided = true,
): Decision {
  assertDecisionInput(kind, editedText);
  const proposal = getProposal(ws, proposalId);
  if (proposal.status !== "proposed") throw new Error("proposal not decidable");
  const decision: Decision = {
    schemaVersion: 1, id: randomUUID(), proposalId, kind,
    editedText: kind === "E" ? editedText : undefined, reason, createdAt: new Date().toISOString(),
  };
  ws.db.prepare("BEGIN IMMEDIATE").run();
  try {
    ws.db.prepare(
      `INSERT INTO decisions (id, proposal_id, kind, edited_text, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      decision.id, decision.proposalId, decision.kind, decision.editedText ?? null,
      decision.reason ?? null, decision.createdAt,
    );
    if (markProposalDecided) {
      ws.db.prepare(`UPDATE proposals SET status = 'decided' WHERE id = ?`).run(proposalId);
    }
    ws.db.prepare("COMMIT").run();
  } catch (e) {
    try { ws.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
    throw e;
  }
  return decision;
}

export function getLatestDecision(ws: Workspace, proposalId: string): Decision | undefined {
  const row = ws.db.prepare(
    `SELECT * FROM decisions WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(proposalId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return decisionFromRow(row);
}

export function supersedeProposal(ws: Workspace, proposalId: string): void {
  ws.db.prepare(
    `UPDATE proposals SET status = 'superseded'
     WHERE id = ? AND status IN ('proposed', 'decided', 'draft')`,
  ).run(proposalId);
}

export function rejectProposal(
  ws: Workspace,
  proposal: Proposal,
  decision: Decision,
): void {
  const document = getDocument(ws, proposal.documentId);
  ws.db.prepare("BEGIN IMMEDIATE").run();
  try {
    supersedeProposal(ws, proposal.id);
    ws.db.prepare(
      `INSERT INTO apply_events (
        id, document_id, proposal_id, decision_id, ok, reason,
        before_revision, after_revision, before_hash, after_hash, created_at
      ) VALUES (?, ?, ?, ?, 0, 'rejected', ?, NULL, ?, NULL, ?)`,
    ).run(
      randomUUID(),
      proposal.documentId,
      proposal.id,
      decision.id,
      document.revision,
      document.contentHash,
      new Date().toISOString(),
    );
    ws.db.prepare("COMMIT").run();
  } catch (error) {
    try { ws.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
    throw error;
  }
}

export function reopenProposal(ws: Workspace, proposalId: string): void {
  ws.db.prepare(
    `UPDATE proposals SET status = 'proposed'
     WHERE id = ? AND status IN ('decided', 'superseded')`,
  ).run(proposalId);
}

export function getLatestProposalApplyEvent(
  ws: Workspace,
  proposalId: string,
): Pick<ApplyEvent, "ok" | "reason" | "decisionId"> | undefined {
  const row = ws.db.prepare(
    `SELECT ok, reason, decision_id
     FROM apply_events WHERE proposal_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(proposalId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    ok: Boolean(row.ok),
    reason: row.reason == null ? undefined : row.reason as ApplyEvent["reason"],
    decisionId: String(row.decision_id),
  };
}

/** Resume proposal decisions that were committed before the host process stopped. */
export async function recoverDecidedProposals(ws: Workspace): Promise<void> {
  await recoverNativeSaveJournals(ws);
  await recoverApplyJournals(ws);
  const rows = ws.db.prepare(
    `SELECT * FROM proposals WHERE status = 'decided' ORDER BY created_at ASC, rowid ASC`,
  ).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const proposal = proposalFromRow(row);
    const decision = getLatestDecision(ws, proposal.id);
    if (!decision) {
      reopenProposal(ws, proposal.id);
      continue;
    }
    try {
      if (decision.kind === "N") {
        rejectProposal(ws, proposal, decision);
        continue;
      }
      const document = getDocument(ws, proposal.documentId);
      const result = await applyApproved(
        ws,
        proposal.documentId,
        document.revision,
        document.contentHash,
        [proposal.id],
      );
      if (!result.ok) reopenProposal(ws, proposal.id);
    } catch {
      // Keep the proposal visible and retryable if recovery cannot inspect/apply it.
      reopenProposal(ws, proposal.id);
    }
  }
}

export function supersedeOpenProposalsForBlocks(
  ws: Workspace,
  documentId: string,
  blockIds: string[],
  keepProposalIds: string[] = [],
): number {
  const ids = [...new Set(blockIds.filter(Boolean))];
  if (!ids.length) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const keepIds = [...new Set(keepProposalIds.filter(Boolean))];
  const keepClause = keepIds.length
    ? ` AND id NOT IN (${keepIds.map(() => "?").join(",")})`
    : "";
  const result = ws.db.prepare(
    `UPDATE proposals SET status = 'superseded'
     WHERE document_id = ? AND status IN ('proposed', 'draft')
       AND block_id IN (${placeholders})${keepClause}`,
  ).run(documentId, ...ids, ...keepIds);
  return Number(result.changes ?? 0);
}

function decisionFromRow(row: Record<string, unknown>): Decision {
  return {
    schemaVersion: 1, id: String(row.id), proposalId: String(row.proposal_id),
    kind: row.kind as DecisionKind,
    editedText: row.edited_text ? String(row.edited_text) : undefined,
    reason: row.reason ? String(row.reason) : undefined,
    createdAt: String(row.created_at),
  };
}

function latestDecisionsByProposal(
  ws: Workspace,
  proposalIds: string[],
): Map<string, Decision> {
  if (!proposalIds.length) return new Map();
  const placeholders = proposalIds.map(() => "?").join(", ");
  const rows = ws.db.prepare(
    `SELECT id, proposal_id, kind, edited_text, reason, created_at
     FROM (
       SELECT d.*,
              ROW_NUMBER() OVER (
                PARTITION BY d.proposal_id
                ORDER BY d.created_at DESC, d.rowid DESC
              ) AS latest_rank
       FROM decisions d
       WHERE d.proposal_id IN (${placeholders})
     )
     WHERE latest_rank = 1`,
  ).all(...proposalIds) as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => {
    const decision = decisionFromRow(row);
    return [decision.proposalId, decision];
  }));
}

function marginDir(root: string): string {
  return path.join(root, ".margin");
}

type ApplyJournal = {
  schemaVersion: 1;
  documentId: string;
  relativePath: string;
  beforeRevision: number;
  afterRevision: number;
  beforeHash: string;
  afterHash: string;
  updatedAt: string;
  blocks: ReturnType<typeof listBlocks>;
  proposalIds: string[];
  events: ApplyEvent[];
};

function saveApplyJournal(ws: Workspace, journal: ApplyJournal): void {
  ws.db.prepare(
    `INSERT INTO apply_journals (
      document_id, relative_path, before_hash, after_hash, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    journal.documentId,
    journal.relativePath,
    journal.beforeHash,
    journal.afterHash,
    JSON.stringify(journal),
    journal.updatedAt,
  );
}

function deleteApplyJournal(ws: Workspace, documentId: string): void {
  ws.db.prepare("DELETE FROM apply_journals WHERE document_id = ?").run(documentId);
}

function finalizeApplyJournal(ws: Workspace, journal: ApplyJournal): void {
  const current = getDocument(ws, journal.documentId);
  ws.db.prepare("BEGIN IMMEDIATE").run();
  try {
    if (
      current.revision !== journal.beforeRevision ||
      current.contentHash !== journal.beforeHash
    ) {
      throw new Error("apply journal base no longer matches the document index");
    }
    ws.db.prepare(`UPDATE documents SET revision=?, content_hash=?, updated_at=? WHERE id=?`)
      .run(journal.afterRevision, journal.afterHash, journal.updatedAt, journal.documentId);
    ws.db.prepare(`DELETE FROM blocks WHERE document_id = ?`).run(journal.documentId);
    const insertBlock = ws.db.prepare(
      `INSERT INTO blocks (document_id, id, kind, text, ord, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const block of journal.blocks) {
      insertBlock.run(
        journal.documentId,
        block.id,
        block.kind,
        block.text,
        block.order,
        block.contentHash,
      );
    }
    const supersede = ws.db.prepare(`UPDATE proposals SET status='superseded' WHERE id=?`);
    for (const proposalId of journal.proposalIds) supersede.run(proposalId);
    const insertEvent = ws.db.prepare(
      `INSERT INTO apply_events (
        id, document_id, proposal_id, decision_id, ok, reason,
        before_revision, after_revision, before_hash, after_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of journal.events) {
      insertEvent.run(
        event.id,
        event.documentId,
        event.proposalId,
        event.decisionId,
        event.ok ? 1 : 0,
        event.reason ?? null,
        event.beforeRevision,
        event.afterRevision ?? null,
        event.beforeHash,
        event.afterHash ?? null,
        event.createdAt,
      );
    }
    deleteApplyJournal(ws, journal.documentId);
    ws.db.prepare("COMMIT").run();
  } catch (error) {
    try { ws.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
    throw error;
  }
}

/** Finish an apply whose file replacement survived a host crash, or make it retryable. */
export async function recoverApplyJournals(ws: Workspace): Promise<void> {
  const rows = ws.db.prepare(
    "SELECT document_id, payload_json FROM apply_journals ORDER BY created_at ASC",
  ).all() as Array<{ document_id: string; payload_json: string }>;
  for (const row of rows) {
    const journal = JSON.parse(row.payload_json) as ApplyJournal;
    if (
      journal.schemaVersion !== 1 ||
      journal.documentId !== row.document_id ||
      !Array.isArray(journal.blocks) ||
      !Array.isArray(journal.proposalIds) ||
      !Array.isArray(journal.events)
    ) {
      throw new Error("invalid apply journal");
    }
    const absolutePath = resolveWorkspacePath(ws.root, journal.relativePath);
    if (!fs.existsSync(absolutePath)) {
      deleteApplyJournal(ws, journal.documentId);
      continue;
    }
    if (fs.statSync(absolutePath).size > MAX_DOCUMENT_BYTES) {
      throw new Error("document is too large (max 50 MiB)");
    }
    const diskBuffer = fs.readFileSync(absolutePath);
    const diskHash = /\.docx$/i.test(journal.relativePath)
      ? docxContentHash(diskBuffer)
      : contentHash(diskBuffer.toString("utf8").replace(/\r\n/g, "\n"));
    if (diskHash === journal.afterHash) {
      finalizeApplyJournal(ws, journal);
    } else {
      deleteApplyJournal(ws, journal.documentId);
    }
  }
}

type ApplyResult =
  | { ok: true; document: ReturnType<typeof getDocument>; blocks: ReturnType<typeof listBlocks> }
  | { ok: false; reason: string };

export function applyApproved(
  ws: Workspace,
  documentId: string,
  expectedRevision: number,
  expectedHash: string,
  proposalIds?: string[],
): Promise<ApplyResult> {
  return enqueueDocumentMutation(ws, documentId, () =>
    applyApprovedOnce(ws, documentId, expectedRevision, expectedHash, proposalIds),
  );
}

async function applyApprovedOnce(
  ws: Workspace,
  documentId: string,
  expectedRevision: number,
  expectedHash: string,
  proposalIds?: string[],
): Promise<ApplyResult> {
  const doc = getDocument(ws, documentId);
  if (doc.revision !== expectedRevision || doc.contentHash !== expectedHash) {
    return { ok: false, reason: "stale" };
  }

  const requestedIds = proposalIds !== undefined ? new Set(proposalIds) : null;
  const proposals = (requestedIds
    ? listProposals(ws, documentId).filter((proposal) =>
        requestedIds.has(proposal.id) && ["proposed", "decided"].includes(proposal.status),
      )
    : listProposals(ws, documentId, "decided"));
  if (!proposals.length) return { ok: false, reason: "nothing_to_apply" };
  const decisions = latestDecisionsByProposal(ws, proposals.map((proposal) => proposal.id));

  const abs = resolveWorkspacePath(ws.root, doc.relativePath);
  const isDocx = /\.docx$/i.test(doc.relativePath);
  if (fs.statSync(abs).size > MAX_DOCUMENT_BYTES) {
    throw new Error("document is too large (max 50 MiB)");
  }
  const diskBuffer = fs.readFileSync(abs);
  const diskRaw = isDocx ? "" : diskBuffer.toString("utf8");
  const diskHash = isDocx
    ? docxContentHash(diskBuffer)
    : contentHash(diskRaw.replace(/\r\n/g, "\n"));
  if (diskHash !== doc.contentHash) return { ok: false, reason: "external_change" };

  const blocks = listBlocks(ws, documentId);

  const blockMap = new Map(blocks.map((b) => [b.id, { ...b }]));
  const applied: Array<{ proposal: Proposal; decision: Decision }> = [];
  const failedEvents: ApplyEvent[] = [];
  for (const p of proposals) {
    const decision = decisions.get(p.id);
    if (!decision) continue;
    if (decision.kind === "N") {
      failedEvents.push({
        schemaVersion: 1, id: randomUUID(), documentId, proposalId: p.id, decisionId: decision.id,
        ok: false, reason: "rejected", beforeRevision: doc.revision, beforeHash: doc.contentHash,
        createdAt: new Date().toISOString(),
      });
      continue;
    }
    if (!canApply(p, decision)) continue;
    const nextText = textToApply(p, decision);
    if (nextText === null) continue;
    const block = blockMap.get(p.blockId);
    if (!block) {
      failedEvents.push({
        schemaVersion: 1, id: randomUUID(), documentId, proposalId: p.id, decisionId: decision.id,
        ok: false, reason: "missing", beforeRevision: doc.revision, beforeHash: doc.contentHash,
        createdAt: new Date().toISOString(),
      });
      continue;
    }
    if (block.contentHash !== p.baseHash) {
      failedEvents.push({
        schemaVersion: 1, id: randomUUID(), documentId, proposalId: p.id, decisionId: decision.id,
        ok: false, reason: "stale", beforeRevision: doc.revision, beforeHash: doc.contentHash,
        createdAt: new Date().toISOString(),
      });
      continue;
    }
    if (p.tableCell && (!isDocx || block.kind !== "table")) {
      failedEvents.push({
        schemaVersion: 1, id: randomUUID(), documentId, proposalId: p.id, decisionId: decision.id,
        ok: false, reason: "unsupported", beforeRevision: doc.revision, beforeHash: doc.contentHash,
        createdAt: new Date().toISOString(),
      });
      continue;
    }
    if (isDocx && block.kind === "table" && !p.tableCell) {
      failedEvents.push({
        schemaVersion: 1, id: randomUUID(), documentId, proposalId: p.id, decisionId: decision.id,
        ok: false, reason: "unsupported", beforeRevision: doc.revision, beforeHash: doc.contentHash,
        createdAt: new Date().toISOString(),
      });
      continue;
    }
    if (!p.tableCell) {
      block.text = nextText;
      block.contentHash = contentHash(nextText);
    }
    applied.push({ proposal: p, decision });
  }

  if (!applied.length) {
    ws.db.prepare("BEGIN IMMEDIATE").run();
    try {
      const supersede = ws.db.prepare(`UPDATE proposals SET status='superseded' WHERE id=?`);
      for (const p of proposals) {
        supersede.run(p.id);
      }
      const insertFailure = ws.db.prepare(
        `INSERT INTO apply_events (
          id, document_id, proposal_id, decision_id, ok, reason,
          before_revision, after_revision, before_hash, after_hash, created_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, NULL, ?)`,
      );
      for (const event of failedEvents) {
        insertFailure.run(
          event.id, event.documentId, event.proposalId, event.decisionId,
          event.reason ?? "missing", event.beforeRevision, event.beforeHash, event.createdAt,
        );
      }
      ws.db.prepare("COMMIT").run();
    } catch (e) {
      try { ws.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
      throw e;
    }
    return { ok: false, reason: "nothing_to_apply" };
  }

  let nextBlocks = [...blockMap.values()].sort((a, b) => a.order - b.order);
  let nextContent: string | Buffer;
  let nextHash: string;
  if (isDocx) {
    const paragraphEdits = applied.filter(({ proposal }) => !proposal.tableCell);
    const tableCellEdits = applied.filter(({ proposal }) => !!proposal.tableCell);
    const edits = new Map(paragraphEdits.map(({ proposal, decision }) => [
      proposal.blockId,
      textToApply(proposal, decision)!,
    ]));
    const operations = new Map(paragraphEdits.map(({ proposal }) => [
      proposal.blockId,
      proposal.operation,
    ]));
    let patched = edits.size
      ? await applyDocxParagraphEdits(diskBuffer, edits, operations)
      : { buffer: diskBuffer, blocks };
    for (const { proposal, decision } of tableCellEdits) {
      const cell = proposal.tableCell!;
      const nextText = tableCellTextToApply({
        ...proposal,
        applyMode: "host_table_cell_patch",
        cell,
      }, decision)!;
      patched = await applyDocxTableCellEdit(
        patched.buffer,
        proposal.blockId,
        cell.row,
        cell.column,
        cell.before,
        nextText,
      );
    }
    nextBlocks = patched.blocks;
    nextContent = patched.buffer;
    nextHash = docxContentHash(patched.buffer);
  } else {
    const nextMarkdown = blocksToMarkdown(nextBlocks);
    nextContent = nextMarkdown;
    nextHash = contentHash(nextMarkdown);
  }
  const latestBuffer = fs.readFileSync(abs);
  const latestHash = isDocx
    ? docxContentHash(latestBuffer)
    : contentHash(latestBuffer.toString("utf8").replace(/\r\n/g, "\n"));
  if (latestHash !== doc.contentHash) return { ok: false, reason: "external_change" };
  const nextRevision = doc.revision + 1;
  const now = new Date().toISOString();
  const events: ApplyEvent[] = [
    ...applied.map(({ proposal, decision }): ApplyEvent => ({
      schemaVersion: 1,
      id: randomUUID(),
      documentId,
      proposalId: proposal.id,
      decisionId: decision.id,
      ok: true,
      reason: "ok",
      beforeRevision: doc.revision,
      afterRevision: nextRevision,
      beforeHash: doc.contentHash,
      afterHash: nextHash,
      createdAt: now,
    })),
    ...failedEvents,
  ];
  const journal: ApplyJournal = {
    schemaVersion: 1,
    documentId,
    relativePath: doc.relativePath,
    beforeRevision: doc.revision,
    afterRevision: nextRevision,
    beforeHash: doc.contentHash,
    afterHash: nextHash,
    updatedAt: now,
    blocks: nextBlocks,
    proposalIds: proposals.map((proposal) => proposal.id),
    events,
  };
  const backupPath = path.join(
    marginDir(ws.root), "backups", `${path.basename(doc.relativePath)}.${doc.revision}.${Date.now()}.bak`,
  );
  saveApplyJournal(ws, journal);
  try {
    fs.copyFileSync(abs, backupPath);
    await writeFileAtomic(abs, nextContent, typeof nextContent === "string" ? "utf8" : undefined);
    finalizeApplyJournal(ws, journal);
  } catch (e) {
    try {
      await writeFileAtomic(abs, isDocx ? diskBuffer : diskRaw, isDocx ? undefined : "utf8");
      deleteApplyJournal(ws, documentId);
    } catch (restoreError) {
      throw new AggregateError(
        [e, restoreError],
        "apply transaction failed and the document could not be restored",
      );
    }
    throw e;
  }

  return {
    ok: true,
    document: {
      id: documentId, relativePath: doc.relativePath, revision: nextRevision,
      contentHash: nextHash, updatedAt: now,
    },
    blocks: nextBlocks,
  };
}

export function exportPacket(ws: Workspace, documentId: string) {
  const proposals = listProposals(ws, documentId);
  const decisions = latestDecisionsByProposal(ws, proposals.map((p) => p.id));
  return {
    schemaVersion: 1,
    document: getDocument(ws, documentId),
    blocks: listBlocks(ws, documentId),
    proposals,
    comments: listComments(ws, documentId),
    decisions: proposals.map((p) => decisions.get(p.id)).filter(Boolean),
  };
}

export type AgentTranscript = {
  id: string;
  documentId?: string;
  turnId: string;
  role: string;
  payload: unknown;
  createdAt: string;
};

export function saveAgentTranscript(
  ws: Workspace,
  transcript: Omit<AgentTranscript, "id" | "createdAt"> & Partial<Pick<AgentTranscript, "id" | "createdAt">>,
): AgentTranscript {
  const saved: AgentTranscript = {
    id: transcript.id ?? randomUUID(),
    documentId: transcript.documentId,
    turnId: transcript.turnId,
    role: transcript.role,
    payload: transcript.payload,
    createdAt: transcript.createdAt ?? new Date().toISOString(),
  };
  ws.db.prepare(
    `INSERT INTO agent_transcripts (id, document_id, turn_id, role, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    saved.id, saved.documentId ?? null, saved.turnId, saved.role,
    JSON.stringify(saved.payload), saved.createdAt,
  );
  ws.db.prepare(
    `DELETE FROM agent_transcripts
     WHERE id NOT IN (
       SELECT id FROM agent_transcripts ORDER BY created_at DESC, rowid DESC LIMIT 50
     )`,
  ).run();
  return saved;
}

export function listAgentTranscripts(ws: Workspace, limit = 20): AgentTranscript[] {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 50));
  const rows = ws.db.prepare(
    `SELECT * FROM agent_transcripts
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(safeLimit);
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    documentId: row.document_id === null ? undefined : String(row.document_id),
    turnId: String(row.turn_id),
    role: String(row.role),
    payload: JSON.parse(String(row.payload_json)),
    createdAt: String(row.created_at),
  }));
}

export type DocumentTimelineEntry = {
  id: string;
  createdAt: string;
  ok: boolean;
  reason: string | null;
  proposalId: string;
  decisionId: string;
  blockId: string | null;
  rationale: string | null;
  risk: string | null;
  decisionKind: string | null;
  operationKind: string | null;
  beforeText: string | null;
  afterText: string | null;
  beforeRevision: number;
  afterRevision: number | null;
};

function operationKindFromRow(operationJson: unknown): string | null {
  if (operationJson === null || operationJson === undefined) return null;
  try {
    const parsed = JSON.parse(String(operationJson)) as { kind?: unknown };
    return typeof parsed.kind === "string" ? parsed.kind : null;
  } catch {
    return null;
  }
}

/** Apply / decision history for a document (Git-for-documents light view). */
export function listDocumentTimeline(
  ws: Workspace,
  documentId: string,
  limit = 50,
): DocumentTimelineEntry[] {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 50, 200));
  const rows = ws.db
    .prepare(
      `SELECT
         e.id, e.created_at, e.ok, e.reason, e.proposal_id, e.decision_id,
         e.before_revision, e.after_revision,
         p.block_id, p.rationale, p.risk, p.before_text,
         COALESCE(d.edited_text, p.after_text) AS after_text, p.operation_json,
         d.kind AS decision_kind
       FROM apply_events e
       LEFT JOIN proposals p ON p.id = e.proposal_id
       LEFT JOIN decisions d ON d.id = e.decision_id
       WHERE e.document_id = ?
       ORDER BY e.created_at DESC, e.rowid DESC
       LIMIT ?`,
    )
    .all(documentId, safeLimit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    createdAt: String(row.created_at),
    ok: Number(row.ok) === 1,
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    proposalId: String(row.proposal_id),
    decisionId: String(row.decision_id),
    blockId: row.block_id === null || row.block_id === undefined ? null : String(row.block_id),
    rationale:
      row.rationale === null || row.rationale === undefined ? null : String(row.rationale),
    risk: row.risk === null || row.risk === undefined ? null : String(row.risk),
    decisionKind:
      row.decision_kind === null || row.decision_kind === undefined
        ? null
        : String(row.decision_kind),
    operationKind: operationKindFromRow(row.operation_json),
    beforeText:
      row.before_text === null || row.before_text === undefined
        ? null
        : String(row.before_text),
    afterText:
      row.after_text === null || row.after_text === undefined
        ? null
        : String(row.after_text),
    beforeRevision: Number(row.before_revision),
    afterRevision:
      row.after_revision === null || row.after_revision === undefined
        ? null
        : Number(row.after_revision),
  }));
}

