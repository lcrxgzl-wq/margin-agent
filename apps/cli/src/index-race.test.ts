import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentHash } from "@margin/domain";
import {
  listBlocks,
  listComments,
  listProposals,
  openDocument,
  saveProposal,
  saveReviewChecklistRun,
} from "@margin/storage-local";
import { syncBagFromDocument } from "./chat-agent.js";

/**
 * I1 regression: proposal decision / apply / resolve routes mutate the shared
 * chat agent state, so they must run on the same serialized queue as chat
 * turns. While a chat turn is in flight (queue occupied), a decision request
 * must wait instead of interleaving its note/persist with the turn.
 *
 * Boots the real server in-process (offline mock LLM) via the runtime seam.
 */
describe("chat queue serialization (I1)", () => {
  const dirs: string[] = [];
  const ENV_KEYS = ["MARGIN_PORT", "MARGIN_NO_OPEN", "MARGIN_ENGINE", "MARGIN_API_KEY"];
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
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    process.argv = savedArgv;
    for (const dir of dirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("serializes decisions and rejects a stale document mutation", async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    savedArgv = process.argv;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-index-race-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "# 标题\n\n第一段。\n", "utf8");
    fs.writeFileSync(path.join(root, "source.txt"), "source material\n", "utf8");
    process.argv = ["node", "margin-agent", root];
    process.env.MARGIN_PORT = "0";
    process.env.MARGIN_NO_OPEN = "1";

    await import("./index.js");
    const { runtime } = await import("./index.js");
    // main() runs async from module load; wait for the listen seam.
    for (let attempt = 0; attempt < 200 && !runtime.app; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!runtime.app || !runtime.state || !runtime.enqueueChat) {
      throw new Error("server did not boot");
    }
    const { app, state, enqueueChat } = runtime as {
      app: NonNullable<typeof runtime.app>;
      state: NonNullable<typeof runtime.state>;
      enqueueChat: NonNullable<typeof runtime.enqueueChat>;
    };

    const sourceFile = path.join(root, "source.txt");
    const originalSource = fs.readFileSync(sourceFile, "utf8");
    const fixedTime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    fs.utimesSync(sourceFile, fixedTime, fixedTime);
    const originalStat = fs.statSync(sourceFile);
    const sourceRef = `source.txt#sha256=${contentHash(originalSource)}&chars=0-6`;
    const warmSource = await app.inject({
      method: "POST",
      url: "/api/v1/workspace/source-chunk",
      headers: { authorization: `Bearer ${state.token}` },
      payload: { sourceRef },
    });
    expect(warmSource.statusCode).toBe(200);

    const replacementSource = "other! material\n";
    expect(Buffer.byteLength(replacementSource)).toBe(Buffer.byteLength(originalSource));
    fs.writeFileSync(sourceFile, replacementSource, "utf8");
    fs.utimesSync(sourceFile, originalStat.atime, originalStat.mtime);
    expect(fs.statSync(sourceFile).mtimeMs).toBe(originalStat.mtimeMs);
    const staleSource = await app.inject({
      method: "POST",
      url: "/api/v1/workspace/source-chunk",
      headers: { authorization: `Bearer ${state.token}` },
      payload: { sourceRef },
    });
    expect(staleSource.statusCode).toBe(409);

    // Seed a document + proposed proposal the decision route can act on.
    const workspace = state.workspace;
    const document = openDocument(workspace, "paper.md");
    const blocks = listBlocks(workspace, document.id);
    syncBagFromDocument(state.agent, document, blocks);

    const checklistDraft = (runId: string, itemId: string) => ({
      run: {
        schemaVersion: 1 as const,
        id: runId,
        documentId: document.id,
        checker: "cite_check" as const,
        disclaimer: "形态检查边界",
        status: "active" as const,
        createdAt: new Date().toISOString(),
      },
      items: [{
        schemaVersion: 1 as const,
        id: itemId,
        runId,
        documentId: document.id,
        blockId: blocks[0]!.id,
        issueType: "citation.author_year",
        label: "作者—年份引用",
        excerpt: "（张三，2020）",
        detail: "疑似引用形态",
        severity: "info" as const,
        status: "open" as const,
        heuristicOnly: true,
        verification: "not_verified" as const,
        createdAt: new Date().toISOString(),
      }],
    });
    saveReviewChecklistRun(workspace, checklistDraft("check-run-1", "check-item-1"));

    const unauthenticatedChecklists = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${document.id}/checklists`,
    });
    expect(unauthenticatedChecklists.statusCode).toBe(401);

    const checklistResponse = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${document.id}/checklists`,
      headers: { authorization: `Bearer ${state.token}` },
    });
    expect(checklistResponse.statusCode).toBe(200);
    expect(checklistResponse.json().runs).toMatchObject([{
      run: { id: "check-run-1", checker: "cite_check" },
      items: [{ id: "check-item-1", status: "open" }],
    }]);

    const checklistDecision = await app.inject({
      method: "POST",
      url: "/api/v1/checklists/check-run-1/decisions",
      headers: { authorization: `Bearer ${state.token}` },
      payload: { itemIds: ["check-item-1"], kind: "resolve" },
    });
    expect(checklistDecision.statusCode).toBe(200);
    expect(checklistDecision.json().run.items[0].status).toBe("resolved");

    saveReviewChecklistRun(workspace, checklistDraft("check-run-2", "check-item-2"));
    const staleChecklistDecision = await app.inject({
      method: "POST",
      url: "/api/v1/checklists/check-run-1/decisions",
      headers: { authorization: `Bearer ${state.token}` },
      payload: { itemIds: ["check-item-1"], kind: "dismiss" },
    });
    expect(staleChecklistDecision.statusCode).toBe(409);

    const unknownChecklistItem = await app.inject({
      method: "POST",
      url: "/api/v1/checklists/check-run-2/decisions",
      headers: { authorization: `Bearer ${state.token}` },
      payload: { itemIds: ["missing-item"], kind: "dismiss" },
    });
    expect(unknownChecklistItem.statusCode).toBe(404);

    saveProposal(workspace, {
      schemaVersion: 1,
      id: "proposal-race",
      documentId: document.id,
      blockId: blocks[0]!.id,
      baseRevision: document.revision,
      baseHash: blocks[0]!.contentHash,
      before: blocks[0]!.text,
      after: `${blocks[0]!.text}改`,
      rationale: "race test",
      risk: "language",
      evidence: [],
      status: "proposed",
      createdAt: new Date().toISOString(),
    });

    // Occupy the chat queue the way an in-flight chat turn does.
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const inFlightTurn = enqueueChat(() => turnGate);

    const pendingDecision = app.inject({
      method: "PATCH",
      url: "/api/v1/proposals/proposal-race/decision",
      headers: { authorization: `Bearer ${state.token}` },
      payload: { kind: "N" },
    });

    // While the turn holds the queue, the decision must NOT complete.
    const respondedEarly = await Promise.race([
      pendingDecision.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(respondedEarly).toBe(false);

    releaseTurn();
    await inFlightTurn;
    const response = await pendingDecision;
    expect(response.statusCode).toBe(200);
    expect(response.json().decision.kind).toBe("N");

    saveProposal(workspace, {
      schemaVersion: 1,
      id: "proposal-stale",
      documentId: document.id,
      blockId: blocks[0]!.id,
      baseRevision: document.revision,
      baseHash: blocks[0]!.contentHash,
      before: blocks[0]!.text,
      after: `${blocks[0]!.text}改`,
      rationale: "stale tab test",
      risk: "language",
      evidence: [],
      status: "proposed",
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(root, "other.md"), "另一篇文稿。\n", "utf8");
    const otherDocument = openDocument(workspace, "other.md");
    syncBagFromDocument(state.agent, otherDocument, listBlocks(workspace, otherDocument.id));

    const staleResponse = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${document.id}/resolve-proposals`,
      headers: { authorization: `Bearer ${state.token}` },
      payload: {
        proposalIds: ["proposal-stale"],
        expectedRevision: document.revision,
        expectedHash: document.contentHash,
      },
    });
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json()).toMatchObject({ ok: false, reason: "document_mismatch" });
    expect(state.agent.bag.documentId).toBe(otherDocument.id);
    expect(listProposals(workspace, document.id).find((proposal) => proposal.id === "proposal-stale")?.status)
      .toBe("proposed");

    const proposalCountBeforeStaleRun = listProposals(workspace, document.id).length;
    const staleRunResponse = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${document.id}/proposal-runs`,
      headers: { authorization: `Bearer ${state.token}` },
      payload: { blockIds: [blocks[0]!.id] },
    });
    expect(staleRunResponse.statusCode).toBe(409);
    expect(staleRunResponse.json()).toMatchObject({ ok: false, reason: "document_mismatch" });
    expect(listProposals(workspace, document.id)).toHaveLength(proposalCountBeforeStaleRun);

    const sourcePathsBeforeStaleRequest = [...state.agent.sourcePaths];
    const staleSourcesResponse = await app.inject({
      method: "PUT",
      url: "/api/v1/session/sources",
      headers: { authorization: `Bearer ${state.token}` },
      payload: { documentId: document.id, sourcePaths: ["source.txt"] },
    });
    expect(staleSourcesResponse.statusCode).toBe(409);
    expect(staleSourcesResponse.json()).toMatchObject({ ok: false, reason: "document_mismatch" });
    expect(state.agent.sourcePaths).toEqual(sourcePathsBeforeStaleRequest);

    const staleImportResponse = await app.inject({
      method: "POST",
      url: "/api/v1/documents/import-docx",
      headers: { authorization: `Bearer ${state.token}` },
      payload: {
        relativePath: "imports/missing.docx",
        expectedDocument: { id: document.id, revision: document.revision },
      },
    });
    expect(staleImportResponse.statusCode).toBe(409);
    expect(staleImportResponse.json()).toMatchObject({ ok: false, reason: "document_mismatch" });
    expect(state.agent.bag.documentId).toBe(otherDocument.id);

    const staleRevisionImportResponse = await app.inject({
      method: "POST",
      url: "/api/v1/documents/import-docx",
      headers: { authorization: `Bearer ${state.token}` },
      payload: {
        relativePath: "imports/missing.docx",
        expectedDocument: {
          id: otherDocument.id,
          revision: otherDocument.revision + 1,
        },
      },
    });
    expect(staleRevisionImportResponse.statusCode).toBe(409);
    expect(staleRevisionImportResponse.json()).toMatchObject({
      ok: false,
      reason: "document_mismatch",
    });

    const staleOpenResponse = await app.inject({
      method: "POST",
      url: "/api/v1/documents/open",
      headers: { authorization: `Bearer ${state.token}` },
      payload: {
        relativePath: "paper.md",
        expectedDocument: { id: document.id, revision: document.revision },
      },
    });
    expect(staleOpenResponse.statusCode).toBe(409);
    expect(staleOpenResponse.json()).toMatchObject({
      ok: false,
      reason: "document_mismatch",
    });
    expect(state.agent.bag.documentId).toBe(otherDocument.id);

    syncBagFromDocument(state.agent, document, blocks);
    let releaseImportQueue!: () => void;
    const importQueueGate = new Promise<void>((resolve) => {
      releaseImportQueue = resolve;
    });
    const queuedDocumentSwitch = enqueueChat(async () => {
      await importQueueGate;
      syncBagFromDocument(state.agent, otherDocument, listBlocks(workspace, otherDocument.id));
    });
    const queuedImportResponse = app.inject({
      method: "POST",
      url: "/api/v1/documents/import-docx",
      headers: { authorization: `Bearer ${state.token}` },
      payload: {
        relativePath: "imports/missing.docx",
        expectedDocument: { id: document.id, revision: document.revision },
      },
    });
    const importRespondedEarly = await Promise.race([
      queuedImportResponse.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(importRespondedEarly).toBe(false);
    releaseImportQueue();
    await queuedDocumentSwitch;
    const importAfterSwitchResponse = await queuedImportResponse;
    expect(importAfterSwitchResponse.statusCode).toBe(409);
    expect(importAfterSwitchResponse.json()).toMatchObject({
      ok: false,
      reason: "document_mismatch",
    });
    expect(state.agent.bag.documentId).toBe(otherDocument.id);

    syncBagFromDocument(state.agent, document, blocks);
    process.env.MARGIN_ENGINE = "simple";
    process.env.MARGIN_API_KEY = "test-key";
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      markFetchStarted();
      await completionGate;
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              blockId: blocks[0]!.id,
              after: `${blocks[0]!.text}运行中修改`,
              rationale: "in-flight stale tab test",
              risk: "language",
              evidence: [],
            }),
          },
        }],
      });
    }));
    const proposalCountBeforeInFlightRun = listProposals(workspace, document.id).length;
    const commentCountBeforeInFlightRun = listComments(workspace, document.id).length;
    const inFlightRunResponse = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${document.id}/proposal-runs`,
      headers: { authorization: `Bearer ${state.token}` },
      payload: { blockIds: [blocks[0]!.id] },
    });
    expect(inFlightRunResponse.statusCode).toBe(202);
    const inFlightRunId = inFlightRunResponse.json().runId as string;
    await fetchStarted;
    syncBagFromDocument(state.agent, otherDocument, listBlocks(workspace, otherDocument.id));
    releaseCompletion();

    let finalRun: { status?: string } = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const statusResponse = await app.inject({
        method: "GET",
        url: `/api/v1/proposal-runs/${inFlightRunId}`,
        headers: { authorization: `Bearer ${state.token}` },
      });
      finalRun = statusResponse.json();
      if (finalRun.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(finalRun.status).toBe("superseded");
    expect(listProposals(workspace, document.id)).toHaveLength(proposalCountBeforeInFlightRun);
    expect(listComments(workspace, document.id)).toHaveLength(commentCountBeforeInFlightRun);
  }, 30_000);
});
