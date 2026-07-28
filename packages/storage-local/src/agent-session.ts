import type { Workspace } from "./workspace-fs.js";

const SESSION_ROW_ID = "current";
const MAX_MESSAGES = 80;
const MAX_CHAT_TURNS = 24;
const MAX_CHAT_TEXT_CHARS = 8_000;
const MAX_REVIEW_THREADS = 24;
const MAX_THREAD_BLOCK_IDS = 8;
const MAX_THREAD_ID_CHARS = 200;
const MAX_ANCHOR_TEXT_CHARS = 6_000;
const MAX_TABLE_ADDRESS_CHARS = 32;
const MAX_SOURCE_PATHS = 50;
const MAX_SOURCE_PATH_CHARS = 500;
const MAX_TASK_OBJECTIVE_CHARS = 2_000;
const MAX_TASK_SOURCE_REFS = 100;
const MAX_JSON_BYTES = 800_000;

export type PersistedChatTurn = {
  role: "user" | "assistant";
  text: string;
  threadId?: string;
};

export type PersistedReviewThread = {
  id: string;
  documentId: string;
  anchor: {
    blockId: string;
    blockIds?: string[];
    selectionText: string;
    selectionStart?: number;
    tableCell?: {
      row: number;
      column: number;
      address: string;
      before: string;
    };
    crossTableCells?: boolean;
  };
  collapsed: boolean;
  createdAt: string;
};

export type PersistedAgentTask = {
  objective: string;
  status: "running" | "completed" | "interrupted";
  currentStep?: string;
  sourcePaths: string[];
  sourceRefs: string[];
  proposalCount: number;
  inspectedDocument: boolean;
  consistencyChecked: boolean;
  selection?: {
    blockIds: string[];
    text?: string;
    start?: number;
  };
  updatedAt: string;
};

export type PersistedAgentSession = {
  sessionId: string;
  documentId?: string;
  messages: unknown[];
  updatedAt: string;
  clarificationRounds: number;
  chatTurns: PersistedChatTurn[];
  threads: PersistedReviewThread[];
  sourcePaths: string[];
  task?: PersistedAgentTask;
};

type SessionEnvelope = {
  messages: unknown[];
  documentId?: string;
  clarificationRounds?: number;
  chatTurns?: PersistedChatTurn[];
  threads?: PersistedReviewThread[];
  sourcePaths?: string[];
  task?: PersistedAgentTask;
};

function isChatTurn(value: unknown): value is PersistedChatTurn {
  if (!value || typeof value !== "object") return false;
  const t = value as { role?: unknown; text?: unknown; threadId?: unknown };
  return (
    (t.role === "user" || t.role === "assistant") &&
    typeof t.text === "string" &&
    t.text.trim().length > 0 &&
    (t.threadId === undefined || (
      typeof t.threadId === "string" &&
      t.threadId.trim().length > 0 &&
      t.threadId.trim().length <= MAX_THREAD_ID_CHARS
    ))
  );
}

function normalizeChatTurns(value: unknown): PersistedChatTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isChatTurn)
    .map((turn) => ({
      role: turn.role,
      text: turn.text.trim().slice(0, MAX_CHAT_TEXT_CHARS),
      ...(turn.threadId ? { threadId: turn.threadId.trim() } : {}),
    }))
    .filter((turn) => turn.text.length > 0)
    .slice(-MAX_CHAT_TURNS);
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_THREAD_ID_CHARS ? normalized : undefined;
}

function boundedAnchorText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.slice(0, MAX_ANCHOR_TEXT_CHARS);
}

