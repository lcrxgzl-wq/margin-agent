import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewChecklistRunDraft } from "@margin/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReviewChecklistConflictError,
  ReviewChecklistNotFoundError,
  ReviewChecklistValidationError,
  decideReviewChecklistItems,
  listActiveReviewChecklists,
  listReviewChecklistHistory,
  openDocument,
  openWorkspace,
  saveReviewChecklistRun,
  saveReviewChecklistRunWithinTransaction,
  type Workspace,
} from "./index.js";

const workspaces: Workspace[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const ws of workspaces.splice(0)) {
    try { ws.db.close(); } catch { /* ignore */ }
    try { await ws.releaseLock(); } catch { /* ignore */ }
  }
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function workspace(): Promise<Workspace> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-checklists-"));
  dirs.push(root);
  const ws = await openWorkspace(root);
  workspaces.push(ws);
  return ws;
}

function draft(
  runId: string,
  checker: "cite_check" | "style_lint" = "cite_check",
  itemIds = ["item-1", "item-2"],
): ReviewChecklistRunDraft {
  const createdAt = `2026-08-01T00:00:0${runId.endsWith("2") ? "2" : "1"}.000Z`;
  return {
    run: {
      schemaVersion: 1,
      id: runId,
      documentId: "doc-1",
      checker,
      disclaimer: checker === "cite_check" ? "形态检查边界" : "词表启发边界",
      status: "active",
      createdAt,
    },
    items: itemIds.map((id, index) => ({
      schemaVersion: 1,
      id,
      runId,
      documentId: "doc-1",
      blockId: `block-${index + 1}`,
      issueType: checker === "cite_check" ? "citation.author_year" : "style.cliche",
      label: checker === "cite_check" ? "作者—年份引用" : "套话",
      excerpt: `excerpt-${index + 1}`,
      detail: "heuristic detail",
      severity: "warn",
      status: "open",
      heuristicOnly: true,
      verification: checker === "cite_check" ? "not_verified" : undefined,
      createdAt,
    })),
  };
}

describe("review checklist store", () => {
  it("rejects transaction-owned persistence before making any writes", async () => {
    const ws = await workspace();
    saveReviewChecklistRun(ws, draft("run-1"));

    expect(() => saveReviewChecklistRunWithinTransaction(ws, draft("run-1")))
      .toThrow(/active transaction required/);

    expect(listActiveReviewChecklists(ws, "doc-1").map((entry) => entry.run.id))
      .toEqual(["run-1"]);
    expect(listReviewChecklistHistory(ws, "doc-1").map((entry) => entry.run.status))
      .toEqual(["active"]);
    expect(ws.db.prepare("SELECT COUNT(*) AS count FROM review_checklist_items").get())
      .toEqual({ count: 2 });
  });

  it("creates its migration idempotently and preserves superseded history", async () => {
    const ws = await workspace();
    saveReviewChecklistRun(ws, draft("run-1"));
    saveReviewChecklistRun(ws, draft("run-2", "cite_check", []));
    saveReviewChecklistRun(ws, draft("style-1", "style_lint", ["style-item"]));

    const active = listActiveReviewChecklists(ws, "doc-1");
    expect(active.map((entry) => [entry.run.id, entry.items.length])).toEqual([
      ["run-2", 0],
      ["style-1", 1],
    ]);
    expect(listReviewChecklistHistory(ws, "doc-1").map((entry) => entry.run.status))
      .toEqual(["superseded", "active", "active"]);

    workspaces.splice(workspaces.indexOf(ws), 1);
    ws.db.close();
    await ws.releaseLock();
    const reopened = await openWorkspace(ws.root);
    workspaces.push(reopened);
    expect(listActiveReviewChecklists(reopened, "doc-1")).toHaveLength(2);
  });

  it("writes one decision and fills every selected item in one transaction", async () => {
    const ws = await workspace();
    saveReviewChecklistRun(ws, draft("run-1"));

    const result = decideReviewChecklistItems(
      ws,
      "run-1",
      ["item-1", "item-2"],
      "resolve",
    );

    expect(result.decision.itemIds).toEqual(["item-1", "item-2"]);
    expect(result.checklist.items.map((item) => item.status)).toEqual(["resolved", "resolved"]);
    expect(ws.db.prepare("SELECT COUNT(*) AS count FROM review_checklist_decisions").get())
      .toEqual({ count: 1 });
  });

  it("rejects duplicate, unknown, and cross-run item ids without partial updates", async () => {
    const ws = await workspace();
    saveReviewChecklistRun(ws, draft("run-1"));
    saveReviewChecklistRun(ws, draft("style-1", "style_lint", ["style-item"]));

    expect(() => decideReviewChecklistItems(
      ws,
      "run-1",
      ["item-1", "item-1"],
      "resolve",
    )).toThrow();
    expect(() => decideReviewChecklistItems(
      ws,
      "run-1",
      ["item-1", "missing"],
      "resolve",
    )).toThrow(ReviewChecklistNotFoundError);
    expect(() => decideReviewChecklistItems(
      ws,
      "run-1",
      ["item-1", "style-item"],
      "dismiss",
    )).toThrow(ReviewChecklistValidationError);

    expect(listActiveReviewChecklists(ws, "doc-1")
      .find((entry) => entry.run.id === "run-1")?.items.map((item) => item.status))
      .toEqual(["open", "open"]);
    expect(ws.db.prepare("SELECT COUNT(*) AS count FROM review_checklist_decisions").get())
      .toEqual({ count: 0 });
  });

  it("rejects superseded and already-decided runs without a second decision", async () => {
    const ws = await workspace();
    saveReviewChecklistRun(ws, draft("run-1"));
    saveReviewChecklistRun(ws, draft("run-2", "cite_check", ["new-item"]));

    expect(() => decideReviewChecklistItems(
      ws,
      "run-1",
      ["item-1"],
      "resolve",
    )).toThrow(ReviewChecklistConflictError);

    decideReviewChecklistItems(ws, "run-2", ["new-item"], "dismiss");
    expect(() => decideReviewChecklistItems(
      ws,
      "run-2",
      ["new-item"],
      "resolve",
    )).toThrow(ReviewChecklistConflictError);
    expect(ws.db.prepare("SELECT COUNT(*) AS count FROM review_checklist_decisions").get())
      .toEqual({ count: 1 });
  });

  it("supersedes active checklists only when the indexed document content changes", async () => {
    const ws = await workspace();
    const relativePath = "paper.md";
    fs.writeFileSync(path.join(ws.root, relativePath), "# Title\n\nOriginal paragraph.\n", "utf8");
    const document = openDocument(ws, relativePath);
    const run = draft("run-document-change");
    run.run.documentId = document.id;
    run.items = run.items.map((item) => ({
      ...item,
      documentId: document.id,
    }));
    saveReviewChecklistRun(ws, run);

    openDocument(ws, relativePath);
    expect(listActiveReviewChecklists(ws, document.id)).toHaveLength(1);

    fs.writeFileSync(path.join(ws.root, relativePath), "# Title\n\nChanged paragraph.\n", "utf8");
    openDocument(ws, relativePath);

    expect(listActiveReviewChecklists(ws, document.id)).toEqual([]);
    expect(listReviewChecklistHistory(ws, document.id)[0]?.run.status).toBe("superseded");
  });
});
