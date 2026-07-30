import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BlockSnapshot, DocumentMeta, Proposal } from "@margin/domain";
import {
  getDocument,
  getLatestDecision,
  listBlocks,
  listProposals,
  openDocument,
  openWorkspace,
  saveProposal,
  type Workspace,
} from "@margin/storage-local";
import { afterEach, describe, expect, it } from "vitest";
import {
  isActiveDocumentRequest,
  parseResolveProposalsInput,
  resolveProposalsAtomically,
} from "./proposal-batch.js";

const dirs: string[] = [];
const workspaces: Workspace[] = [];
let proposalSequence = 0;

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    try { workspace.db.close(); } catch { /* ignore */ }
    try { await workspace.releaseLock(); } catch { /* ignore */ }
  }
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function testWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-proposal-batch-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, "paper.md"), "first paragraph\n\nsecond paragraph\n", "utf8");
  const workspace = await openWorkspace(root);
  workspaces.push(workspace);
  const document = openDocument(workspace, "paper.md");
  return { root, workspace, document, blocks: listBlocks(workspace, document.id) };
}

function proposalFor(document: DocumentMeta, block: BlockSnapshot, after?: string): Proposal {
  proposalSequence += 1;
  return {
    schemaVersion: 1,
    id: `batch-proposal-${proposalSequence}`,
    documentId: document.id,
    blockId: block.id,
    baseRevision: document.revision,
    baseHash: block.contentHash,
    before: block.text,
    after: after ?? `${block.text} revised`,
    rationale: "batch test",
    risk: "language",
    evidence: [],
    status: "proposed",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, proposalSequence)).toISOString(),
  };
}

describe("parseResolveProposalsInput", () => {
  it("rejects a stale active-document identity before resolution starts", () => {
    expect(isActiveDocumentRequest("document-a", "document-b")).toBe(false);
    expect(isActiveDocumentRequest(undefined, "document-b")).toBe(false);
    expect(isActiveDocumentRequest("document-b", "document-b")).toBe(true);
  });

  it.each([
    [{ proposalIds: [], expectedRevision: 0, expectedHash: "0123456789abcdef" }, "1 to 100"],
    [{ proposalIds: [""], expectedRevision: 0, expectedHash: "0123456789abcdef" }, "non-empty"],
    [{ proposalIds: ["p1", "p1"], expectedRevision: 0, expectedHash: "0123456789abcdef" }, "unique"],
    [{ proposalIds: ["p1"], expectedRevision: -1, expectedHash: "0123456789abcdef" }, "non-negative"],
    [{ proposalIds: ["p1"], expectedRevision: 0, expectedHash: "not-a-hash" }, "content hash"],
  ])("rejects malformed batch input", (input, message) => {
    expect(() => parseResolveProposalsInput(input)).toThrow(message);
  });
});

describe("resolveProposalsAtomically", () => {
  it("applies every proposal in one revision and safely replays the request", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const proposals = [proposalFor(document, blocks[0]!), proposalFor(document, blocks[1]!)];
    for (const proposal of proposals) saveProposal(workspace, proposal);
    const input = {
      proposalIds: proposals.map((proposal) => proposal.id),
      expectedRevision: document.revision,
      expectedHash: document.contentHash,
    };

    const result = await resolveProposalsAtomically(workspace, document.id, input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.revision).toBe(document.revision + 1);
    expect(result.decisions.map((decision) => decision.kind)).toEqual(["Y", "Y"]);
    const text = fs.readFileSync(path.join(root, "paper.md"), "utf8");
    expect(text).toContain(proposals[0]!.after);
    expect(text).toContain(proposals[1]!.after);

    const replay = await resolveProposalsAtomically(workspace, document.id, input);
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(getDocument(workspace, document.id).revision).toBe(document.revision + 1);
  });

  it("reopens every claimed proposal when strict apply finds a conflict", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const proposals = [
      proposalFor(document, blocks[0]!),
      proposalFor(document, blocks[0]!, "a conflicting revision"),
    ];
    for (const proposal of proposals) saveProposal(workspace, proposal);
    const before = fs.readFileSync(path.join(root, "paper.md"), "utf8");

    const result = await resolveProposalsAtomically(workspace, document.id, {
      proposalIds: proposals.map((proposal) => proposal.id),
      expectedRevision: document.revision,
      expectedHash: document.contentHash,
    });

    expect(result).toEqual({ ok: false, reason: "conflicting_proposals" });
    expect(getDocument(workspace, document.id)).toEqual(document);
    expect(fs.readFileSync(path.join(root, "paper.md"), "utf8")).toBe(before);
    expect(listProposals(workspace, document.id).map((proposal) => proposal.status))
      .toEqual(["proposed", "proposed"]);
    expect(proposals.map((proposal) => getLatestDecision(workspace, proposal.id)?.kind))
      .toEqual(["Y", "Y"]);
    expect(workspace.db.prepare("SELECT * FROM apply_events").all()).toEqual([]);
  });

  it("does not claim any proposal when an id is unknown", async () => {
    const { workspace, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]!);
    saveProposal(workspace, proposal);

    await expect(resolveProposalsAtomically(workspace, document.id, {
      proposalIds: [proposal.id, "missing-proposal"],
      expectedRevision: document.revision,
      expectedHash: document.contentHash,
    })).rejects.toThrow("proposal not found");

    expect(listProposals(workspace, document.id)[0]?.status).toBe("proposed");
    expect(getLatestDecision(workspace, proposal.id)).toBeUndefined();
  });
});
