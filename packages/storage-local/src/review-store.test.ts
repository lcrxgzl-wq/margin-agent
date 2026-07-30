import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentHash, type BlockSnapshot, type DocumentMeta, type Proposal } from "@margin/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyApproved,
  blocksToMarkdown,
  exportPacket,
  getDocument,
  listBlocks,
  listDocumentTimeline,
  listProposals,
  openDocument,
  openWorkspace,
  recoverApplyJournals,
  recoverDecidedProposals,
  saveDecision,
  saveProposal,
  saveProposalResolutionBatch,
  type Workspace,
} from "./index.js";

const dirs: string[] = [];
const workspaces: Workspace[] = [];
let proposalSequence = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of workspaces.splice(0)) {
    try { ws.db.close(); } catch { /* ignore */ }
    try { await ws.releaseLock(); } catch { /* ignore */ }
  }
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function testWorkspace(markdown = "first paragraph\n\nsecond paragraph\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-review-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, "paper.md"), markdown, "utf8");
  const ws = await openWorkspace(root);
  workspaces.push(ws);
  const document = openDocument(ws, "paper.md");
  return { root, ws, document, blocks: listBlocks(ws, document.id) };
}

function proposalFor(
  document: DocumentMeta,
  block: BlockSnapshot,
  overrides: Partial<Proposal> = {},
): Proposal {
  proposalSequence += 1;
  return {
    schemaVersion: 1,
    id: `proposal-${proposalSequence}`,
    documentId: document.id,
    blockId: block.id,
    baseRevision: document.revision,
    baseHash: block.contentHash,
    before: block.text,
    after: `${block.text} revised`,
    rationale: "test revision",
    risk: "language",
    evidence: [],
    status: "proposed",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, proposalSequence)).toISOString(),
    ...overrides,
  };
}

