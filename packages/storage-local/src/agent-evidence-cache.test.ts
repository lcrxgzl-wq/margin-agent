import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveAgentSession,
  loadAgentSession,
  loadAgentSessionEnvelope,
  openWorkspace,
  saveAgentSession,
  type Workspace,
} from "./index.js";

const workspaces: Workspace[] = [];
const roots: string[] = [];

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-agent-evidence-"));
  roots.push(root);
  const workspace = await openWorkspace(root);
  workspaces.push(workspace);
  return workspace;
}

function entry(index: number, preview = `preview-${index}`) {
  const extractedHash = index.toString(16).padStart(16, "0");
  const start = index * 10;
  const end = start + 10;
  return {
    sourceRef: `notes.txt#sha256=${extractedHash}&chars=${start}-${end}`,
    relativePath: "notes.txt",
    start,
    end,
    extractedHash,
    versionHash: "a".repeat(64),
    preview,
    readAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
  };
}

describe("agent evidence cache persistence", () => {
  it("deduplicates by sourceRef, keeps the newest 80, and archives the envelope", async () => {
    const workspace = await setup();
    const entries = Array.from({ length: 85 }, (_, index) => entry(index));
    entries.push(entry(84, "latest duplicate"));
    saveAgentSession(workspace, {
      sessionId: "evidence-session",
      messages: [],
      sourcePaths: ["notes.txt"],
      evidenceCache: entries,
    });

    const loaded = loadAgentSession(workspace)!;
    expect(loaded.evidenceCache).toHaveLength(80);
    expect(loaded.evidenceCache[0]?.sourceRef).toBe(entry(5).sourceRef);
    expect(loaded.evidenceCache.at(-1)?.preview).toBe("latest duplicate");

    expect(archiveAgentSession(workspace, "evidence-session")).toBe(true);
    expect(loadAgentSessionEnvelope(workspace, "evidence-session")?.evidenceCache)
      .toEqual(loaded.evidenceCache);
  });

  it("drops malformed, detached, and legacy-unversioned entries", async () => {
    const workspace = await setup();
    saveAgentSession(workspace, {
      sessionId: "filtered",
      messages: [],
      sourcePaths: ["notes.txt"],
      evidenceCache: [
        entry(1),
        { ...entry(2), relativePath: "other.txt" },
        { ...entry(3), end: 999 },
        { ...entry(4), versionHash: "mtime:123" },
      ] as never,
    });
    expect(loadAgentSession(workspace)?.evidenceCache).toEqual([entry(1)]);

    workspace.db.prepare(
      `UPDATE agent_sessions SET messages_json = ? WHERE id = 'current'`,
    ).run(JSON.stringify({ messages: [], sourcePaths: ["notes.txt"] }));
    expect(loadAgentSession(workspace)?.evidenceCache).toEqual([]);
  });

  it("persists only the newest byte version for one source path", async () => {
    const workspace = await setup();
    const current = { ...entry(3), versionHash: "b".repeat(64) };
    saveAgentSession(workspace, {
      sessionId: "versioned",
      messages: [],
      sourcePaths: ["notes.txt"],
      evidenceCache: [entry(1), entry(2), current],
    });

    expect(loadAgentSession(workspace)?.evidenceCache).toEqual([current]);
  });
});