function normalizeReviewThreads(value: unknown): PersistedReviewThread[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: PersistedReviewThread[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const thread = item as Partial<PersistedReviewThread>;
    const id = boundedId(thread.id);
    const documentId = boundedId(thread.documentId);
    const anchor = thread.anchor && typeof thread.anchor === "object" ? thread.anchor : undefined;
    const blockId = boundedId(anchor?.blockId);
    const selectionText = boundedAnchorText(anchor?.selectionText);
    const createdAt = typeof thread.createdAt === "string" &&
        thread.createdAt.length <= 64 && Number.isFinite(Date.parse(thread.createdAt))
      ? thread.createdAt
      : undefined;
    if (!id || seen.has(id) || !documentId || !anchor || !blockId || !selectionText || !createdAt) {
      continue;
    }

    const requestedBlockIds = Array.isArray(anchor.blockIds)
      ? [...new Set(anchor.blockIds.map(boundedId).filter((value): value is string => Boolean(value)))]
      : [];
    const blockIds = requestedBlockIds.length
      ? [blockId, ...requestedBlockIds.filter((value) => value !== blockId)].slice(0, MAX_THREAD_BLOCK_IDS)
      : [];

    let tableCell: PersistedReviewThread["anchor"]["tableCell"];
    if (anchor.tableCell !== undefined) {
      const cell = anchor.tableCell;
      const row = Number(cell?.row);
      const column = Number(cell?.column);
      const address = typeof cell?.address === "string" ? cell.address.trim() : "";
      const before = boundedAnchorText(cell?.before);
      if (
        !Number.isInteger(row) || row < 0 || row > 1_000_000 ||
        !Number.isInteger(column) || column < 0 || column > 1_000_000 ||
        !address || address.length > MAX_TABLE_ADDRESS_CHARS || !before
      ) {
        continue;
      }
      tableCell = { row, column, address, before };
    }

    const selectionStart = Number(anchor.selectionStart);
    seen.add(id);
    normalized.push({
      id,
      documentId,
      anchor: {
        blockId,
        ...(blockIds.length ? { blockIds } : {}),
        selectionText,
        ...(Number.isInteger(selectionStart) && selectionStart >= 0 && selectionStart <= 2_000_000
          ? { selectionStart }
          : {}),
        ...(tableCell ? { tableCell } : {}),
        ...(anchor.crossTableCells === true ? { crossTableCells: true } : {}),
      },
      collapsed: thread.collapsed === true,
      createdAt,
    });
  }
  return normalized.slice(-MAX_REVIEW_THREADS);
}

function messageRole(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const role = (value as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/** Keep complete user-started turns so restored Pi history never begins with a tool result. */
function trimMessagesAtTurnBoundary(messages: unknown[]): unknown[] {
  const cutoff = Math.max(0, messages.length - MAX_MESSAGES);
  const nextUser = messages.findIndex(
    (message, index) => index >= cutoff && messageRole(message) === "user",
  );
  return nextUser >= 0 ? messages.slice(nextUser) : [];
}

function dropOldestTurn(messages: unknown[]): unknown[] {
  if (!messages.length) return messages;
  const nextUser = messages.findIndex(
    (message, index) => index > 0 && messageRole(message) === "user",
  );
  return nextUser >= 0 ? messages.slice(nextUser) : [];
}

function normalizeSourcePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(
      (item) =>
        item.length > 0 &&
        item.length <= MAX_SOURCE_PATH_CHARS &&
        /\.(md|markdown|txt|csv|pdf|docx)$/i.test(item) &&
        !item.startsWith("/") &&
        !item.split("/").some((segment) => segment === ".."),
    );
  return [...new Set(paths)].slice(0, MAX_SOURCE_PATHS);
}

function normalizeTask(
  value: unknown,
  restoreRunningAsInterrupted = false,
): PersistedAgentTask | undefined {
  if (!value || typeof value !== "object") return undefined;
  const task = value as Partial<PersistedAgentTask>;
  const objective = typeof task.objective === "string"
    ? task.objective.trim().slice(0, MAX_TASK_OBJECTIVE_CHARS)
    : "";
  if (!objective) return undefined;
  const status = task.status === "completed"
    ? "completed"
    : task.status === "interrupted" || (restoreRunningAsInterrupted && task.status === "running")
      ? "interrupted"
      : task.status === "running"
        ? "running"
      : undefined;
  if (!status) return undefined;
  const sourceRefs = Array.isArray(task.sourceRefs)
    ? [...new Set(task.sourceRefs
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().replace(/\\/g, "/"))
        .filter((item) => item.length > 0 && item.length <= MAX_SOURCE_PATH_CHARS))]
        .slice(0, MAX_TASK_SOURCE_REFS)
    : [];
  const proposalCount = Number(task.proposalCount);
  return {
    objective,
    status,
    currentStep:
      typeof task.currentStep === "string" && task.currentStep.trim()
        ? task.currentStep.trim().slice(0, 200)
        : undefined,
    sourcePaths: normalizeSourcePaths(task.sourcePaths),
    sourceRefs,
    proposalCount: Number.isFinite(proposalCount) && proposalCount > 0
      ? Math.min(100, Math.floor(proposalCount))
      : 0,
    inspectedDocument: task.inspectedDocument === true,
    consistencyChecked: task.consistencyChecked === true,
    selection: task.selection && typeof task.selection === "object"
      ? {
          blockIds: Array.isArray(task.selection.blockIds)
            ? [...new Set(task.selection.blockIds
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean))].slice(0, 12)
            : [],
          text:
            typeof task.selection.text === "string" && task.selection.text.trim()
              ? task.selection.text.slice(0, 6_000)
              : undefined,
          start:
            Number.isInteger(task.selection.start) && Number(task.selection.start) >= 0
              ? Math.min(2_000_000, Number(task.selection.start))
              : undefined,
        }
      : undefined,
    updatedAt:
      typeof task.updatedAt === "string" && task.updatedAt.trim()
        ? task.updatedAt
        : new Date().toISOString(),
  };
}

