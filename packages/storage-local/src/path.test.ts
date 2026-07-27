import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openWorkspace,
  openDocument,
  readWorkspaceText,
  resolveWorkspacePath,
  saveAgentTranscript,
  listAgentTranscripts,
  listWorkspaceSourceFiles,
  assertNotRegisteredDocumentWrite,
  exportDocumentDocx,
  openDocxDocument,
  writeWorkspaceText,
} from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows may still hold sqlite lock briefly
    }
  }
});

function tmpWorkspace(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "margin-ws-"));
  dirs.push(d);
  fs.writeFileSync(path.join(d, "a.md"), "# hi\n", "utf8");
  return d;
}

function linkDirectory(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

describe("resolveWorkspacePath", () => {
  it("allows relative file inside workspace", () => {
    const root = tmpWorkspace();
    const resolved = resolveWorkspacePath(root, "a.md");
    expect(resolved).toBe(fs.realpathSync(path.join(root, "a.md")));
  });

  it("rejects .. traversal", () => {
    const root = tmpWorkspace();
    expect(() => resolveWorkspacePath(root, "../a.md")).toThrow(/escapes/);
    expect(() => resolveWorkspacePath(root, "x/../../a.md")).toThrow(/escapes/);
  });

  it("rejects absolute paths", () => {
    const root = tmpWorkspace();
    expect(() => resolveWorkspacePath(root, path.resolve(root, "a.md"))).toThrow(/escapes/);
  });
});

describe("workspace metadata boundary", () => {
  it("rejects a .margin directory link before writing metadata", async () => {
    const root = tmpWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "margin-outside-"));
    dirs.push(outside);
    linkDirectory(outside, path.join(root, ".margin"));

    await expect(openWorkspace(root)).rejects.toThrow(/metadata.*links|escapes/);
    expect(fs.existsSync(path.join(outside, "margin.db"))).toBe(false);
    expect(fs.existsSync(path.join(outside, "workspace.lock"))).toBe(false);
    expect(fs.existsSync(path.join(outside, "backups"))).toBe(false);
  });
});

