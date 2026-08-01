import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { type BlockSnapshot, type DocumentMeta, contentHash } from "@margin/domain";
import {
  initializeReviewChecklistStore,
  supersedeActiveReviewChecklists,
} from "./checklist-store.js";
import {
  applyDocxPreservingEdits,
  docxContentHash,
  extractDocxBlocks,
  readDocxTableCell,
} from "./office-docx.js";

export type Workspace = {
  root: string;
  db: DatabaseSync;
  releaseLock: () => Promise<void>;
};

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

function assertDocumentFileSize(absolutePath: string): void {
  if (fs.statSync(absolutePath).size > MAX_DOCUMENT_BYTES) {
    throw new Error("document is too large (max 50 MiB)");
  }
}

const documentMutationTails = new WeakMap<Workspace, Map<string, Promise<void>>>();

/** Serialize human saves and Agent applies for one registered document. */
export function enqueueDocumentMutation<T>(
  ws: Workspace,
  documentId: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const tails = documentMutationTails.get(ws) ?? new Map<string, Promise<void>>();
  documentMutationTails.set(ws, tails);
  const previous = tails.get(documentId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  tails.set(documentId, tail);
  return result.finally(() => {
    if (tails.get(documentId) === tail) tails.delete(documentId);
    if (!tails.size) documentMutationTails.delete(ws);
  });
}

function marginDir(root: string): string {
  return path.join(root, ".margin");
}

function canonicalizePath(candidate: string): string {
  if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  const missing: string[] = [];
  let ancestor = candidate;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("path escapes workspace");
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), ...missing);
}

function samePathOrFile(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(left) === normalize(right)) return true;
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const a = fs.statSync(left);
  const b = fs.statSync(right);
  return a.dev === b.dev && a.ino !== 0 && a.ino === b.ino;
}

function visibleRelativePath(root: string, absolutePath: string): string {
  const rel = path.relative(fs.realpathSync(root), absolutePath).replace(/\\/g, "/");
  const segments = rel.split("/");
  if (
    !rel ||
    segments.some((segment) => segment.startsWith(".")) ||
    segments.some((segment) => segment === "node_modules" || segment === "dist")
  ) {
    throw new Error("hidden or internal paths are not allowed");
  }
  return rel;
}

function assertSingleLinkFile(absolutePath: string): void {
  if (!fs.existsSync(absolutePath)) return;
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) throw new Error("not a file");
  if (stat.nlink > 1) throw new Error("hard-linked files are not allowed");
}

function ensureWorkspaceMetadataDirectory(root: string, relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  if (fs.existsSync(absolutePath)) {
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("workspace metadata directories must not be links");
    }
  } else {
    fs.mkdirSync(absolutePath);
  }
  return resolveWorkspacePath(root, relativePath);
}

function resolveWorkspaceMetadataFile(root: string, relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  if (fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isSymbolicLink()) {
    throw new Error("workspace metadata files must not be links");
  }
  const resolved = resolveWorkspacePath(root, relativePath);
  assertSingleLinkFile(resolved);
  return resolved;
}

/** Resolve a relative path and ensure it stays inside workspace root. */
export function resolveWorkspacePath(root: string, candidate: string): string {
  if (!candidate || typeof candidate !== "string") {
    throw new Error("path escapes workspace");
  }
  const normalized = candidate.replace(/\\/g, "/");
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    throw new Error("path escapes workspace");
  }
  if (normalized.split("/").some((seg) => seg === "..")) {
    throw new Error("path escapes workspace");
  }

  const resolvedRoot = fs.realpathSync(root);
  const resolvedCandidate = path.resolve(root, candidate);
  const resolved = canonicalizePath(resolvedCandidate);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes workspace");
  }
  return resolved;
}

function assertInsideWorkspace(root: string, candidate: string): string {
  return resolveWorkspacePath(root, candidate);
}