function parseSessionPayload(raw: string): {
  messages: unknown[];
  documentId?: string;
  clarificationRounds: number;
  chatTurns: PersistedChatTurn[];
  threads: PersistedReviewThread[];
  sourcePaths: string[];
  task?: PersistedAgentTask;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return {
        messages: trimMessagesAtTurnBoundary(parsed),
        clarificationRounds: 0,
        chatTurns: [],
        threads: [],
        sourcePaths: [],
        task: undefined,
      };
    }
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as SessionEnvelope).messages)) {
      const env = parsed as SessionEnvelope;
      const rounds = Number(env.clarificationRounds);
      const chatTurns = normalizeChatTurns(env.chatTurns);
      const threads = normalizeReviewThreads(env.threads);
      return {
        messages: trimMessagesAtTurnBoundary(env.messages),
        documentId:
          typeof env.documentId === "string" && env.documentId.trim()
            ? env.documentId.trim()
            : undefined,
        clarificationRounds: Number.isFinite(rounds) && rounds > 0 ? Math.min(3, Math.floor(rounds)) : 0,
        chatTurns,
        threads,
        sourcePaths: normalizeSourcePaths(env.sourcePaths),
        task: normalizeTask(env.task, true),
      };
    }
  } catch {
    /* ignore */
  }
  return { messages: [], clarificationRounds: 0, chatTurns: [], threads: [], sourcePaths: [], task: undefined };
}

/** Ensure agent_sessions table exists (idempotent for older DBs). */
export function ensureAgentSessionSchema(ws: Workspace): void {
  ws.db.exec(`
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
  `);
}

export function saveAgentSession(
  ws: Workspace,
  session: {
    sessionId: string;
    documentId?: string;
    messages: unknown[];
    clarificationRounds?: number;
    chatTurns?: PersistedChatTurn[];
    threads?: PersistedReviewThread[];
    sourcePaths?: string[];
    task?: PersistedAgentTask;
  },
): PersistedAgentSession {
  ensureAgentSessionSchema(ws);
  let trimmed = trimMessagesAtTurnBoundary(session.messages);
  let chatTurns = normalizeChatTurns(session.chatTurns);
  let threads = session.threads === undefined
    ? (() => {
        const row = ws.db
          .prepare(`SELECT messages_json FROM agent_sessions WHERE id = ?`)
          .get(SESSION_ROW_ID) as { messages_json: string } | undefined;
        return row ? parseSessionPayload(row.messages_json).threads : [];
      })()
    : normalizeReviewThreads(session.threads);
  const clarificationRounds =
    typeof session.clarificationRounds === "number" && session.clarificationRounds > 0
      ? Math.min(3, Math.floor(session.clarificationRounds))
      : 0;
  const sourcePaths = normalizeSourcePaths(session.sourcePaths);
  const task = normalizeTask(session.task);

  const serialize = () =>
    JSON.stringify({
      messages: trimmed,
      documentId: session.documentId,
      clarificationRounds,
      chatTurns,
      threads,
      sourcePaths,
      task,
    });

  let messagesJson = serialize();
  while (Buffer.byteLength(messagesJson, "utf8") > MAX_JSON_BYTES && trimmed.length) {
    trimmed = dropOldestTurn(trimmed);
    messagesJson = serialize();
  }
  while (Buffer.byteLength(messagesJson, "utf8") > MAX_JSON_BYTES && chatTurns.length) {
    chatTurns = chatTurns.slice(1);
    messagesJson = serialize();
  }
  while (Buffer.byteLength(messagesJson, "utf8") > MAX_JSON_BYTES && threads.length) {
    threads = threads.slice(1);
    messagesJson = serialize();
  }
  if (Buffer.byteLength(messagesJson, "utf8") > MAX_JSON_BYTES) {
    throw new Error("agent session metadata exceeds storage limit");
  }

  const saved: PersistedAgentSession = {
    sessionId: session.sessionId,
    documentId: session.documentId,
    messages: (JSON.parse(messagesJson) as SessionEnvelope).messages,
    clarificationRounds,
    chatTurns,
    threads,
    sourcePaths,
    task,
    updatedAt: new Date().toISOString(),
  };
  ws.db.prepare(
    `INSERT INTO agent_sessions (id, session_id, messages_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session_id=excluded.session_id,
       messages_json=excluded.messages_json,
       updated_at=excluded.updated_at`,
  ).run(SESSION_ROW_ID, saved.sessionId, messagesJson, saved.updatedAt);
  return saved;
}

