import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBlocks, importExternalDocxDocument, openWorkspace } from "./index.js";
import { writeBlocksDocx } from "./docx.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may briefly retain SQLite handles. */
    }
  }
});

describe("importExternalDocxDocument", () => {
  it("reuses a byte-identical import and creates a new copy only when the source changes", async () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "margin-docx-source-"));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "margin-docx-workspace-"));
    dirs.push(externalDir, workspaceDir);
    const source = path.join(externalDir, "sport value.docx");
    await writeBlocksDocx(source, [
      {
        id: "p1",
        kind: "paragraph",
        text: "Sport carries social and political value.",
        order: 0,
        contentHash: "hash",
      },
    ]);

    const workspace = await openWorkspace(workspaceDir);
    try {
      const first = await importExternalDocxDocument(workspace, source);
      const second = await importExternalDocxDocument(workspace, source);

      await writeBlocksDocx(source, [
        {
          id: "p2",
          kind: "paragraph",
          text: "The external source changed after the first import.",
          order: 0,
          contentHash: "hash-2",
        },
      ]);
      const changed = await importExternalDocxDocument(workspace, source);

      expect(first.document.relativePath).toBe("imports/sport value.docx");
      expect(second.document.id).toBe(first.document.id);
      expect(second.document.relativePath).toBe(first.document.relativePath);
      expect(changed.document.relativePath).toBe("imports/sport value-2.docx");
      expect(listBlocks(workspace, first.document.id)[0]?.text).toContain("social and political");
      expect(listBlocks(workspace, changed.document.id)[0]?.text).toContain("external source changed");
      expect(fs.existsSync(path.join(workspaceDir, "imports", "sport value.docx"))).toBe(true);
      expect(fs.existsSync(path.join(workspaceDir, first.document.relativePath))).toBe(true);
    } finally {
      workspace.db.close();
      await workspace.releaseLock();
    }
  });

  it("rejects non-absolute paths", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "margin-docx-workspace-"));
    dirs.push(workspaceDir);
    const workspace = await openWorkspace(workspaceDir);
    try {
      await expect(importExternalDocxDocument(workspace, "draft.docx")).rejects.toThrow(
        /must be absolute/,
      );
    } finally {
      workspace.db.close();
      await workspace.releaseLock();
    }
  });
});
