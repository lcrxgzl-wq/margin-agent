import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openWorkspace,
  readWorkspaceSource,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-ws-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "margin-outside-"));
  roots.push(root, outside);
  const workspace = await openWorkspace(root);
  workspaces.push(workspace);
  return { root, outside, workspace };
}

const UNLIMITED = { unlimitedRead: true };

function linkDirectory(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

describe("unlimited external reads", () => {
  it("rejects absolute paths while the switch is off", async () => {
    const { outside, workspace } = await setup();
    const target = path.join(outside, "notes.txt");
    fs.writeFileSync(target, "hello", "utf8");

    await expect(readWorkspaceSource(workspace, target)).rejects.toThrow(
      /outside workspace; unlimited read is off/,
    );
    await expect(
      readWorkspaceSource(workspace, target, { unlimitedRead: false }),
    ).rejects.toThrow(/outside workspace; unlimited read is off/);
  });

  it("reads an external text file and backfills the absolute path", async () => {
    const { outside, workspace } = await setup();
    const target = path.join(outside, "notes.txt");
    fs.writeFileSync(target, "external evidence", "utf8");

    const result = await readWorkspaceSource(workspace, target, UNLIMITED);
    expect(result.text).toContain("external evidence");
    expect(result.relativePath).toBe(target);

    if (process.platform === "win32") {
      const forward = target.replace(/\\/g, "/");
      const viaForward = await readWorkspaceSource(workspace, forward, UNLIMITED);
      expect(viaForward.text).toContain("external evidence");
      expect(viaForward.relativePath).toBe(forward);
    }
  });

  it("rejects deny-listed basenames", async () => {
    const { outside, workspace } = await setup();
    const names = [
      ".env",
      ".env.local",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa",
      "cert.pem",
      "server.key",
      "store.p12",
      "cert.pfx",
      ".netrc",
      ".npmrc",
      ".pgpass",
    ];
    for (const name of names) {
      const dir = path.join(outside, `case-${name.replace(/[^a-z0-9]/gi, "_")}`);
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, name);
      fs.writeFileSync(target, "secret", "utf8");
      await expect(readWorkspaceSource(workspace, target, UNLIMITED)).rejects.toThrow(
        /sensitive/,
      );
    }
  });

  it("matches the deny-list case-insensitively and across separators", async () => {
    const { outside, workspace } = await setup();
    const dir = path.join(outside, "win-case");
    fs.mkdirSync(dir, { recursive: true });
    const envFile = path.join(dir, ".ENV");
    const rsaFile = path.join(dir, "Id_Rsa");
    fs.writeFileSync(envFile, "secret", "utf8");
    fs.writeFileSync(rsaFile, "secret", "utf8");

    await expect(readWorkspaceSource(workspace, envFile, UNLIMITED)).rejects.toThrow(
      /sensitive/,
    );
    await expect(readWorkspaceSource(workspace, rsaFile, UNLIMITED)).rejects.toThrow(
      /sensitive/,
    );
    if (process.platform === "win32") {
      await expect(
        readWorkspaceSource(workspace, envFile.replace(/\//g, "\\"), UNLIMITED),
      ).rejects.toThrow(/sensitive/);
    }
  });

  it("rejects deny-listed directory segments", async () => {
    const { outside, workspace } = await setup();
    const paths = [
      [".ssh", "config.txt"],
      [".aws", "credentials.txt"],
      [".gnupg", "keyring.txt"],
      ["project", ".git", "config.txt"],
      ["data", ".margin", "leak.txt"],
    ];
    for (const segments of paths) {
      const dir = path.join(outside, ...segments.slice(0, -1));
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, segments[segments.length - 1]!);
      fs.writeFileSync(target, "secret", "utf8");
      await expect(readWorkspaceSource(workspace, target, UNLIMITED)).rejects.toThrow(
        /sensitive/,
      );
    }
  });

  it("rejects a symlink resolving into a deny-listed path", async () => {
    const { outside, workspace } = await setup();
    const realDir = path.join(outside, ".ssh");
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, "settings.txt"), "secret", "utf8");
    const link = path.join(outside, "configs");
    linkDirectory(realDir, link);

    await expect(
      readWorkspaceSource(workspace, path.join(link, "settings.txt"), UNLIMITED),
    ).rejects.toThrow(/sensitive/);
  });

  it("allows a symlink resolving to a normal external file", async () => {
    const { outside, workspace } = await setup();
    const realDir = path.join(outside, "real-docs");
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, "notes.txt"), "via link", "utf8");
    const link = path.join(outside, "docs-link");
    linkDirectory(realDir, link);

    const target = path.join(link, "notes.txt");
    const result = await readWorkspaceSource(workspace, target, UNLIMITED);
    expect(result.text).toContain("via link");
    expect(result.relativePath).toBe(target);
  });

  it("normalizes absolute paths that resolve inside the workspace", async () => {
    const { root, workspace } = await setup();
    // basename matches the external deny-list but must not matter inside the workspace
    fs.writeFileSync(path.join(root, "id_rsa.txt"), "in workspace", "utf8");

    const result = await readWorkspaceSource(
      workspace,
      path.join(root, "id_rsa.txt"),
      UNLIMITED,
    );
    expect(result.text).toContain("in workspace");
    expect(result.relativePath).toBe("id_rsa.txt");
  });

  it("rejects oversized, directory, missing, and unsupported external paths", async () => {
    const { outside, workspace } = await setup();

    await expect(
      readWorkspaceSource(workspace, path.join(outside, "missing.txt"), UNLIMITED),
    ).rejects.toThrow(/file not found/);

    await expect(readWorkspaceSource(workspace, outside, UNLIMITED)).rejects.toThrow(
      /not a file/,
    );

    const large = path.join(outside, "large.txt");
    fs.writeFileSync(large, "x", "utf8");
    fs.truncateSync(large, 400_001);
    await expect(readWorkspaceSource(workspace, large, UNLIMITED)).rejects.toThrow(
      /file too large to read/,
    );

    const binary = path.join(outside, "blob.bin");
    fs.writeFileSync(binary, "x", "utf8");
    await expect(readWorkspaceSource(workspace, binary, UNLIMITED)).rejects.toThrow(
      /only md\/txt\/json\/csv\/pdf\/docx can be read/,
    );
  });
});
