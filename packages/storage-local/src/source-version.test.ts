import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openWorkspace,
  readWorkspaceSource,
  readWorkspaceSourceVersion,
  type Workspace,
} from "./index.js";

const roots: string[] = [];
const workspaces: Workspace[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    try { workspace.db.close(); } catch { /* ignore */ }
    try { await workspace.releaseLock(); } catch { /* ignore */ }
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-source-version-"));
  roots.push(root);
  const workspace = await openWorkspace(root);
  workspaces.push(workspace);
  return { root, workspace };
}

describe("source byte versions", () => {
  it("returns the original-byte SHA-256 and detects content changes and deletion", async () => {
    const { root, workspace } = await setup();
    const file = path.join(root, "notes.txt");
    const original = Buffer.from("first\r\nversion", "utf8");
    fs.writeFileSync(file, original);

    const read = await readWorkspaceSource(workspace, "notes.txt");
    const version = readWorkspaceSourceVersion(workspace, "notes.txt");
    const expected = createHash("sha256").update(original).digest("hex");
    expect(read.versionHash).toBe(expected);
    expect(version).toMatchObject({ relativePath: "notes.txt", versionHash: expected });

    fs.writeFileSync(file, "second version", "utf8");
    expect(readWorkspaceSourceVersion(workspace, "notes.txt").versionHash).not.toBe(expected);

    fs.rmSync(file);
    expect(() => readWorkspaceSourceVersion(workspace, "notes.txt")).toThrow(/file not found/);
  });

  it("hashes a rich source without invoking PDF extraction", async () => {
    const { root, workspace } = await setup();
    fs.writeFileSync(path.join(root, "broken.pdf"), Buffer.from("not a real pdf"));

    expect(readWorkspaceSourceVersion(workspace, "broken.pdf").versionHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(readWorkspaceSource(workspace, "broken.pdf")).rejects.toThrow();
  });

  it("applies the same external-read switch and sensitive-path deny-list", async () => {
    const { workspace } = await setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "margin-source-version-outside-"));
    roots.push(outside);
    const normal = path.join(outside, "notes.txt");
    const secret = path.join(outside, ".env");
    fs.writeFileSync(normal, "ok", "utf8");
    fs.writeFileSync(secret, "secret", "utf8");

    expect(() => readWorkspaceSourceVersion(workspace, normal)).toThrow(/unlimited read is off/);
    expect(readWorkspaceSourceVersion(workspace, normal, { unlimitedRead: true }).versionHash)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(() => readWorkspaceSourceVersion(workspace, secret, { unlimitedRead: true }))
      .toThrow(/sensitive/);
  });
});
