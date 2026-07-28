import { randomUUID } from "node:crypto";
import type { Workspace } from "./workspace-fs.js";

/** One recorded model request; token counts come from the provider response. */
export type ModelUsageRecord = {
  path: "pi-chat" | "pi-scan" | "quick-edit" | "legacy" | "probe";
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requestId: string;
};

/** Best-effort local token/cache diagnostics; never throws into the request path. */
export function recordModelUsage(workspace: Workspace, record: ModelUsageRecord): void {
  try {
    workspace.db
      .prepare(
        `INSERT INTO model_usage (id, ts, path, model, input, output, cache_read, cache_write, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        new Date().toISOString(),
        record.path,
        record.model.slice(0, 200),
        Math.max(0, Math.floor(record.input)),
        Math.max(0, Math.floor(record.output)),
        Math.max(0, Math.floor(record.cacheRead)),
        Math.max(0, Math.floor(record.cacheWrite)),
        record.requestId.slice(0, 64),
      );
  } catch {
    // diagnostics only
  }
}

/** Recent usage rows, oldest first — local cache/token diagnostics. */
export function listModelUsage(workspace: Workspace, limit = 200): ModelUsageRecord[] {
  const bounded = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const rows = workspace.db
    .prepare(
      `SELECT path, model, input, output, cache_read, cache_write, request_id
       FROM model_usage ORDER BY ts DESC LIMIT ?`,
    )
    .all(bounded) as Array<{
    path: ModelUsageRecord["path"];
    model: string;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    request_id: string;
  }>;
  return rows.reverse().map((row) => ({
    path: row.path,
    model: row.model,
    input: row.input,
    output: row.output,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    requestId: row.request_id,
  }));
}
