import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Proposal, type ReviewChecklistRunDraft } from "@margin/domain";
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyApproved,
  getDocument,
  listActiveReviewChecklists,
  listBlocks,
  listComments,
  listDocumentTimeline,
  openDocxDocument,
  openWorkspace,
  readNativeDocx,
  recoverDecidedProposals,
  recoverNativeSaveJournals,
  reconcileRegisteredDocxDocuments,
  replaceDocumentComments,
  saveDecision,
  saveNativeDocx,
  saveProposal,
  saveReviewChecklistRun,
  type Workspace,
} from "./index.js";
import { docxContentHash, extractDocxBlocks, readDocxXml } from "./office-docx.js";

const dirs: string[] = [];
const workspaces: Workspace[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const workspace of workspaces.splice(0)) {
    try { workspace.db.close(); } catch { /* ignore */ }
    try { await workspace.releaseLock(); } catch { /* ignore */ }
  }
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function docxFixture(firstParagraph = "Before", score = "90"): Promise<Buffer> {
  const document = new Document({
    sections: [{
      children: [
        new Paragraph(firstParagraph),
        new Table({
          rows: [
            new TableRow({ children: [
              new TableCell({ children: [new Paragraph("姓名")] }),
              new TableCell({ children: [new Paragraph("分数")] }),
            ] }),
            new TableRow({ children: [
              new TableCell({ children: [new Paragraph("张三")] }),
              new TableCell({ children: [new Paragraph(score)] }),
            ] }),
          ],
        }),
        new Paragraph("After table"),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

async function testWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-native-docx-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, "paper.docx"), await docxFixture());
  const workspace = await openWorkspace(root);
  workspaces.push(workspace);
  const document = await openDocxDocument(workspace, "paper.docx");
  return { root, workspace, document, blocks: listBlocks(workspace, document.id) };
}

function proposal(documentId: string, block: ReturnType<typeof listBlocks>[number]): Proposal {
  return {
    schemaVersion: 1,
    id: `proposal-${block.id}`,
    documentId,
    blockId: block.id,
    baseRevision: 0,
    baseHash: block.contentHash,
    before: block.text,
    after: `${block.text} revised`,
    rationale: "native DOCX regression",
    risk: "language",
    evidence: [],
    status: "proposed",
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  };
}

describe("native DOCX storage", () => {
  it("serializes a human save and Agent apply for the same document", async () => {
    const { workspace, document, blocks } = await testWorkspace();
    const pending = proposal(document.id, blocks[0]!);
    saveProposal(workspace, pending);
    saveDecision(workspace, pending.id, "Y");
    const humanEdit = await docxFixture("Human wins the queue");

    const save = saveNativeDocx(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      humanEdit,
    );
    const apply = applyApproved(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
    );
    const [saveResult, applyResult] = await Promise.all([save, apply]);

    expect(saveResult.ok).toBe(true);
    expect(applyResult).toEqual({ ok: false, reason: "stale" });
    expect(listBlocks(workspace, document.id)[0]?.text).toBe("Human wins the queue");
  });

  it("rejects a human save when the registered DOCX is retargeted through a symlink", async () => {
    const { root, workspace, document } = await testWorkspace();
    const registeredPath = path.join(root, "paper.docx");
    const originalTarget = path.join(root, "paper-original.docx");
    const replacementTarget = path.join(root, "paper-replacement.docx");
    const originalBuffer = fs.readFileSync(registeredPath);
    fs.renameSync(registeredPath, originalTarget);
    fs.writeFileSync(replacementTarget, originalBuffer);
    fs.symlinkSync(replacementTarget, registeredPath, "file");

    await expect(saveNativeDocx(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      await docxFixture("Must not be written"),
    )).rejects.toThrow("registered document path target changed");

    expect(fs.readFileSync(replacementTarget).equals(originalBuffer)).toBe(true);
    expect(getDocument(workspace, document.id)).toEqual(document);
    expect(fs.readdirSync(path.join(root, ".margin", "backups"))).toEqual([]);
  });

  it("does not overwrite an external edit made while preparing a human save", async () => {
    const { root, workspace, document } = await testWorkspace();
    const documentPath = path.join(root, "paper.docx");
    const humanEdit = await docxFixture("Human edit");
    const externalEdit = await docxFixture("External edit");
    const originalRead = fs.readFileSync.bind(fs);
    let documentReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === documentPath && ++documentReads === 2) {
        fs.writeFileSync(documentPath, externalEdit);
      }
      return originalRead(file, options as never);
    }) as typeof fs.readFileSync);

    const result = await saveNativeDocx(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      humanEdit,
    );

    expect(result).toEqual({ ok: false, reason: "external_change" });
    expect((await extractDocxBlocks(originalRead(documentPath)))[0]?.text).toBe("External edit");
    expect(getDocument(workspace, document.id)).toEqual(document);
  });

  it("does not overwrite an external edit made while preparing an Agent apply", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const pending = proposal(document.id, blocks[0]!);
    saveProposal(workspace, pending);
    saveDecision(workspace, pending.id, "Y");
    const documentPath = path.join(root, "paper.docx");
    const externalEdit = await docxFixture("External edit");
    const originalRead = fs.readFileSync.bind(fs);
    let documentReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === documentPath && ++documentReads === 2) {
        fs.writeFileSync(documentPath, externalEdit);
      }
      return originalRead(file, options as never);
    }) as typeof fs.readFileSync);

    const result = await applyApproved(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
    );

    expect(result).toEqual({ ok: false, reason: "external_change" });
    expect((await extractDocxBlocks(originalRead(documentPath)))[0]?.text).toBe("External edit");
    expect(getDocument(workspace, document.id)).toEqual(document);
  });

  it("rejects Agent apply when the registered DOCX is retargeted through a symlink", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const pending = proposal(document.id, blocks[0]!);
    saveProposal(workspace, pending);
    saveDecision(workspace, pending.id, "Y");
    const registeredPath = path.join(root, "paper.docx");
    const originalTarget = path.join(root, "paper-original.docx");
    const replacementTarget = path.join(root, "paper-replacement.docx");
    const originalBuffer = fs.readFileSync(registeredPath);
    fs.renameSync(registeredPath, originalTarget);
    fs.writeFileSync(replacementTarget, originalBuffer);
    fs.symlinkSync(replacementTarget, registeredPath, "file");

    await expect(applyApproved(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
    )).rejects.toThrow("registered document path target changed");

    expect(fs.readFileSync(replacementTarget).equals(originalBuffer)).toBe(true);
    expect(getDocument(workspace, document.id)).toEqual(document);
    expect(workspace.db.prepare("SELECT status FROM proposals WHERE id = ?").get(pending.id))
      .toEqual({ status: "decided" });
    expect(fs.readdirSync(path.join(root, ".margin", "backups"))).toEqual([]);
  });

  it("retries opening a DOCX that changes while its first snapshot is parsed", async () => {
    const { root, workspace, document } = await testWorkspace();
    const documentPath = path.join(root, "paper.docx");
    const intermediate = await docxFixture("Intermediate open snapshot");
    const latest = await docxFixture("Latest open snapshot");
    fs.writeFileSync(documentPath, intermediate);
    const originalRead = fs.readFileSync.bind(fs);
    let documentReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === documentPath && ++documentReads === 2) {
        fs.writeFileSync(documentPath, latest);
      }
      return originalRead(file, options as never);
    }) as typeof fs.readFileSync);

    const reopened = await openDocxDocument(workspace, "paper.docx");

    expect(documentReads).toBe(5);
    expect(reopened).toMatchObject({
      id: document.id,
      revision: document.revision + 1,
      contentHash: docxContentHash(latest),
    });
    expect(listBlocks(workspace, document.id)[0]?.text).toBe("Latest open snapshot");
  });

  it("does not parse an unchanged registered DOCX", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const documentPath = path.join(root, "paper.docx");
    const invalidDocx = Buffer.from("deliberately invalid DOCX bytes");
    const invalidHash = docxContentHash(invalidDocx);
    fs.writeFileSync(documentPath, invalidDocx);
    workspace.db.prepare(
      "UPDATE documents SET content_hash = ? WHERE id = ?",
    ).run(invalidHash, document.id);

    await expect(openDocxDocument(workspace, "paper.docx")).resolves.toMatchObject({
      id: document.id,
      revision: document.revision,
      contentHash: invalidHash,
    });
    await expect(reconcileRegisteredDocxDocuments(workspace)).resolves.toBe(0);
    expect(listBlocks(workspace, document.id)).toEqual(blocks);
  });

  it("retries reconciliation when a DOCX changes during parsing", async () => {
    const { root, workspace, document } = await testWorkspace();
    const documentPath = path.join(root, "paper.docx");
    const intermediate = await docxFixture("Intermediate snapshot");
    const latest = await docxFixture("Latest reconcile snapshot");
    fs.writeFileSync(documentPath, intermediate);
    const originalRead = fs.readFileSync.bind(fs);
    let documentReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === documentPath && ++documentReads === 3) {
        fs.writeFileSync(documentPath, latest);
      }
      return originalRead(file, options as never);
    }) as typeof fs.readFileSync);

    await expect(reconcileRegisteredDocxDocuments(workspace)).resolves.toBe(1);

    expect(documentReads).toBe(7);
    expect(getDocument(workspace, document.id)).toMatchObject({
      revision: document.revision + 1,
      contentHash: docxContentHash(latest),
    });
    expect(listBlocks(workspace, document.id)[0]?.text).toBe("Latest reconcile snapshot");
  });

  it("skips reconciliation when a DOCX never reaches a stable snapshot", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const documentPath = path.join(root, "paper.docx");
    const first = await docxFixture("Changing snapshot A");
    const second = await docxFixture("Changing snapshot B");
    fs.writeFileSync(documentPath, first);
    const originalRead = fs.readFileSync.bind(fs);
    let documentReads = 0;
    let writeSecond = true;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === documentPath) {
        documentReads += 1;
        if (documentReads >= 3 && documentReads % 2 === 1) {
          fs.writeFileSync(documentPath, writeSecond ? second : first);
          writeSecond = !writeSecond;
        }
      }
      return originalRead(file, options as never);
    }) as typeof fs.readFileSync);

    await expect(reconcileRegisteredDocxDocuments(workspace)).resolves.toBe(0);

    expect(documentReads).toBe(9);
    expect(getDocument(workspace, document.id)).toEqual(document);
    expect(listBlocks(workspace, document.id)).toEqual(blocks);
  });

  it("rejects an oversized registered DOCX before parsing or reconciling it", async () => {
    const { root, workspace, document } = await testWorkspace();
    const largePath = path.join(root, "paper.docx");
    fs.truncateSync(largePath, 50 * 1024 * 1024 + 1);

    expect(() => readNativeDocx(workspace, document.id)).toThrow(/too large.*50 MiB/);
    await expect(reconcileRegisteredDocxDocuments(workspace))
      .rejects.toThrow(/too large.*50 MiB/);
  });

  it("saves a paragraph-only human edit by patching the original OOXML", async () => {
    const { root, workspace, document, blocks: beforeBlocks } = await testWorkspace();
    const edited = await docxFixture("Human edit");
    replaceDocumentComments(workspace, document.id, [{
      id: "comment-before-native-save",
      blockId: beforeBlocks[0]!.id,
      text: "stale after save",
      severity: "info",
      runId: "scan-before-native-save",
      source: "test",
    }]);

    const result = await saveNativeDocx(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      edited,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.saveMode).toBe("ooxml_patch");
    expect(result.document.revision).toBe(document.revision + 1);
    expect(result.blocks.map((block) => block.kind)).toEqual(["paragraph", "table", "paragraph"]);
    expect(result.blocks[0]?.text).toBe("Human edit");
    expect(result.blocks[1]?.text).toBe("姓名\t分数\n张三\t90");
    expect(beforeBlocks[0]?.id).toMatch(/^ooxml-p-0-/);
    expect(result.blocks[0]?.id).toMatch(/^ooxml-p-0-/);
    expect(fs.readdirSync(path.join(root, ".margin", "backups"))).toHaveLength(1);
    expect(listComments(workspace, document.id)).toEqual([]);
    await expect(saveNativeDocx(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      edited,
    )).resolves.toEqual({ ok: false, reason: "stale" });
  });

  it("preserves common formatting edits in the original OOXML package", async () => {
    const { workspace, document } = await testWorkspace();
    const formatted = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph({ children: [new TextRun({ text: "Before", bold: true })] }),
        new Table({ rows: [
          new TableRow({ children: [
            new TableCell({ children: [new Paragraph("姓名")] }),
            new TableCell({ children: [new Paragraph("分数")] }),
          ] }),
          new TableRow({ children: [
            new TableCell({ children: [new Paragraph("张三")] }),
            new TableCell({ children: [new Paragraph("90")] }),
          ] }),
        ] }),
        new Paragraph("After table"),
      ] }],
    })));

    const saved = await saveNativeDocx(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      formatted,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.saveMode).toBe("ooxml_patch");
    expect(await readDocxXml(formatted)).toContain("<w:b");
    expect(await readDocxXml(readNativeDocx(workspace, document.id))).toContain("<w:b");
  });

  it("preserves table text edits without rebuilding the package", async () => {
    const { workspace, document } = await testWorkspace();
    const edited = await docxFixture("Before", "95");

    const saved = await saveNativeDocx(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      edited,
    );

    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.saveMode).toBe("ooxml_patch");
    expect(saved.blocks.find((block) => block.kind === "table")?.text)
      .toBe("姓名\t分数\n张三\t95");
  });

  it("requires explicit rebuild permission for table structure changes", async () => {
    const { workspace, document } = await testWorkspace();
    const changed = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph("Before"),
        new Table({ rows: [
          new TableRow({ children: [
            new TableCell({ children: [new Paragraph("姓名")] }),
            new TableCell({ children: [new Paragraph("分数")] }),
          ] }),
          new TableRow({ children: [
            new TableCell({ children: [new Paragraph("张三")] }),
            new TableCell({ children: [new Paragraph("90")] }),
          ] }),
          new TableRow({ children: [
            new TableCell({ children: [new Paragraph("李四")] }),
            new TableCell({ children: [new Paragraph("88")] }),
          ] }),
        ] }),
        new Paragraph("After table"),
      ] }],
    })));

    await expect(saveNativeDocx(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      changed,
    )).resolves.toMatchObject({ ok: false, reason: "rebuild_required" });
  });

  it("reconciles a DOCX changed between file and database commits", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const pending = proposal(document.id, blocks[0]!);
    saveProposal(workspace, pending);
    replaceDocumentComments(workspace, document.id, [{
      id: "comment-before-reconcile",
      blockId: blocks[0]!.id,
      text: "stale after reconcile",
      severity: "info",
      runId: "scan-before-reconcile",
      source: "test",
    }]);
    fs.writeFileSync(path.join(root, "paper.docx"), await docxFixture("Recovered edit"));

    await expect(reconcileRegisteredDocxDocuments(workspace)).resolves.toBe(1);
    expect(getDocument(workspace, document.id)).toMatchObject({ revision: 1 });
    expect(listBlocks(workspace, document.id)[0]?.text).toBe("Recovered edit");
    expect(workspace.db.prepare("SELECT status FROM proposals WHERE id = ?")
      .get(pending.id)).toEqual({ status: "superseded" });
    expect(listComments(workspace, document.id)).toEqual([]);
  });

  it("rolls back and retries reconciliation when the DOCX changes before commit", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const pending = proposal(document.id, blocks[0]!);
    saveProposal(workspace, pending);
    replaceDocumentComments(workspace, document.id, [{
      id: "comment-before-reconcile-commit",
      blockId: blocks[0]!.id,
      text: "must survive a rolled-back reconcile",
      severity: "info",
      runId: "scan-before-reconcile-commit",
      source: "test",
    }]);
    const checklist: ReviewChecklistRunDraft = {
      run: {
        schemaVersion: 1,
        id: "checklist-before-reconcile-commit",
        documentId: document.id,
        checker: "cite_check",
        disclaimer: "Heuristic citation check.",
        status: "active",
        createdAt: "2026-08-01T00:00:01.000Z",
      },
      items: [{
        schemaVersion: 1,
        id: "checklist-item-before-reconcile-commit",
        runId: "checklist-before-reconcile-commit",
        documentId: document.id,
        blockId: blocks[0]!.id,
        issueType: "citation.author_year",
        label: "Citation",
        excerpt: blocks[0]!.text,
        detail: "Heuristic detail.",
        severity: "warn",
        status: "open",
        heuristicOnly: true,
        verification: "not_verified",
        createdAt: "2026-08-01T00:00:01.000Z",
      }],
    };
    saveReviewChecklistRun(workspace, checklist);

    const documentPath = path.join(root, "paper.docx");
    const intermediate = await docxFixture("Intermediate reconcile snapshot");
    const latest = await docxFixture("Changed before reconcile commit");
    fs.writeFileSync(documentPath, intermediate);
    const originalRead = fs.readFileSync.bind(fs);
    let documentReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === documentPath && ++documentReads === 4) {
        fs.writeFileSync(documentPath, latest);
      }
      return originalRead(file, options as never);
    }) as typeof fs.readFileSync);

    await expect(reconcileRegisteredDocxDocuments(workspace)).resolves.toBe(1);

    expect(documentReads).toBeGreaterThan(5);
    expect(docxContentHash(originalRead(documentPath))).toBe(docxContentHash(latest));
    expect(getDocument(workspace, document.id)).toMatchObject({
      id: document.id,
      revision: document.revision + 1,
      contentHash: docxContentHash(latest),
    });
    expect(listBlocks(workspace, document.id)[0]?.text).toBe("Changed before reconcile commit");
    expect(workspace.db.prepare("SELECT status FROM proposals WHERE id = ?").get(pending.id))
      .toEqual({ status: "superseded" });
    expect(listComments(workspace, document.id)).toEqual([]);
    expect(listActiveReviewChecklists(workspace, document.id)).toEqual([]);
    expect(workspace.db.isTransaction).toBe(false);
  });

  it("rolls back reconciliation when the DOCX disappears before commit", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const pending = proposal(document.id, blocks[0]!);
    saveProposal(workspace, pending);
    replaceDocumentComments(workspace, document.id, [{
      id: "comment-before-missing-reconcile",
      blockId: blocks[0]!.id,
      text: "must survive a missing-file rollback",
      severity: "info",
      runId: "scan-before-missing-reconcile",
      source: "test",
    }]);
    const documentPath = path.join(root, "paper.docx");
    fs.writeFileSync(documentPath, await docxFixture("Changed before disappearing"));
    const originalRead = fs.readFileSync.bind(fs);
    let documentReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === documentPath && ++documentReads === 4) {
        fs.rmSync(documentPath);
      }
      return originalRead(file, options as never);
    }) as typeof fs.readFileSync);

    await expect(reconcileRegisteredDocxDocuments(workspace)).resolves.toBe(0);

    expect(getDocument(workspace, document.id)).toEqual(document);
    expect(listBlocks(workspace, document.id)).toEqual(blocks);
    expect(workspace.db.prepare("SELECT status FROM proposals WHERE id = ?").get(pending.id))
      .toEqual({ status: "proposed" });
    expect(listComments(workspace, document.id)).toMatchObject([{
      id: "comment-before-missing-reconcile",
    }]);
    expect(workspace.db.isTransaction).toBe(false);
  });

  it("finalizes a human save journal after a crash between file and index commits", async () => {
    const { root, workspace, document } = await testWorkspace();
    const edited = await docxFixture("Recovered human save");
    const blocks = await extractDocxBlocks(edited);
    const afterHash = docxContentHash(edited);
    workspace.db.prepare(
      `INSERT INTO native_save_journals (
        document_id, relative_path, before_hash, after_hash, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      document.id,
      document.relativePath,
      document.contentHash,
      afterHash,
      JSON.stringify({
        schemaVersion: 1,
        documentId: document.id,
        relativePath: document.relativePath,
        beforeRevision: document.revision,
        afterRevision: document.revision + 1,
        beforeHash: document.contentHash,
        afterHash,
        updatedAt: "2026-01-01T00:00:00.000Z",
        blocks,
      }),
      "2026-01-01T00:00:00.000Z",
    );
    fs.writeFileSync(path.join(root, "paper.docx"), edited);

    await recoverNativeSaveJournals(workspace);

    expect(getDocument(workspace, document.id)).toMatchObject({
      revision: document.revision + 1,
      contentHash: afterHash,
    });
    expect(listBlocks(workspace, document.id)[0]?.text).toBe("Recovered human save");
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM native_save_journals").get())
      .toEqual({ count: 0 });
  });

  it("rejects native save journal recovery after the registered DOCX is retargeted", async () => {
    const { root, workspace, document } = await testWorkspace();
    const edited = await docxFixture("Retargeted recovery content");
    const blocks = await extractDocxBlocks(edited);
    const afterHash = docxContentHash(edited);
    const now = "2026-01-01T00:00:00.000Z";
    workspace.db.prepare(
      `INSERT INTO native_save_journals (
        document_id, relative_path, before_hash, after_hash, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      document.id,
      document.relativePath,
      document.contentHash,
      afterHash,
      JSON.stringify({
        schemaVersion: 1,
        documentId: document.id,
        relativePath: document.relativePath,
        beforeRevision: document.revision,
        afterRevision: document.revision + 1,
        beforeHash: document.contentHash,
        afterHash,
        updatedAt: now,
        blocks,
      }),
      now,
    );
    const registeredPath = path.join(root, "paper.docx");
    const originalTarget = path.join(root, "paper-original.docx");
    const replacementTarget = path.join(root, "paper-replacement.docx");
    fs.renameSync(registeredPath, originalTarget);
    fs.writeFileSync(replacementTarget, edited);
    fs.symlinkSync(replacementTarget, registeredPath, "file");

    await expect(recoverNativeSaveJournals(workspace))
      .rejects.toThrow("registered document path target changed");

    expect(getDocument(workspace, document.id)).toEqual(document);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM native_save_journals").get())
      .toEqual({ count: 1 });
    expect(fs.readFileSync(replacementTarget).equals(edited)).toBe(true);
  });

  it("refuses an empty export before replacing a non-empty DOCX", async () => {
    const { root, workspace, document } = await testWorkspace();
    const before = fs.readFileSync(path.join(root, "paper.docx"));
    const empty = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [] }],
    })));

    await expect(saveNativeDocx(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      empty,
    )).rejects.toThrow(/refused to replace a non-empty DOCX/);

    expect(fs.readFileSync(path.join(root, "paper.docx")).equals(before)).toBe(true);
    expect(fs.readdirSync(path.join(root, ".margin", "backups"))).toEqual([]);
    expect(getDocument(workspace, document.id)).toEqual(document);
  });

  it("applies a paragraph proposal without flattening or deleting its table", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const paragraphProposal = proposal(document.id, blocks[0]!);
    saveProposal(workspace, paragraphProposal);
    saveDecision(workspace, paragraphProposal.id, "Y");

    const result = await applyApproved(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
    );

    expect(result.ok).toBe(true);
    const saved = fs.readFileSync(path.join(root, "paper.docx"));
    const savedBlocks = await extractDocxBlocks(saved);
    const xml = await readDocxXml(saved);
    expect(savedBlocks[0]?.text).toBe("Before revised");
    expect(savedBlocks[1]).toMatchObject({ kind: "table", text: "姓名\t分数\n张三\t90" });
    expect((xml.match(/<w:tbl[ >]/g) ?? [])).toHaveLength(1);
    expect(getDocument(workspace, document.id).revision).toBe(document.revision + 1);
  });

  it("applies a selection proposal without moving the suffix run formatting", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-native-docx-"));
    dirs.push(root);
    const source = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [new Paragraph({ children: [
        new TextRun("Before selected "),
        new TextRun({ text: "bold suffix", bold: true }),
      ] })] }],
    })));
    fs.writeFileSync(path.join(root, "paper.docx"), source);
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);
    const document = await openDocxDocument(workspace, "paper.docx");
    const block = listBlocks(workspace, document.id)[0]!;
    const selectionProposal: Proposal = {
      schemaVersion: 1,
      id: "proposal-selection-format",
      documentId: document.id,
      blockId: block.id,
      baseRevision: document.revision,
      baseHash: block.contentHash,
      before: block.text,
      after: "Before translated selection bold suffix",
      rationale: "Translate only the selected text.",
      risk: "language",
      evidence: [],
      operation: {
        kind: "translate",
        scope: "selection",
        targetLanguage: "en",
        selection: {
          start: 7,
          end: 15,
          before: "selected",
          after: "translated selection",
        },
      },
      status: "proposed",
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    };
    saveProposal(workspace, selectionProposal);
    saveDecision(workspace, selectionProposal.id, "Y");

    const result = await applyApproved(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      [selectionProposal.id],
    );

    expect(result.ok).toBe(true);
    const saved = fs.readFileSync(path.join(root, "paper.docx"));
    const xml = await readDocxXml(saved);
    expect((await extractDocxBlocks(saved))[0]?.text).toBe("Before translated selection bold suffix");
    expect(xml).toContain("<w:t xml:space=\"preserve\">Before translated selection </w:t>");
    expect(xml).toMatch(/<w:rPr><w:b\s*\/><w:bCs\s*\/><\/w:rPr><w:t xml:space="preserve">bold suffix<\/w:t>/);
  });

  it("accepts one table-cell proposal through the existing Y/E review transaction", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const table = blocks.find((block) => block.kind === "table")!;
    const cellProposal: Proposal = {
      schemaVersion: 1,
      id: "proposal-table-b2",
      documentId: document.id,
      blockId: table.id,
      baseRevision: document.revision,
      baseHash: table.contentHash,
      before: "90",
      after: "95",
      rationale: "Update one cell only.",
      risk: "fact",
      evidence: [],
      tableCell: { address: "B2", row: 2, column: 2, before: "90", after: "95" },
      status: "proposed",
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    };
    saveProposal(workspace, cellProposal);
    saveDecision(workspace, cellProposal.id, "E", "96");

    const result = await applyApproved(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
      [cellProposal.id],
    );

    expect(result.ok).toBe(true);
    expect((await extractDocxBlocks(fs.readFileSync(path.join(root, "paper.docx"))))
      .find((block) => block.kind === "table")?.text).toBe("姓名\t分数\n张三\t96");
    expect(listDocumentTimeline(workspace, document.id)[0]).toMatchObject({
      proposalId: cellProposal.id,
      decisionKind: "E",
      ok: true,
    });
  });

  it("recovers an accepted table-cell proposal after a Host restart boundary", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const table = blocks.find((block) => block.kind === "table")!;
    const cellProposal: Proposal = {
      schemaVersion: 1,
      id: "proposal-table-recovery",
      documentId: document.id,
      blockId: table.id,
      baseRevision: document.revision,
      baseHash: table.contentHash,
      before: "90",
      after: "97",
      rationale: "Recover one cell only.",
      risk: "fact",
      evidence: [],
      tableCell: { address: "B2", row: 2, column: 2, before: "90", after: "97" },
      status: "proposed",
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    };
    saveProposal(workspace, cellProposal);
    saveDecision(workspace, cellProposal.id, "Y");

    await recoverDecidedProposals(workspace);

    expect((await extractDocxBlocks(fs.readFileSync(path.join(root, "paper.docx"))))
      .find((block) => block.kind === "table")?.text).toBe("姓名\t分数\n张三\t97");
    expect(listDocumentTimeline(workspace, document.id)[0]).toMatchObject({
      proposalId: cellProposal.id,
      decisionKind: "Y",
      ok: true,
    });
  });

  it("rejects Agent table replacement and leaves the DOCX byte-for-byte unchanged", async () => {
    const { root, workspace, document, blocks } = await testWorkspace();
    const table = blocks.find((block) => block.kind === "table")!;
    const tableProposal = proposal(document.id, table);
    saveProposal(workspace, tableProposal);
    saveDecision(workspace, tableProposal.id, "Y");
    const before = fs.readFileSync(path.join(root, "paper.docx"));

    const result = await applyApproved(
      workspace,
      document.id,
      document.revision,
      document.contentHash,
    );

    expect(result).toEqual({ ok: false, reason: "nothing_to_apply" });
    expect(fs.readFileSync(path.join(root, "paper.docx")).equals(before)).toBe(true);
    expect(listDocumentTimeline(workspace, document.id)[0]).toMatchObject({
      proposalId: tableProposal.id,
      ok: false,
      reason: "unsupported",
    });
  });
});