describe("applyApproved", () => {
  it("supersedes stale proposals when an externally changed Markdown file is reopened", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]);
    saveProposal(ws, proposal);
    saveDecision(ws, proposal.id, "Y");
    fs.writeFileSync(path.join(root, "paper.md"), "external replacement\n", "utf8");

    const reopened = openDocument(ws, "paper.md");

    expect(reopened.revision).toBe(document.revision + 1);
    expect(listProposals(ws, document.id, "decided")).toHaveLength(0);
    expect(listProposals(ws, document.id)[0]?.status).toBe("superseded");
  });

  it("finalizes an apply journal when the replacement reached disk before a crash", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]);
    saveProposal(ws, proposal);
    const decision = saveDecision(ws, proposal.id, "Y");
    const nextBlocks = blocks.map((block) => block.id === proposal.blockId
      ? { ...block, text: proposal.after, contentHash: contentHash(proposal.after) }
      : block);
    const nextText = blocksToMarkdown(nextBlocks);
    const nextHash = contentHash(nextText);
    const now = new Date().toISOString();
    const payload = {
      schemaVersion: 1,
      documentId: document.id,
      relativePath: document.relativePath,
      beforeRevision: document.revision,
      afterRevision: document.revision + 1,
      beforeHash: document.contentHash,
      afterHash: nextHash,
      updatedAt: now,
      blocks: nextBlocks,
      proposalIds: [proposal.id],
      events: [{
        schemaVersion: 1,
        id: "crash-event",
        documentId: document.id,
        proposalId: proposal.id,
        decisionId: decision.id,
        ok: true,
        reason: "ok",
        beforeRevision: document.revision,
        afterRevision: document.revision + 1,
        beforeHash: document.contentHash,
        afterHash: nextHash,
        createdAt: now,
      }],
    };
    ws.db.prepare(
      `INSERT INTO apply_journals (
        document_id, relative_path, before_hash, after_hash, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      document.id, document.relativePath, document.contentHash, nextHash,
      JSON.stringify(payload), now,
    );
    fs.writeFileSync(path.join(root, "paper.md"), nextText, "utf8");

    workspaces.splice(workspaces.indexOf(ws), 1);
    ws.db.close();
    await ws.releaseLock();
    const reopened = await openWorkspace(root);
    workspaces.push(reopened);
    await recoverApplyJournals(reopened);

    expect(getDocument(reopened, document.id)).toMatchObject({
      revision: document.revision + 1,
      contentHash: nextHash,
    });
    expect(listBlocks(reopened, document.id)[0]?.text).toBe(proposal.after);
    expect(listProposals(reopened, document.id)[0]?.status).toBe("superseded");
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM apply_journals").get())
      .toEqual({ count: 0 });
    expect(reopened.db.prepare(
      "SELECT proposal_id, ok, after_hash FROM apply_events",
    ).get()).toEqual({ proposal_id: proposal.id, ok: 1, after_hash: nextHash });
  });

  it("rolls back a pre-replacement journal and leaves its decision retryable", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]);
    saveProposal(ws, proposal);
    const decision = saveDecision(ws, proposal.id, "Y");
    const nextBlocks = blocks.map((block) => block.id === proposal.blockId
      ? { ...block, text: proposal.after, contentHash: contentHash(proposal.after) }
      : block);
    const nextHash = contentHash(blocksToMarkdown(nextBlocks));
    const now = new Date().toISOString();
    ws.db.prepare(
      `INSERT INTO apply_journals (
        document_id, relative_path, before_hash, after_hash, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      document.id,
      document.relativePath,
      document.contentHash,
      nextHash,
      JSON.stringify({
        schemaVersion: 1,
        documentId: document.id,
        relativePath: document.relativePath,
        beforeRevision: document.revision,
        afterRevision: document.revision + 1,
        beforeHash: document.contentHash,
        afterHash: nextHash,
        updatedAt: now,
        blocks: nextBlocks,
        proposalIds: [proposal.id],
        events: [{
          schemaVersion: 1,
          id: "not-written-event",
          documentId: document.id,
          proposalId: proposal.id,
          decisionId: decision.id,
          ok: true,
          reason: "ok",
          beforeRevision: document.revision,
          afterRevision: document.revision + 1,
          beforeHash: document.contentHash,
          afterHash: nextHash,
          createdAt: now,
        }],
      }),
      now,
    );

    await recoverApplyJournals(ws);

    expect(getDocument(ws, document.id)).toEqual(document);
    expect(listProposals(ws, document.id, "decided")).toHaveLength(1);
    expect(ws.db.prepare("SELECT COUNT(*) AS count FROM apply_journals").get())
      .toEqual({ count: 0 });
    await recoverDecidedProposals(ws);
    expect(getDocument(ws, document.id).revision).toBe(document.revision + 1);
  });

  it("preserves and recovers a committed decision across a real workspace reopen", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]);
    saveProposal(ws, proposal);
    saveDecision(ws, proposal.id, "Y");

    workspaces.splice(workspaces.indexOf(ws), 1);
    ws.db.close();
    await ws.releaseLock();
    const reopened = await openWorkspace(root);
    workspaces.push(reopened);

    expect(listProposals(reopened, document.id, "decided")).toHaveLength(1);
    await recoverDecidedProposals(reopened);

    expect(fs.readFileSync(path.join(root, "paper.md"), "utf8")).toContain(proposal.after);
    expect(listProposals(reopened, document.id, "decided")).toHaveLength(0);
    expect(listProposals(reopened, document.id)[0]?.status).toBe("superseded");
  });

  it("recovers an accept-all batch as one document revision after a host stop", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const proposals = [proposalFor(document, blocks[0]), proposalFor(document, blocks[1])];
    for (const proposal of proposals) saveProposal(ws, proposal);
    saveProposalResolutionBatch(
      ws,
      document.id,
      proposals.map((proposal) => proposal.id),
      document.revision,
      document.contentHash,
    );

    workspaces.splice(workspaces.indexOf(ws), 1);
    ws.db.close();
    await ws.releaseLock();
    const reopened = await openWorkspace(root);
    workspaces.push(reopened);

    await recoverDecidedProposals(reopened);

    expect(getDocument(reopened, document.id).revision).toBe(document.revision + 1);
    const text = fs.readFileSync(path.join(root, "paper.md"), "utf8");
    expect(text).toContain(proposals[0]!.after);
    expect(text).toContain(proposals[1]!.after);
    expect(listProposals(reopened, document.id).map((proposal) => proposal.status))
      .toEqual(["superseded", "superseded"]);
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM proposal_resolution_batches").get())
      .toEqual({ count: 0 });
  });

  it("reopens every member when a stopped accept-all batch cannot apply in full", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const proposals = [
      proposalFor(document, blocks[0]),
      proposalFor(document, blocks[0], { after: "conflicting revision" }),
    ];
    for (const proposal of proposals) saveProposal(ws, proposal);
    saveProposalResolutionBatch(
      ws,
      document.id,
      proposals.map((proposal) => proposal.id),
      document.revision,
      document.contentHash,
    );
    const before = fs.readFileSync(path.join(root, "paper.md"), "utf8");

    workspaces.splice(workspaces.indexOf(ws), 1);
    ws.db.close();
    await ws.releaseLock();
    const reopened = await openWorkspace(root);
    workspaces.push(reopened);

    await recoverDecidedProposals(reopened);

    expect(getDocument(reopened, document.id)).toEqual(document);
    expect(fs.readFileSync(path.join(root, "paper.md"), "utf8")).toBe(before);
    expect(listProposals(reopened, document.id).map((proposal) => proposal.status))
      .toEqual(["proposed", "proposed"]);
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM proposal_resolution_batches").get())
      .toEqual({ count: 0 });
  });

  it("recovers a decision committed before the host stopped", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]);
    saveProposal(ws, proposal);
    saveDecision(ws, proposal.id, "Y");

    await recoverDecidedProposals(ws);

    expect(fs.readFileSync(path.join(root, "paper.md"), "utf8")).toContain(proposal.after);
    expect(listProposals(ws, document.id, "decided")).toHaveLength(0);
    expect(listProposals(ws, document.id).find((item) => item.id === proposal.id)?.status)
      .toBe("superseded");
  });

  it("records a committed rejection during startup recovery", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]);
    saveProposal(ws, proposal);
    saveDecision(ws, proposal.id, "N");

    await recoverDecidedProposals(ws);

    expect(listDocumentTimeline(ws, document.id)[0]).toMatchObject({
      proposalId: proposal.id,
      decisionKind: "N",
      ok: false,
      reason: "rejected",
    });
    expect(listProposals(ws, document.id, "decided")).toHaveLength(0);
  });

  it("persists structured selection operation metadata", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0], {
      after: "first changed paragraph",
      operation: {
        kind: "rewrite",
        scope: "selection",
        selection: { start: 6, end: 15, before: "paragraph", after: "changed paragraph" },
      },
    });
    saveProposal(ws, proposal);

    expect(listProposals(ws, document.id)[0]?.operation).toEqual(proposal.operation);
  });

  it("persists structured table-cell metadata in the shared proposal queue", async () => {
    const { ws, document, blocks } = await testWorkspace("A\tB\n");
    const proposal = proposalFor(document, blocks[0], {
      before: "B",
      after: "C",
      tableCell: { address: "B1", row: 1, column: 2, before: "B", after: "C" },
    });
    saveProposal(ws, proposal);
    expect(listProposals(ws, document.id)[0]?.tableCell).toEqual(proposal.tableCell);
  });

  it("applies only explicitly requested proposal ids", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const hidden = proposalFor(document, blocks[0], { after: "hidden revision" });
    const requested = proposalFor(document, blocks[1], { after: "requested revision" });
    saveProposal(ws, hidden);
    saveProposal(ws, requested);
    saveDecision(ws, hidden.id, "Y");
    saveDecision(ws, requested.id, "Y");

    const result = await applyApproved(
      ws,
      document.id,
      document.revision,
      document.contentHash,
      [requested.id],
    );

    expect(result.ok).toBe(true);
    const text = fs.readFileSync(path.join(root, "paper.md"), "utf8");
    expect(text).toContain("requested revision");
    expect(text).not.toContain("hidden revision");
    expect(listProposals(ws, document.id, "decided").map((proposal) => proposal.id)).toContain(hidden.id);
  });

  it("keeps a proposal retryable until an explicit resolve apply succeeds", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]);
    saveProposal(ws, proposal);
    saveDecision(ws, proposal.id, "Y", undefined, undefined, false);

    expect(listProposals(ws, document.id, "proposed").map((item) => item.id)).toContain(proposal.id);
    const result = await applyApproved(
      ws,
      document.id,
      document.revision,
      document.contentHash,
      [proposal.id],
    );

    expect(result.ok).toBe(true);
    expect(listProposals(ws, document.id, "proposed")).toHaveLength(0);
  });

  it("serializes concurrent applies for one workspace", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]);
    saveProposal(ws, proposal);
    saveDecision(ws, proposal.id, "Y");

    const originalCopyFileSync = fs.copyFileSync.bind(fs);
    let secondApply: ReturnType<typeof applyApproved> | undefined;
    let launchedSecond = false;
    vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      if (!launchedSecond) {
        launchedSecond = true;
        secondApply = applyApproved(
          ws,
          document.id,
          document.revision,
          document.contentHash,
        );
      }
      originalCopyFileSync(source, destination, mode);
    });

    const firstApply = applyApproved(
      ws,
      document.id,
      document.revision,
      document.contentHash,
    );
    await Promise.resolve();
    expect(secondApply).toBeDefined();

    const [firstResult, secondResult] = await Promise.all([firstApply, secondApply!]);

    expect(firstResult.ok).toBe(true);
    expect(secondResult).toEqual({ ok: false, reason: "stale" });
    expect(getDocument(ws, document.id).revision).toBe(document.revision + 1);
    expect(fs.readFileSync(path.join(root, "paper.md"), "utf8")).toContain(proposal.after);
    expect(fs.readdirSync(path.join(root, ".margin", "backups"))).toHaveLength(1);
    expect(ws.db.prepare(
      `SELECT proposal_id, ok, before_revision, after_revision
       FROM apply_events`,
    ).all()).toEqual([
      expect.objectContaining({
        proposal_id: proposal.id,
        ok: 1,
        before_revision: document.revision,
        after_revision: document.revision + 1,
      }),
    ]);
  });

  it("records success only for proposals actually written to the document", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const valid = proposalFor(document, blocks[0]);
    const missing = proposalFor(document, blocks[1], {
      blockId: "missing-block",
      baseHash: contentHash("missing block"),
    });
    saveProposal(ws, valid);
    saveProposal(ws, missing);
    saveDecision(ws, valid.id, "Y");
    saveDecision(ws, missing.id, "Y");

    const prepareSpy = vi.spyOn(ws.db, "prepare");
    const result = await applyApproved(
      ws,
      document.id,
      document.revision,
      document.contentHash,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.revision).toBe(document.revision + 1);
    expect(fs.readFileSync(path.join(root, "paper.md"), "utf8")).toContain(valid.after);

    const events = ws.db.prepare(
      `SELECT proposal_id, ok, reason, after_revision
       FROM apply_events ORDER BY proposal_id`,
    ).all() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.proposal_id === valid.id)).toMatchObject({
      ok: 1,
      reason: "ok",
      after_revision: document.revision + 1,
    });
    expect(events.find((event) => event.proposal_id === missing.id)).toMatchObject({
      ok: 0,
      reason: "missing",
      after_revision: null,
    });
    expect(listProposals(ws, document.id).map((proposal) => proposal.status)).toEqual([
      "superseded",
      "superseded",
    ]);

    const decisionQueries = prepareSpy.mock.calls.filter(([sql]) =>
      /FROM decisions\b/i.test(String(sql)),
    );
    expect(decisionQueries).toHaveLength(1);
  });

  it("applies a strict valid batch in one document revision", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const first = proposalFor(document, blocks[0]);
    const second = proposalFor(document, blocks[1]);
    saveProposal(ws, first);
    saveProposal(ws, second);
    saveDecision(ws, first.id, "Y");
    saveDecision(ws, second.id, "Y");

    const result = await applyApproved(
      ws,
      document.id,
      document.revision,
      document.contentHash,
      [first.id, second.id],
      { requireAll: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.revision).toBe(document.revision + 1);
    const text = fs.readFileSync(path.join(root, "paper.md"), "utf8");
    expect(text).toContain(first.after);
    expect(text).toContain(second.after);
    expect(listProposals(ws, document.id).every((proposal) => proposal.status === "superseded"))
      .toBe(true);
  });

  it("leaves the document untouched when any strict batch proposal is invalid", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const valid = proposalFor(document, blocks[0]);
    const missing = proposalFor(document, blocks[1], {
      blockId: "missing-block",
      baseHash: contentHash("missing block"),
    });
    saveProposal(ws, valid);
    saveProposal(ws, missing);
    saveDecision(ws, valid.id, "Y");
    saveDecision(ws, missing.id, "Y");
    const beforeText = fs.readFileSync(path.join(root, "paper.md"), "utf8");

    const result = await applyApproved(
      ws,
      document.id,
      document.revision,
      document.contentHash,
      [valid.id, missing.id],
      { requireAll: true },
    );

    expect(result).toEqual({ ok: false, reason: "batch_not_applicable" });
    expect(getDocument(ws, document.id)).toEqual(document);
    expect(fs.readFileSync(path.join(root, "paper.md"), "utf8")).toBe(beforeText);
    expect(ws.db.prepare("SELECT * FROM apply_events").all()).toEqual([]);
    expect(listProposals(ws, document.id).every((proposal) => proposal.status === "decided"))
      .toBe(true);
  });

  it("rejects conflicting strict batch targets without writing", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const first = proposalFor(document, blocks[0]);
    const second = proposalFor(document, blocks[0], { after: "another revision" });
    saveProposal(ws, first);
    saveProposal(ws, second);
    saveDecision(ws, first.id, "Y");
    saveDecision(ws, second.id, "Y");
    const beforeText = fs.readFileSync(path.join(root, "paper.md"), "utf8");

    const result = await applyApproved(
      ws,
      document.id,
      document.revision,
      document.contentHash,
      [first.id, second.id],
      { requireAll: true },
    );

    expect(result).toEqual({ ok: false, reason: "conflicting_proposals" });
    expect(getDocument(ws, document.id)).toEqual(document);
    expect(fs.readFileSync(path.join(root, "paper.md"), "utf8")).toBe(beforeText);
  });

  it("persists failed attempts without rewriting or revising when none can land", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const stale = proposalFor(document, blocks[0], { baseHash: contentHash("old text") });
    const missing = proposalFor(document, blocks[1], {
      blockId: "missing-block",
      baseHash: contentHash("missing block"),
    });
    saveProposal(ws, stale);
    saveProposal(ws, missing);
    saveDecision(ws, stale.id, "Y");
    saveDecision(ws, missing.id, "E", "edited missing block");
    const beforeText = fs.readFileSync(path.join(root, "paper.md"), "utf8");
    const beforeBlocks = listBlocks(ws, document.id);

    const result = await applyApproved(
      ws,
      document.id,
      document.revision,
      document.contentHash,
    );

    expect(result).toEqual({ ok: false, reason: "nothing_to_apply" });
    expect(getDocument(ws, document.id)).toEqual(document);
    expect(listBlocks(ws, document.id)).toEqual(beforeBlocks);
    expect(fs.readFileSync(path.join(root, "paper.md"), "utf8")).toBe(beforeText);
    expect(fs.readdirSync(path.join(root, ".margin", "backups"))).toEqual([]);

    const events = ws.db.prepare(
      `SELECT proposal_id, ok, reason, after_revision, after_hash
       FROM apply_events ORDER BY proposal_id`,
    ).all() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.proposal_id === stale.id)).toMatchObject({
      ok: 0,
      reason: "stale",
      after_revision: null,
      after_hash: null,
    });
    expect(events.find((event) => event.proposal_id === missing.id)).toMatchObject({
      ok: 0,
      reason: "missing",
      after_revision: null,
      after_hash: null,
    });
    expect(listProposals(ws, document.id).every((proposal) => proposal.status === "superseded"))
      .toBe(true);
  });

  it("records rejected decisions in the review timeline", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const rejected = proposalFor(document, blocks[0]);
    saveProposal(ws, rejected);
    saveDecision(ws, rejected.id, "N", undefined, "keep the original");

    const result = await applyApproved(
      ws,
      document.id,
      document.revision,
      document.contentHash,
    );

    expect(result).toEqual({ ok: false, reason: "nothing_to_apply" });
    expect(listDocumentTimeline(ws, document.id)).toEqual([
      expect.objectContaining({
        proposalId: rejected.id,
        decisionKind: "N",
        ok: false,
        reason: "rejected",
      }),
    ]);
  });

  it("exposes proposal fragments and operation kind in the review timeline", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const edited = proposalFor(document, blocks[0], {
      after: "FIRST paragraph",
      operation: {
        kind: "polish",
        scope: "selection",
        selection: { start: 0, end: 5, before: "first", after: "FIRST" },
      },
    });
    saveProposal(ws, edited);
    saveDecision(ws, edited.id, "E", "first paragraph hand edited");

    const result = await applyApproved(
      ws,
      document.id,
      document.revision,
      document.contentHash,
    );

    expect(result.ok).toBe(true);
    expect(listDocumentTimeline(ws, document.id)).toEqual([
      expect.objectContaining({
        proposalId: edited.id,
        decisionKind: "E",
        operationKind: "polish",
        ok: true,
        beforeText: blocks[0].text,
        afterText: "first paragraph hand edited",
      }),
    ]);
  });

  it("restores the document when the database transaction fails after file replacement", async () => {
    const { root, ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]);
    saveProposal(ws, proposal);
    saveDecision(ws, proposal.id, "Y");
    const before = fs.readFileSync(path.join(root, "paper.md"), "utf8");
    const prepare = ws.db.prepare.bind(ws.db);
    vi.spyOn(ws.db, "prepare").mockImplementation((sql: string) => {
      if (/UPDATE documents SET revision/.test(sql)) throw new Error("injected db failure");
      return prepare(sql);
    });

    await expect(
      applyApproved(ws, document.id, document.revision, document.contentHash),
    ).rejects.toThrow("injected db failure");

    expect(fs.readFileSync(path.join(root, "paper.md"), "utf8")).toBe(before);
    expect(getDocument(ws, document.id).revision).toBe(document.revision);
  });
});

describe("exportPacket", () => {
  it("loads proposals once and batches their latest decisions", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]);
    saveProposal(ws, proposal);
    const decision = saveDecision(ws, proposal.id, "Y");
    const prepareSpy = vi.spyOn(ws.db, "prepare");

    const packet = exportPacket(ws, document.id);

    expect(packet.proposals).toHaveLength(1);
    expect(packet.decisions).toEqual([decision]);
    const proposalQueries = prepareSpy.mock.calls.filter(([sql]) =>
      /SELECT \* FROM proposals WHERE document_id/i.test(String(sql)),
    );
    const decisionQueries = prepareSpy.mock.calls.filter(([sql]) =>
      /FROM decisions\b/i.test(String(sql)),
    );
    expect(proposalQueries).toHaveLength(1);
    expect(decisionQueries).toHaveLength(1);
  });
});
