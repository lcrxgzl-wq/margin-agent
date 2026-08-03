import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listActiveReviewChecklists,
  listBlocks,
  listComments,
  listProposals,
  openDocument,
  replaceDocumentComments,
  saveProposal,
} from "@margin/storage-local";
import { syncBagFromDocument } from "./chat-agent.js";

describe("scan result persistence", () => {
  const dirs: string[] = [];
  const envKeys = ["MARGIN_PORT", "MARGIN_NO_OPEN", "MARGIN_ENGINE", "MARGIN_API_KEY"];
  let savedEnv: Record<string, string | undefined> = {};
  let savedArgv: string[] = [];

  afterEach(async () => {
    const { runtime } = await import("./index.js");
    if (runtime.app) {
      try {
        await runtime.app.close();
      } catch {
        /* ignore */
      }
      runtime.app = undefined;
    }
    if (runtime.state) {
      try {
        runtime.state.workspace.db.close();
      } catch {
        /* ignore */
      }
      try {
        await runtime.state.workspace.releaseLock();
      } catch {
        /* ignore */
      }
      runtime.state = undefined;
    }
    runtime.enqueueChat = undefined;
    vi.restoreAllMocks();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    process.argv = savedArgv;
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back proposals and comments when checklist persistence fails", async () => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    savedArgv = process.argv;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-scan-atomic-"));
    dirs.push(root);
    fs.writeFileSync(
      path.join(root, "paper.md"),
      "第一段待修订。\n\n第二段待修订。\n\n第三段待修订。\n",
      "utf8",
    );
    process.argv = ["node", "margin-agent", root];
    process.env.MARGIN_PORT = "0";
    process.env.MARGIN_NO_OPEN = "1";
    process.env.MARGIN_ENGINE = "simple";

    await import("./index.js");
    const { runtime } = await import("./index.js");
    for (let attempt = 0; attempt < 200 && !runtime.app; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!runtime.app || !runtime.state) throw new Error("server did not boot");
    const { app, state } = runtime as {
      app: NonNullable<typeof runtime.app>;
      state: NonNullable<typeof runtime.state>;
    };
    const workspace = state.workspace;
    const document = openDocument(workspace, "paper.md");
    const blocks = listBlocks(workspace, document.id);
    const block = blocks[0]!;
    syncBagFromDocument(state.agent, document, blocks);
    saveProposal(workspace, {
      schemaVersion: 1,
      id: "proposal-before-scan",
      documentId: document.id,
      blockId: block.id,
      baseRevision: document.revision,
      baseHash: block.contentHash,
      before: block.text,
      after: "existing proposal",
      rationale: "must survive a failed replacement scan",
      risk: "language",
      evidence: [],
      status: "proposed",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    replaceDocumentComments(workspace, document.id, [{
      id: "comment-before-scan",
      blockId: block.id,
      text: "existing comment",
      severity: "info",
      runId: "previous-run",
      source: "test",
    }]);

    const prepare = workspace.db.prepare.bind(workspace.db);
    let checklistInsertCount = 0;
    const prepareSpy = vi.spyOn(workspace.db, "prepare").mockImplementation((sql: string) => {
      if (/INSERT INTO review_checklist_runs/.test(sql) && ++checklistInsertCount === 2) {
        throw new Error("injected checklist persistence failure");
      }
      return prepare(sql);
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${document.id}/proposal-runs`,
      headers: { authorization: `Bearer ${state.token}` },
      payload: { blockIds: blocks.map((candidate) => candidate.id) },
    });
    expect(response.statusCode).toBe(202);
    const runId = response.json().runId as string;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (state.runs.get(runId)?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(state.runs.get(runId)).toMatchObject({
      status: "error",
      error: "injected checklist persistence failure",
    });
    expect(listProposals(workspace, document.id)).toMatchObject([{
      id: "proposal-before-scan",
      status: "proposed",
    }]);
    expect(listComments(workspace, document.id)).toMatchObject([{
      id: "comment-before-scan",
      text: "existing comment",
      runId: "previous-run",
    }]);
    expect(listActiveReviewChecklists(workspace, document.id)).toEqual([]);

    prepareSpy.mockRestore();
    const successfulResponse = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${document.id}/proposal-runs`,
      headers: { authorization: `Bearer ${state.token}` },
      payload: { blockIds: blocks.map((candidate) => candidate.id) },
    });
    expect(successfulResponse.statusCode).toBe(202);
    const successfulRunId = successfulResponse.json().runId as string;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (state.runs.get(successfulRunId)?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(state.runs.get(successfulRunId)?.status).toBe("done");
    expect(listProposals(workspace, document.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "proposal-before-scan", status: "superseded" }),
      expect.objectContaining({ status: "proposed" }),
    ]));
  });
});