export function loadAgentSession(ws: Workspace): PersistedAgentSession | null {
  ensureAgentSessionSchema(ws);
  const row = ws.db
    .prepare(`SELECT session_id, messages_json, updated_at FROM agent_sessions WHERE id = ?`)
    .get(SESSION_ROW_ID) as
    | { session_id: string; messages_json: string; updated_at: string }
    | undefined;
  if (!row) return null;
  const parsed = parseSessionPayload(row.messages_json);
  if (!parsed.messages.length && !parsed.chatTurns.length) {
    // Empty legacy row — treat as missing.
    if (row.messages_json.trim() === "[]") return null;
  }
  return {
    sessionId: row.session_id,
    documentId: parsed.documentId,
    messages: parsed.messages,
    clarificationRounds: parsed.clarificationRounds,
    chatTurns: parsed.chatTurns,
    threads: parsed.threads,
    sourcePaths: parsed.sourcePaths,
    task: parsed.task,
    updatedAt: row.updated_at,
  };
}

export function clearAgentSession(ws: Workspace): void {
  ensureAgentSessionSchema(ws);
  ws.db.prepare(`DELETE FROM agent_sessions WHERE id = ?`).run(SESSION_ROW_ID);
}

const MAX_SESSION_HISTORY = 50;
const MAX_SESSION_TITLE_CHARS = 40;

export type AgentSessionSummary = {
  sessionId: string;
  updatedAt: string;
  title: string;
  documentId?: string;
  turnCount: number;
};

/**
 * Snapshot the active ("current") session row into history, upserted by
 * sessionId. Re-archiving bumps updated_at so recently used sessions float
 * to the top of the list. History is pruned to the latest MAX_SESSION_HISTORY.
 * Returns false when the current row is missing or belongs to another session.
 */
export function archiveAgentSession(ws: Workspace, sessionId: string): boolean {
  ensureAgentSessionSchema(ws);
  const row = ws.db
    .prepare(`SELECT session_id, messages_json FROM agent_sessions WHERE id = ?`)
    .get(SESSION_ROW_ID) as { session_id: string; messages_json: string } | undefined;
  if (!row || row.session_id !== sessionId) return false;
  ws.db.prepare(
    `INSERT INTO agent_session_history (id, session_id, messages_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session_id=excluded.session_id,
       messages_json=excluded.messages_json,
       updated_at=excluded.updated_at`,
  ).run(sessionId, row.session_id, row.messages_json, new Date().toISOString());
  ws.db.prepare(
    `DELETE FROM agent_session_history WHERE id NOT IN (
       SELECT id FROM agent_session_history ORDER BY updated_at DESC LIMIT ?
     )`,
  ).run(MAX_SESSION_HISTORY);
  return true;
}

/** Load a full session envelope from history (same shape as loadAgentSession). */
export function loadAgentSessionEnvelope(
  ws: Workspace,
  sessionId: string,
): PersistedAgentSession | null {
  ensureAgentSessionSchema(ws);
  const row = ws.db
    .prepare(`SELECT session_id, messages_json, updated_at FROM agent_session_history WHERE id = ?`)
    .get(sessionId) as
    | { session_id: string; messages_json: string; updated_at: string }
    | undefined;
  if (!row) return null;
  const parsed = parseSessionPayload(row.messages_json);
  return {
    sessionId: row.session_id,
    documentId: parsed.documentId,
    messages: parsed.messages,
    clarificationRounds: parsed.clarificationRounds,
    chatTurns: parsed.chatTurns,
    threads: parsed.threads,
    sourcePaths: parsed.sourcePaths,
    task: parsed.task,
    updatedAt: row.updated_at,
  };
}

/** Remove a session from history (no-op when absent). */
export function deleteAgentSession(ws: Workspace, sessionId: string): void {
  ensureAgentSessionSchema(ws);
  ws.db.prepare(`DELETE FROM agent_session_history WHERE id = ?`).run(sessionId);
}

/** History list, most recently used first. */
export function listAgentSessions(ws: Workspace): AgentSessionSummary[] {
  ensureAgentSessionSchema(ws);
  const rows = ws.db
    .prepare(
      `SELECT id, messages_json, updated_at FROM agent_session_history ORDER BY updated_at DESC`,
    )
    .all() as Array<{ id: string; messages_json: string; updated_at: string }>;
  return rows.map((row) => {
    const parsed = parseSessionPayload(row.messages_json);
    const firstUserTurn = parsed.chatTurns.find((turn) => turn.role === "user");
    const title = firstUserTurn
      ? firstUserTurn.text.replace(/\s+/g, " ").trim().slice(0, MAX_SESSION_TITLE_CHARS)
      : "";
    return {
      sessionId: row.id,
      updatedAt: row.updated_at,
      title: title || "新会话",
      documentId: parsed.documentId,
      turnCount: parsed.chatTurns.length,
    };
  });
}