describe("workspace text io", () => {
  it("rejects oversized Markdown before reading it into memory", async () => {
    const root = tmpWorkspace();
    const large = path.join(root, "large.md");
    fs.writeFileSync(large, "x", "utf8");
    fs.truncateSync(large, 50 * 1024 * 1024 + 1);
    const ws = await openWorkspace(root);
    try {
      expect(() => openDocument(ws, "large.md")).toThrow(/too large.*50 MiB/);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("lists supported workspace sources only", async () => {
    const root = tmpWorkspace();
    fs.writeFileSync(path.join(root, "interview.txt"), "访谈", "utf8");
    fs.writeFileSync(path.join(root, "cases.csv"), "id,name\n1,a\n", "utf8");
    fs.writeFileSync(path.join(root, "settings.json"), "{}", "utf8");
    const ws = await openWorkspace(root);
    try {
      expect(listWorkspaceSourceFiles(ws)).toEqual([
        "a.md",
        "cases.csv",
        "interview.txt",
      ]);
    } finally {
      try {
        ws.db.close();
      } catch {
        /* ignore */
      }
      await ws.releaseLock();
    }
  });

  it("rejects a missing target below an external directory link", async () => {
    const root = tmpWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "margin-outside-"));
    dirs.push(outside);
    linkDirectory(outside, path.join(root, "linked"));
    const ws = await openWorkspace(root);
    try {
      await expect(writeWorkspaceText(ws, "linked/escape.md", "x")).rejects.toThrow(
        /escapes/,
      );
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("writes and reads markdown inside workspace", async () => {
    const root = tmpWorkspace();
    const ws = await openWorkspace(root);
    try {
      const w = await writeWorkspaceText(ws, "notes/x.md", "# note\n");
      expect(w.created).toBe(true);
      const r = readWorkspaceText(ws, "notes/x.md");
      expect(r.text).toContain("# note");
    } finally {
      try {
        ws.db.close();
      } catch {
        /* ignore */
      }
      await ws.releaseLock();
    }
  });

  it("rejects hidden metadata and aliases to it", async () => {
    const root = tmpWorkspace();
    const ws = await openWorkspace(root);
    try {
      fs.writeFileSync(path.join(root, ".margin", "secret.md"), "private", "utf8");
      expect(() => readWorkspaceText(ws, ".margin/secret.md")).toThrow(/hidden|internal/);
      expect(() => openDocument(ws, ".margin/secret.md")).toThrow(/hidden|internal/);

      linkDirectory(path.join(root, ".margin"), path.join(root, "alias"));
      expect(() => readWorkspaceText(ws, "alias/secret.md")).toThrow(/hidden|internal/);
      expect(listWorkspaceSourceFiles(ws)).not.toContain("alias/secret.md");
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("rejects hard-linked files from the readable surface", async () => {
    const root = tmpWorkspace();
    const ws = await openWorkspace(root);
    try {
      const secret = path.join(root, ".margin", "llm-settings.json");
      fs.writeFileSync(secret, '{"apiKey":"secret"}', "utf8");
      fs.linkSync(secret, path.join(root, "leaked.txt"));
      expect(() => readWorkspaceText(ws, "leaked.txt")).toThrow(/hard-linked/);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("lists registered document paths and blocks canonical overwrite via assert", async () => {
    const root = tmpWorkspace();
    const ws = await openWorkspace(root);
    try {
      const { listRegisteredDocumentPaths } =
        await import("./index.js");
      openDocument(ws, "a.md");
      expect(listRegisteredDocumentPaths(ws)).toContain("a.md");
      expect(() => assertNotRegisteredDocumentWrite(ws, "a.md")).toThrow(/canonical/);
      expect(() => assertNotRegisteredDocumentWrite(ws, "notes/new.md")).not.toThrow();
    } finally {
      try {
        ws.db.close();
      } catch {
        /* ignore */
      }
      await ws.releaseLock();
    }
  });

  it("recognizes registered documents through aliases", async () => {
    const root = tmpWorkspace();
    const ws = await openWorkspace(root);
    try {
      openDocument(ws, "a.md");
      fs.linkSync(path.join(root, "a.md"), path.join(root, "alias.md"));
      expect(() => assertNotRegisteredDocumentWrite(ws, "alias.md")).toThrow(/canonical/);
      if (process.platform === "win32") {
        expect(() => assertNotRegisteredDocumentWrite(ws, "A.MD")).toThrow(/canonical/);
      }
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("rejects DOCX export through an existing hard link", async () => {
    const root = tmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "margin-export-outside-"));
    dirs.push(outsideDir);
    const outside = path.join(outsideDir, "outside.docx");
    fs.writeFileSync(outside, "outside", "utf8");
    fs.linkSync(outside, path.join(root, "a.export.docx"));
    const ws = await openWorkspace(root);
    try {
      const document = openDocument(ws, "a.md");
      await expect(exportDocumentDocx(ws, document.id)).rejects.toThrow(/hard-linked/);
      expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("does not overwrite a DOCX that has become a registered document", async () => {
    const root = tmpWorkspace();
    const ws = await openWorkspace(root);
    try {
      const source = openDocument(ws, "a.md");
      await exportDocumentDocx(ws, source.id);
      const exported = await openDocxDocument(ws, "a.export.docx");
      const before = fs.readFileSync(path.join(root, "a.export.docx"));

      await expect(exportDocumentDocx(ws, source.id)).rejects.toThrow(/canonical document/);
      expect(fs.readFileSync(path.join(root, "a.export.docx")).equals(before)).toBe(true);
      expect(openDocument(ws, "a.md").id).toBe(source.id);
      expect(exported.relativePath).toBe("a.export.docx");
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("does not rewrite block rows when an opened document is unchanged", async () => {
    const root = tmpWorkspace();
    const ws = await openWorkspace(root);
    try {
      const first = openDocument(ws, "a.md");
      const sentinel = "2000-01-01T00:00:00.000Z";
      ws.db.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").run(sentinel, first.id);
      const second = openDocument(ws, "a.md");
      expect(second.revision).toBe(first.revision);
      expect(second.updatedAt).toBe(sentinel);
    } finally {
      ws.db.close();
      await ws.releaseLock();
    }
  });

  it("rejects write traversal", async () => {
    const root = tmpWorkspace();
    const ws = await openWorkspace(root);
    try {
      await expect(writeWorkspaceText(ws, "../evil.md", "x")).rejects.toThrow(
        /escapes|hidden/,
      );
    } finally {
      try {
        ws.db.close();
      } catch {
        /* ignore */
      }
      await ws.releaseLock();
    }
  });
});

describe("agent transcripts", () => {
  it("persists and lists transcript payloads", async () => {
    const root = tmpWorkspace();
    const ws = await openWorkspace(root);
    try {
      const saved = saveAgentTranscript(ws, {
        turnId: "turn-1",
        role: "assistant",
        payload: { toolCalls: ["list_blocks"] },
      });
      expect(listAgentTranscripts(ws)).toEqual([saved]);

      // Batch fixture setup so Windows CI does not fsync 50 independent transactions.
      ws.db.exec("BEGIN");
      try {
        for (let i = 2; i <= 51; i++) {
          saveAgentTranscript(ws, {
            turnId: `turn-${i}`,
            role: "assistant",
            payload: { toolCalls: [] },
          });
        }
        ws.db.exec("COMMIT");
      } catch (error) {
        ws.db.exec("ROLLBACK");
        throw error;
      }
      expect(listAgentTranscripts(ws, 50)).toHaveLength(50);
    } finally {
      try {
        ws.db.close();
      } catch {
        /* ignore */
      }
      await ws.releaseLock();
    }
  });
});