export async function openWorkspace(rootInput: string): Promise<Workspace> {
  const requestedRoot = path.resolve(rootInput);
  fs.mkdirSync(requestedRoot, { recursive: true });
  const root = fs.realpathSync(requestedRoot);
  ensureWorkspaceMetadataDirectory(root, ".margin");
  ensureWorkspaceMetadataDirectory(root, ".margin/backups");

  const lockPath = resolveWorkspaceMetadataFile(root, ".margin/workspace.lock");
  const databasePath = resolveWorkspaceMetadataFile(root, ".margin/margin.db");
  fs.writeFileSync(lockPath, "", { flag: "a" });
  const releaseLock = await lockfile.lock(lockPath, {
    retries: { retries: 5, minTimeout: 200, maxTimeout: 1000 },
    stale: 5_000,
  });

  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blocks (
      document_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      ord INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (document_id, id)
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      base_hash TEXT NOT NULL,
      before_text TEXT NOT NULL,
      after_text TEXT NOT NULL,
      rationale TEXT NOT NULL,
      risk TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      edited_text TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposal_resolution_batches (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      proposal_ids_json TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      expected_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS apply_events (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      ok INTEGER NOT NULL,
      reason TEXT,
      before_revision INTEGER NOT NULL,
      after_revision INTEGER,
      before_hash TEXT NOT NULL,
      after_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS apply_journals (
      document_id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      before_hash TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS native_save_journals (
      document_id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      before_hash TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_comments (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      text TEXT NOT NULL,
      severity TEXT NOT NULL,
      run_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_transcripts (
      id TEXT PRIMARY KEY,
      document_id TEXT,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_transcripts_created ON agent_transcripts(created_at);
    CREATE INDEX IF NOT EXISTS idx_proposals_document_status_created
      ON proposals(document_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_decisions_proposal_created
      ON decisions(proposal_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_apply_events_document_created
      ON apply_events(document_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_comments_document_created
      ON agent_comments(document_id, created_at);
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_session_history (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_usage (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      path TEXT NOT NULL,
      model TEXT NOT NULL,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      request_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_usage_ts ON model_usage(ts);
  `);

  const proposalColumns = db.prepare("PRAGMA table_info(proposals)").all() as Array<{ name: string }>;
  if (!proposalColumns.some((column) => column.name === "operation_json")) {
    db.exec("ALTER TABLE proposals ADD COLUMN operation_json TEXT");
  }
  if (!proposalColumns.some((column) => column.name === "table_cell_json")) {
    db.exec("ALTER TABLE proposals ADD COLUMN table_cell_json TEXT");
  }

  const workspace = { root, db, releaseLock };
  initializeReviewChecklistStore(workspace);
  return workspace;
}

export function chunkMarkdown(text: string): BlockSnapshot[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const parts = normalized.split(/\n{2,}/);
  const blocks: BlockSnapshot[] = [];
  const idCounts = new Map<string, number>();
  let order = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    let kind: BlockSnapshot["kind"] = "paragraph";
    if (/^#{1,6}\s/.test(trimmed)) kind = "heading";
    else if (/^>\s?/m.test(trimmed)) kind = "blockquote";
    else if (/^```/.test(trimmed)) kind = "code_block";
    else if (/^([-*+]|\d+\.)\s/.test(trimmed)) kind = "list_item";
    const baseId = `b${createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 12)}`;
    const occurrence = (idCounts.get(baseId) ?? 0) + 1;
    idCounts.set(baseId, occurrence);
    const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
    blocks.push({ id, kind, text: trimmed, order, contentHash: contentHash(trimmed) });
    order += 1;
  }
  return blocks;
}

export function blocksToMarkdown(blocks: BlockSnapshot[]): string {
  return blocks
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((b) => b.text)
    .join("\n\n")
    .concat("\n");
}

function upsertDocumentIndex(
  ws: Workspace,
  canonicalRelativePath: string,
  hash: string,
  blocks: BlockSnapshot[],
): DocumentMeta {
  const now = new Date().toISOString();
  const existing = ws.db
    .prepare("SELECT id, revision, content_hash, updated_at FROM documents WHERE relative_path = ?")
    .get(canonicalRelativePath) as
      | { id: string; revision: number; content_hash: string; updated_at: string }
      | undefined;
  if (existing?.content_hash === hash) {
    return {
      id: existing.id,
      relativePath: canonicalRelativePath,
      revision: existing.revision,
      contentHash: hash,
      updatedAt: existing.updated_at,
    };
  }
  const id = existing?.id ?? randomUUID();
  const revision = existing ? existing.revision + 1 : 0;

  try {
    ws.db.prepare("BEGIN IMMEDIATE").run();
    if (existing) {
      ws.db.prepare(`UPDATE documents SET revision=?, content_hash=?, updated_at=? WHERE id=?`)
        .run(revision, hash, now, id);
    } else {
      ws.db.prepare(
        `INSERT INTO documents (id, relative_path, revision, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, canonicalRelativePath, revision, hash, now);
    }
    ws.db.prepare("DELETE FROM blocks WHERE document_id = ?").run(id);
    const insert = ws.db.prepare(
      `INSERT INTO blocks (document_id, id, kind, text, ord, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const block of blocks) {
      insert.run(id, block.id, block.kind, block.text, block.order, block.contentHash);
    }
    if (existing) {
      ws.db.prepare(
        `UPDATE proposals SET status='superseded'
         WHERE document_id=? AND status IN ('draft', 'proposed', 'decided')`,
      ).run(id);
      supersedeActiveReviewChecklists(ws, id);
    }
    ws.db.prepare("COMMIT").run();
  } catch (error) {
    try { ws.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
    throw error;
  }
  return { id, relativePath: canonicalRelativePath, revision, contentHash: hash, updatedAt: now };
}

export function openDocument(ws: Workspace, relativePath: string): DocumentMeta {
  if (!/\.(md|markdown)$/i.test(relativePath)) {
    throw new Error("only Markdown documents can be opened");
  }
  const abs = assertInsideWorkspace(ws.root, relativePath);
  const canonicalRelativePath = visibleRelativePath(ws.root, abs);
  if (!fs.existsSync(abs)) throw new Error("file not found");
  assertSingleLinkFile(abs);
  assertDocumentFileSize(abs);
  const raw = fs.readFileSync(abs, "utf8");
  const hash = contentHash(raw.replace(/\r\n/g, "\n"));
  const blocks = chunkMarkdown(raw);
  return upsertDocumentIndex(ws, canonicalRelativePath, hash, blocks);
}

export async function openDocxDocument(ws: Workspace, relativePath: string): Promise<DocumentMeta> {
  if (!/\.docx$/i.test(relativePath)) throw new Error("only DOCX documents can be opened");
  const abs = assertInsideWorkspace(ws.root, relativePath);
  const canonicalRelativePath = visibleRelativePath(ws.root, abs);
  if (!fs.existsSync(abs)) throw new Error("file not found");
  assertSingleLinkFile(abs);
  assertDocumentFileSize(abs);
  const buffer = fs.readFileSync(abs);
  const blocks = await extractDocxBlocks(buffer);
  return upsertDocumentIndex(ws, canonicalRelativePath, docxContentHash(buffer), blocks);
}

export async function openDocumentFile(ws: Workspace, relativePath: string): Promise<DocumentMeta> {
  if (/\.docx$/i.test(relativePath)) return openDocxDocument(ws, relativePath);
  if (/\.(md|markdown)$/i.test(relativePath)) return openDocument(ws, relativePath);
  throw new Error(
    "open_document only supports Markdown (.md/.markdown) and Word (.docx); use read_workspace_file for pdf/txt/csv",
  );
}

export function readNativeDocx(ws: Workspace, documentId: string): Buffer {
  const document = getDocument(ws, documentId);
  if (!/\.docx$/i.test(document.relativePath)) throw new Error("document is not DOCX");
  const absolutePath = assertInsideWorkspace(ws.root, document.relativePath);
  assertSingleLinkFile(absolutePath);
  assertDocumentFileSize(absolutePath);
  return fs.readFileSync(absolutePath);
}

export async function readNativeDocxTableCell(
  ws: Workspace,
  documentId: string,
  blockId: string,
  row: number,
  column: number,
): Promise<{ address: string; text: string } | undefined> {
  return readDocxTableCell(readNativeDocx(ws, documentId), blockId, row, column);
}

export type SaveNativeDocxResult =
  | {
      ok: true;
      document: DocumentMeta;
      blocks: BlockSnapshot[];
      saveMode: "ooxml_patch" | "rebuilt";
    }
  | { ok: false; reason: "stale" | "external_change" | "rebuild_required"; detail?: string };

type NativeSaveJournal = {
  schemaVersion: 1;
  documentId: string;
  relativePath: string;
  beforeRevision: number;
  afterRevision: number;
  beforeHash: string;
  afterHash: string;
  updatedAt: string;
  blocks: BlockSnapshot[];
};

function saveNativeSaveJournal(ws: Workspace, journal: NativeSaveJournal): void {
  ws.db.prepare(
    `INSERT INTO native_save_journals (
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

function deleteNativeSaveJournal(ws: Workspace, documentId: string): void {
  ws.db.prepare("DELETE FROM native_save_journals WHERE document_id = ?").run(documentId);
}

function finalizeNativeSaveJournal(ws: Workspace, journal: NativeSaveJournal): void {
  const current = getDocument(ws, journal.documentId);
  ws.db.prepare("BEGIN IMMEDIATE").run();
  try {
    if (
      current.revision !== journal.beforeRevision ||
      current.contentHash !== journal.beforeHash
    ) {
      throw new Error("native save journal base no longer matches the document index");
    }
    ws.db.prepare(`UPDATE documents SET revision=?, content_hash=?, updated_at=? WHERE id=?`)
      .run(journal.afterRevision, journal.afterHash, journal.updatedAt, journal.documentId);
    ws.db.prepare("DELETE FROM blocks WHERE document_id = ?").run(journal.documentId);
    const insert = ws.db.prepare(
      `INSERT INTO blocks (document_id, id, kind, text, ord, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const block of journal.blocks) {
      insert.run(
        journal.documentId,
        block.id,
        block.kind,
        block.text,
        block.order,
        block.contentHash,
      );
    }
    ws.db.prepare(
      `UPDATE proposals SET status='superseded'
       WHERE document_id=? AND status IN ('draft', 'proposed', 'decided')`,
    ).run(journal.documentId);
    supersedeActiveReviewChecklists(ws, journal.documentId);
    deleteNativeSaveJournal(ws, journal.documentId);
    ws.db.prepare("COMMIT").run();
  } catch (error) {
    try { ws.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
    throw error;
  }
}

/** Finish a human DOCX save whose file replacement survived a host crash. */
export async function recoverNativeSaveJournals(ws: Workspace): Promise<void> {
  const rows = ws.db.prepare(
    "SELECT document_id, payload_json FROM native_save_journals ORDER BY created_at ASC",
  ).all() as Array<{ document_id: string; payload_json: string }>;
  for (const row of rows) {
    const journal = JSON.parse(row.payload_json) as NativeSaveJournal;
    if (
      journal.schemaVersion !== 1 ||
      journal.documentId !== row.document_id ||
      !Array.isArray(journal.blocks)
    ) {
      throw new Error("invalid native save journal");
    }
    const absolutePath = resolveWorkspacePath(ws.root, journal.relativePath);
    if (!fs.existsSync(absolutePath)) {
      deleteNativeSaveJournal(ws, journal.documentId);
      continue;
    }
    assertDocumentFileSize(absolutePath);
    const diskHash = docxContentHash(fs.readFileSync(absolutePath));
    if (diskHash === journal.afterHash) {
      finalizeNativeSaveJournal(ws, journal);
    } else {
      deleteNativeSaveJournal(ws, journal.documentId);
    }
  }
}

/** Save a human-edited DOCX. Agent writes continue to use proposal + Accept/CAS. */
export async function saveNativeDocx(
  ws: Workspace,
  documentId: string,
  expectedRevision: number,
  expectedHash: string,
  buffer: Buffer,
  saveMode: "preserve" | "rebuild" = "preserve",
  changedBlockIds?: ReadonlySet<string>,
): Promise<SaveNativeDocxResult> {
  return enqueueDocumentMutation(ws, documentId, () => saveNativeDocxOnce(
    ws, documentId, expectedRevision, expectedHash, buffer, saveMode, changedBlockIds,
  ));
}

async function saveNativeDocxOnce(
  ws: Workspace,
  documentId: string,
  expectedRevision: number,
  expectedHash: string,
  buffer: Buffer,
  saveMode: "preserve" | "rebuild" = "preserve",
  changedBlockIds?: ReadonlySet<string>,
): Promise<SaveNativeDocxResult> {
  const document = getDocument(ws, documentId);
  if (!/\.docx$/i.test(document.relativePath)) throw new Error("document is not DOCX");
  if (document.revision !== expectedRevision || document.contentHash !== expectedHash) {
    return { ok: false, reason: "stale" };
  }
  if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("DOCX file is too large (max 50 MiB)");
  }

  const absolutePath = assertInsideWorkspace(ws.root, document.relativePath);
  assertDocumentFileSize(absolutePath);
  const previousBuffer = fs.readFileSync(absolutePath);
  if (docxContentHash(previousBuffer) !== document.contentHash) {
    return { ok: false, reason: "external_change" };
  }
  let blocks = await extractDocxBlocks(buffer);
  const previousBlocks = listBlocks(ws, documentId);
  if (previousBlocks.length > 0 && blocks.length === 0) {
    throw new Error("refused to replace a non-empty DOCX with an empty document");
  }
  let nextBuffer = buffer;
  let appliedMode: "ooxml_patch" | "rebuilt" = "rebuilt";
  if (saveMode === "preserve") {
    let detail: string | undefined;
    const patched = await applyDocxPreservingEdits(
      previousBuffer,
      buffer,
      changedBlockIds,
      (reason) => { detail = reason; },
    );
    if (!patched) return { ok: false, reason: "rebuild_required", detail };
    nextBuffer = patched.buffer;
    blocks = patched.blocks;
    appliedMode = "ooxml_patch";
  }
  const latestBuffer = fs.readFileSync(absolutePath);
  if (docxContentHash(latestBuffer) !== document.contentHash) {
    return { ok: false, reason: "external_change" };
  }
  const nextHash = docxContentHash(nextBuffer);
  const nextRevision = document.revision + 1;
  const now = new Date().toISOString();
  const journal: NativeSaveJournal = {
    schemaVersion: 1,
    documentId,
    relativePath: document.relativePath,
    beforeRevision: document.revision,
    afterRevision: nextRevision,
    beforeHash: document.contentHash,
    afterHash: nextHash,
    updatedAt: now,
    blocks,
  };
  const backupPath = path.join(
    marginDir(ws.root),
    "backups",
    `${path.basename(document.relativePath)}.${document.revision}.${Date.now()}.bak`,
  );
  saveNativeSaveJournal(ws, journal);
  try {
    fs.copyFileSync(absolutePath, backupPath);
    await writeFileAtomic(absolutePath, nextBuffer);
    finalizeNativeSaveJournal(ws, journal);
  } catch (error) {
    try {
      await writeFileAtomic(absolutePath, previousBuffer);
      deleteNativeSaveJournal(ws, documentId);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "DOCX save failed and the document could not be restored",
      );
    }
    throw error;
  }

  return {
    ok: true,
    document: {
      ...document,
      revision: nextRevision,
      contentHash: nextHash,
      updatedAt: now,
    },
    blocks,
    saveMode: appliedMode,
  };
}

/** Re-index DOCX files changed while the host was stopped or between file/DB commit. */
export async function reconcileRegisteredDocxDocuments(ws: Workspace): Promise<number> {
  const rows = ws.db.prepare(
    `SELECT id, relative_path AS relativePath, revision, content_hash AS contentHash
     FROM documents WHERE lower(relative_path) LIKE '%.docx'`,
  ).all() as Array<Pick<DocumentMeta, "id" | "relativePath" | "revision" | "contentHash">>;
  let reconciled = 0;
  for (const document of rows) {
    const absolutePath = assertInsideWorkspace(ws.root, document.relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    assertDocumentFileSize(absolutePath);
    const buffer = fs.readFileSync(absolutePath);
    const diskHash = docxContentHash(buffer);
    if (diskHash === document.contentHash) continue;
    const blocks = await extractDocxBlocks(buffer);
    if (!blocks.length) continue;
    const nextRevision = document.revision + 1;
    const now = new Date().toISOString();
    ws.db.prepare("BEGIN IMMEDIATE").run();
    try {
      ws.db.prepare(`UPDATE documents SET revision=?, content_hash=?, updated_at=? WHERE id=?`)
        .run(nextRevision, diskHash, now, document.id);
      ws.db.prepare("DELETE FROM blocks WHERE document_id = ?").run(document.id);
      const insert = ws.db.prepare(
        `INSERT INTO blocks (document_id, id, kind, text, ord, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const block of blocks) {
        insert.run(document.id, block.id, block.kind, block.text, block.order, block.contentHash);
      }
      ws.db.prepare(
        `UPDATE proposals SET status='superseded'
         WHERE document_id=? AND status IN ('draft', 'proposed', 'decided')`,
      ).run(document.id);
      supersedeActiveReviewChecklists(ws, document.id);
      ws.db.prepare("COMMIT").run();
      reconciled += 1;
    } catch (error) {
      try { ws.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
      throw error;
    }
  }
  return reconciled;
}

/** Relative paths of documents registered in the review store (canonical). */
export function listRegisteredDocumentPaths(ws: Workspace): string[] {
  const rows = ws.db
    .prepare("SELECT relative_path FROM documents ORDER BY relative_path")
    .all() as Array<{ relative_path: string }>;
  return rows.map((r) => r.relative_path.replace(/\\/g, "/"));
}

/** Refuse overwriting a path that is already a registered paper document. */
export function assertNotRegisteredDocumentWrite(
  ws: Workspace,
  relativePath: string,
): void {
  const candidate = resolveWorkspacePath(ws.root, relativePath);
  const protectedPath = listRegisteredDocumentPaths(ws).find((registered) =>
    samePathOrFile(candidate, resolveWorkspacePath(ws.root, registered)),
  );
  if (protectedPath) {
    throw new Error(
      `Refused to overwrite canonical document "${protectedPath}". Open it and use proposals / Accept.`,
    );
  }
}

export function getDocument(ws: Workspace, documentId: string): DocumentMeta {
  const row = ws.db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as
    | { id: string; relative_path: string; revision: number; content_hash: string; updated_at: string }
    | undefined;
  if (!row) throw new Error("document not found");
  return { id: row.id, relativePath: row.relative_path, revision: row.revision, contentHash: row.content_hash, updatedAt: row.updated_at };
}

export function listBlocks(ws: Workspace, documentId: string): BlockSnapshot[] {
  return ws.db.prepare(
    `SELECT id, kind, text, ord AS "order", content_hash AS contentHash
     FROM blocks WHERE document_id = ? ORDER BY ord ASC`,
  ).all(documentId) as BlockSnapshot[];
}

function listWorkspaceFilesMatching(ws: Workspace, pattern: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const { name } = entry;
      if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && pattern.test(name)) out.push(rel.replace(/\\/g, "/"));
    }
  };
  walk(ws.root);
  return out.sort();
}

export function listMarkdownFiles(ws: Workspace): string[] {
  return listWorkspaceFilesMatching(ws, /\.(md|markdown)$/i);
}

/** Read-only material candidates that can be attached to an agent turn. */
export function listWorkspaceSourceFiles(ws: Workspace): string[] {
  return listWorkspaceFilesMatching(ws, /\.(md|markdown|txt|csv|pdf|docx)$/i);
}

const TEXT_EXT = /\.(md|markdown|txt|json|csv)$/i;
const MAX_READ_BYTES = 400_000;
const MAX_RICH_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_SOURCE_CHARS = 2_000_000;
const MAX_PDF_PAGES = 300;

function sourceVersionHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

const DENIED_EXTERNAL_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".git", ".margin"]);
const DENIED_EXTERNAL_BASENAMES = new Set([".env", ".netrc", ".npmrc", ".pgpass"]);

/** Case- and separator-insensitive secret deny-list for unlimited external reads. */
function isDeniedExternalPath(candidate: string): boolean {
  const segments = candidate.toLowerCase().replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.some((segment) => DENIED_EXTERNAL_SEGMENTS.has(segment))) return true;
  const basename = segments[segments.length - 1] ?? "";
  if (DENIED_EXTERNAL_BASENAMES.has(basename)) return true;
  if (basename.startsWith(".env.")) return true;
  if (/^id_(rsa|ed25519|ecdsa)/.test(basename)) return true;
  return /\.(pem|key|p12|pfx)$/.test(basename);
}

/** Extract DOCX/PDF text and enforce the shared extraction bounds. */
async function extractRichSourceText(rel: string, buffer: Buffer): Promise<string> {
  let text: string;
  if (/\.docx$/i.test(rel)) {
    const blocks = await extractDocxBlocks(buffer);
    text = blocks.map((block) => block.text).filter(Boolean).join("\n\n");
  } else {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false });
    try {
      const info = await parser.getInfo();
      if (info.total > MAX_PDF_PAGES) {
        throw new Error(`PDF has too many pages (max ${MAX_PDF_PAGES})`);
      }
      const result = await parser.getText({
        first: info.total,
        pageJoiner: "\n\n--- page_number / total_number ---\n\n",
      });
      text = result.text;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  text = boundedExtractedText(text);
  if (!text) {
    throw new Error(/\.pdf$/i.test(rel)
      ? "PDF has no extractable text layer; OCR is not available"
      : "DOCX has no extractable text");
  }
  return text;
}

/** Read a resolved external file; caller vetted existence, deny-list, and file kind. */
async function readExternalSource(
  inputPath: string,
  resolved: string,
): Promise<{ relativePath: string; text: string; bytes: number; versionHash: string }> {
  const rel = resolved.replace(/\\/g, "/");
  if (TEXT_EXT.test(rel)) {
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_READ_BYTES) throw new Error("file too large to read");
    const buffer = fs.readFileSync(resolved);
    const text = buffer.toString("utf8");
    return { relativePath: inputPath, text, bytes: stat.size, versionHash: sourceVersionHash(buffer) };
  }
  if (!/\.(pdf|docx)$/i.test(rel)) {
    throw new Error("only md/txt/json/csv/pdf/docx can be read");
  }
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_RICH_SOURCE_BYTES) {
    throw new Error("source file is too large (max 25 MiB)");
  }
  const buffer = fs.readFileSync(resolved);
  const text = await extractRichSourceText(rel, buffer);
  return { relativePath: inputPath, text, bytes: stat.size, versionHash: sourceVersionHash(buffer) };
}

/** Read a text file inside the workspace (path-safe). */
export function readWorkspaceText(
  ws: Workspace, relativePath: string,
): { relativePath: string; text: string; bytes: number; versionHash: string } {
  const rel = relativePath.replace(/\\/g, "/");
  if (!TEXT_EXT.test(rel)) throw new Error("only md/txt/json/csv can be read");
  const abs = assertInsideWorkspace(ws.root, rel);
  const canonicalRelativePath = visibleRelativePath(ws.root, abs);
  if (!fs.existsSync(abs)) throw new Error("file not found");
  assertSingleLinkFile(abs);
  const st = fs.statSync(abs);
  if (st.size > MAX_READ_BYTES) throw new Error("file too large to read");
  const buffer = fs.readFileSync(abs);
  const text = buffer.toString("utf8");
  return {
    relativePath: canonicalRelativePath,
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    versionHash: sourceVersionHash(buffer),
  };
}

function boundedExtractedText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= MAX_EXTRACTED_SOURCE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_EXTRACTED_SOURCE_CHARS)}\n\n[资料过长，宿主已截断]`;
}

/** Extract a bounded read-only source from text, DOCX, or text-layer PDF. */
export async function readWorkspaceSource(
  ws: Workspace,
  relativePath: string,
  opts?: { unlimitedRead?: boolean },
): Promise<{ relativePath: string; text: string; bytes: number; versionHash: string }> {
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    if (!opts?.unlimitedRead) {
      throw new Error(
        "path is outside workspace; start with --unlimited (or MARGIN_UNLIMITED=1) to allow external reads",
      );
    }
    if (!fs.existsSync(relativePath)) throw new Error("file not found");
    const resolved = fs.realpathSync(relativePath);
    const inside = path.relative(fs.realpathSync(ws.root), resolved);
    if (inside && !inside.startsWith("..") && !path.isAbsolute(inside)) {
      return readWorkspaceSource(ws, inside.replace(/\\/g, "/"));
    }
    if (isDeniedExternalPath(resolved)) {
      throw new Error("refusing to read sensitive path");
    }
    assertSingleLinkFile(resolved);
    return readExternalSource(relativePath, resolved);
  }
  if (TEXT_EXT.test(relativePath)) return readWorkspaceText(ws, relativePath);
  const rel = relativePath.replace(/\\/g, "/");
  if (!/\.(pdf|docx)$/i.test(rel)) {
    throw new Error("only md/txt/json/csv/pdf/docx can be read");
  }
  const abs = assertInsideWorkspace(ws.root, rel);
  const canonicalRelativePath = visibleRelativePath(ws.root, abs);
  if (!fs.existsSync(abs)) throw new Error("file not found");
  assertSingleLinkFile(abs);
  const stat = fs.statSync(abs);
  if (stat.size > MAX_RICH_SOURCE_BYTES) {
    throw new Error("source file is too large (max 25 MiB)");
  }
  const buffer = fs.readFileSync(abs);
  const text = await extractRichSourceText(rel, buffer);
  return { relativePath: canonicalRelativePath, text, bytes: stat.size, versionHash: sourceVersionHash(buffer) };
}

/** Hash the original source bytes without extracting rich document text. */
export function readWorkspaceSourceVersion(
  ws: Workspace,
  relativePath: string,
  opts?: { unlimitedRead?: boolean },
): { relativePath: string; bytes: number; versionHash: string } {
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    if (!opts?.unlimitedRead) {
      throw new Error(
        "path is outside workspace; start with --unlimited (or MARGIN_UNLIMITED=1) to allow external reads",
      );
    }
    if (!fs.existsSync(relativePath)) throw new Error("file not found");
    const resolved = fs.realpathSync(relativePath);
    const inside = path.relative(fs.realpathSync(ws.root), resolved);
    if (inside && !inside.startsWith("..") && !path.isAbsolute(inside)) {
      return readWorkspaceSourceVersion(ws, inside.replace(/\\/g, "/"));
    }
    if (isDeniedExternalPath(resolved)) throw new Error("refusing to read sensitive path");
    assertSingleLinkFile(resolved);
    if (!/\.(md|markdown|txt|json|csv|pdf|docx)$/i.test(resolved)) {
      throw new Error("only md/txt/json/csv/pdf/docx can be read");
    }
    const stat = fs.statSync(resolved);
    if (TEXT_EXT.test(resolved) && stat.size > MAX_READ_BYTES) {
      throw new Error("file too large to read");
    }
    if (!TEXT_EXT.test(resolved) && stat.size > MAX_RICH_SOURCE_BYTES) {
      throw new Error("source file is too large (max 25 MiB)");
    }
    const buffer = fs.readFileSync(resolved);
    return { relativePath, bytes: stat.size, versionHash: sourceVersionHash(buffer) };
  }

  const rel = relativePath.replace(/\\/g, "/");
  if (!/\.(md|markdown|txt|json|csv|pdf|docx)$/i.test(rel)) {
    throw new Error("only md/txt/json/csv/pdf/docx can be read");
  }
  const abs = assertInsideWorkspace(ws.root, rel);
  const canonicalRelativePath = visibleRelativePath(ws.root, abs);
  if (!fs.existsSync(abs)) throw new Error("file not found");
  assertSingleLinkFile(abs);
  const stat = fs.statSync(abs);
  if (TEXT_EXT.test(rel) && stat.size > MAX_READ_BYTES) {
    throw new Error("file too large to read");
  }
  if (!TEXT_EXT.test(rel) && stat.size > MAX_RICH_SOURCE_BYTES) {
    throw new Error("source file is too large (max 25 MiB)");
  }
  const buffer = fs.readFileSync(abs);
  return {
    relativePath: canonicalRelativePath,
    bytes: stat.size,
    versionHash: sourceVersionHash(buffer),
  };
}

/** Create or overwrite a text file inside the workspace (path-safe, atomic). */
export async function writeWorkspaceText(
  ws: Workspace, relativePath: string, content: string,
): Promise<{ relativePath: string; bytes: number; created: boolean }> {
  const rel = relativePath.replace(/\\/g, "/");
  if (!TEXT_EXT.test(rel)) throw new Error("only md/txt/json/csv can be written");
  if (rel.split("/").some((s) => s.startsWith("."))) throw new Error("hidden paths not allowed");
  const abs = assertInsideWorkspace(ws.root, rel);
  const canonicalRelativePath = visibleRelativePath(ws.root, abs);
  assertSingleLinkFile(abs);
  const created = !fs.existsSync(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const text = content.replace(/\r\n/g, "\n");
  await writeFileAtomic(abs, text, "utf8");
  return {
    relativePath: canonicalRelativePath,
    bytes: Buffer.byteLength(text, "utf8"),
    created,
  };
}

export async function importDocxDocument(
  ws: Workspace, relativeDocxPath: string,
): Promise<{ document: DocumentMeta; report: import("./docx-loss.js").RoundtripLossReport }> {
  if (!/\.docx$/i.test(relativeDocxPath)) throw new Error("only .docx import is supported");
  const document = await openDocxDocument(ws, relativeDocxPath.replace(/\\/g, "/"));
  const { statsFromBlocks, compareContentStats } = await import("./docx-loss.js");
  const stats = statsFromBlocks(listBlocks(ws, document.id));
  const report = compareContentStats(stats, stats);
  return { document, report };
}

function externalImportStem(absoluteDocxPath: string): string {
  const rawStem = path.basename(absoluteDocxPath, path.extname(absoluteDocxPath));
  return rawStem
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120) || "document";
}

function externalImportRelativePath(stem: string, index: number): string {
  const suffix = index === 1 ? "" : `-${index}`;
  return `imports/${stem}${suffix}.docx`;
}

function identicalExternalImport(
  ws: Workspace,
  source: string,
  sourceSize: number,
): string | undefined {
  const stem = externalImportStem(source);
  const importsDir = path.join(ws.root, "imports");
  if (!fs.existsSync(importsDir)) return undefined;
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidatePattern = new RegExp(`^${escapedStem}(?:-(\\d+))?\\.docx$`, "i");
  const candidates = fs.readdirSync(importsDir, { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isFile()) return [];
      const match = candidatePattern.exec(entry.name);
      const index = match ? Number(match[1] ?? 1) : 0;
      return index >= 1 && index <= 10_000
        ? [{ index, relativeDocx: `imports/${entry.name}` }]
        : [];
    })
    .sort((left, right) => left.index - right.index);
  let sourceBytes: Buffer | undefined;
  for (const { relativeDocx } of candidates) {
    const candidate = path.join(ws.root, relativeDocx);
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== sourceSize) {
      continue;
    }
    sourceBytes ??= fs.readFileSync(source);
    if (fs.readFileSync(candidate).equals(sourceBytes)) return relativeDocx;
  }
  return undefined;
}

function externalImportPath(ws: Workspace, absoluteDocxPath: string): string {
  const stem = externalImportStem(absoluteDocxPath);
  const importsDir = path.join(ws.root, "imports");
  const occupied = fs.existsSync(importsDir)
    ? new Set(fs.readdirSync(importsDir).map((name) => name.toLowerCase()))
    : new Set<string>();

  for (let index = 1; index <= 10_000; index += 1) {
    const relativeDocx = externalImportRelativePath(stem, index);
    const relativeMarkdown = relativeDocx.replace(/\.docx$/i, ".imported.md");
    if (
      !occupied.has(path.basename(relativeDocx).toLowerCase()) &&
      !occupied.has(path.basename(relativeMarkdown).toLowerCase())
    ) {
      return relativeDocx;
    }
  }
  throw new Error("too many imported documents with the same name");
}

/** Import one explicit absolute DOCX path without granting general filesystem access. */
export async function importExternalDocxDocument(
  ws: Workspace,
  absoluteDocxPath: string,
): Promise<{ document: DocumentMeta; report: import("./docx-loss.js").RoundtripLossReport }> {
  if (!path.isAbsolute(absoluteDocxPath) && !path.win32.isAbsolute(absoluteDocxPath)) {
    throw new Error("external DOCX path must be absolute");
  }
  if (!/\.docx$/i.test(absoluteDocxPath)) throw new Error("only .docx import is supported");
  if (!fs.existsSync(absoluteDocxPath)) throw new Error("DOCX file not found");
  const source = fs.realpathSync(absoluteDocxPath);
  const sourceStat = fs.statSync(source);
  if (!sourceStat.isFile()) throw new Error("DOCX path is not a file");
  if (sourceStat.size > MAX_DOCUMENT_BYTES) {
    throw new Error("DOCX file is too large (max 50 MiB)");
  }

  const existing = identicalExternalImport(ws, source, sourceStat.size);
  if (existing) return importDocxDocument(ws, existing);

  const relativeDocx = externalImportPath(ws, source);
  const stagedDocx = resolveWorkspacePath(ws.root, relativeDocx);
  fs.mkdirSync(path.dirname(stagedDocx), { recursive: true });
  fs.copyFileSync(source, stagedDocx, fs.constants.COPYFILE_EXCL);
  try {
    return await importDocxDocument(ws, relativeDocx);
  } catch (error) {
    fs.rmSync(stagedDocx, { force: true });
    throw error;
  }
}

export async function exportDocumentDocx(
  ws: Workspace, documentId: string, relativeOutPath?: string,
): Promise<{ relativePath: string; report: import("./docx-loss.js").RoundtripLossReport }> {
  const doc = getDocument(ws, documentId);
  const out = relativeOutPath ?? doc.relativePath.replace(/\.(md|markdown|docx)$/i, "") + ".export.docx";
  if (!/\.docx$/i.test(out)) throw new Error("export path must end with .docx");
  const abs = assertInsideWorkspace(ws.root, out);
  const canonicalOut = visibleRelativePath(ws.root, abs);
  assertNotRegisteredDocumentWrite(ws, canonicalOut);
  assertSingleLinkFile(abs);
  const blocks = listBlocks(ws, documentId);
  const { statsFromBlocks, statsFromMarkdown, compareContentStats } = await import("./docx-loss.js");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (/\.docx$/i.test(doc.relativePath)) {
    const source = assertInsideWorkspace(ws.root, doc.relativePath);
    await writeFileAtomic(abs, fs.readFileSync(source));
    const stats = statsFromBlocks(blocks);
    return {
      relativePath: canonicalOut,
      report: compareContentStats(stats, stats),
    };
  }
  const { blocksToDocxBuffer, docxFileToMarkdown } = await import("./docx.js");
  await writeFileAtomic(abs, await blocksToDocxBuffer(blocks));
  const roundtripMd = await docxFileToMarkdown(abs);
  return {
    relativePath: canonicalOut,
    report: compareContentStats(statsFromBlocks(blocks), statsFromMarkdown(roundtripMd)),
  };
}
