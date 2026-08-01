import { describe, expect, it } from "vitest";
import type { EvidenceCacheEntry } from "@margin/domain";
import { createSessionTools, type SessionDocBag, type WorkspaceBridge } from "./session-tools.js";
import type { Draft } from "./pi-tools.js";

const VERSION_A = "a".repeat(64);
const VERSION_B = "b".repeat(64);
const EXTRACTED_HASH = "0123456789abcdef";
const SOURCE_REF = `sources/paper.pdf#sha256=${EXTRACTED_HASH}&chars=0-8`;

const cachedEntry = (): EvidenceCacheEntry => ({
  sourceRef: SOURCE_REF,
  relativePath: "sources/paper.pdf",
  start: 0,
  end: 8,
  extractedHash: EXTRACTED_HASH,
  versionHash: VERSION_A,
  preview: "evidence",
  readAt: "2026-08-01T00:00:00.000Z",
});

const bag = (): SessionDocBag => ({
  documentId: "doc-1",
  relativePath: "paper.docx",
  revision: 1,
  blocks: [
    { id: "b1", kind: "paragraph", text: "first", order: 0, contentHash: "h1" },
    { id: "b2", kind: "paragraph", text: "second", order: 1, contentHash: "h2" },
  ],
});

function bridge(overrides: Partial<WorkspaceBridge> = {}): WorkspaceBridge {
  return {
    listSourceFiles: () => ["sources/paper.pdf"],
    readText: () => ({
      relativePath: "sources/paper.pdf",
      text: "evidence",
      bytes: 8,
      versionHash: VERSION_A,
    }),
    readVersion: () => ({
      relativePath: "sources/paper.pdf",
      bytes: 8,
      versionHash: VERSION_A,
    }),
    writeText: async () => ({ relativePath: "notes.txt", bytes: 0, created: true }),
    openDocument: () => { throw new Error("unused"); },
    ...overrides,
  };
}

function byName(tools: ReturnType<typeof createSessionTools>) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

describe("session evidence validation", () => {
  it("reuses a prior-turn ref only after a source-byte version probe", async () => {
    let extracts = 0;
    let probes = 0;
    const drafts: Draft[] = [];
    const sibling = {
      ...cachedEntry(),
      sourceRef: `sources/paper.pdf#sha256=${EXTRACTED_HASH}&chars=8-16`,
      start: 8,
      end: 16,
      preview: "more evidence",
    };
    const tools = byName(createSessionTools(
      bridge({
        readText: () => {
          extracts += 1;
          throw new Error("rich extraction must not repeat");
        },
        readVersion: () => {
          probes += 1;
          return { relativePath: "sources/paper.pdf", bytes: 8, versionHash: VERSION_A };
        },
      }),
      bag(),
      drafts,
      [],
      {},
      { sourcePaths: ["sources/paper.pdf"], evidenceCache: [cachedEntry(), sibling] },
    ));

    await tools.propose_block_edit!.execute("cached", {
      blockId: "b1",
      after: "revised first",
      rationale: "Grounded in the attached source.",
      evidence: [SOURCE_REF, sibling.sourceRef],
    });

    expect(drafts[0]?.evidence).toEqual([SOURCE_REF, sibling.sourceRef]);
    expect(extracts).toBe(0);
    expect(probes).toBe(1);
  });

  it("records a current read, then reuses it next turn without re-extracting", async () => {
    let extracts = 0;
    let probes = 0;
    let persisted: EvidenceCacheEntry[] = [];
    const firstDrafts: Draft[] = [];
    const first = byName(createSessionTools(
      bridge({
        readText: () => {
          extracts += 1;
          return {
            relativePath: "sources/paper.pdf",
            text: "evidence",
            bytes: 8,
            versionHash: VERSION_A,
          };
        },
        readVersion: () => {
          probes += 1;
          return { relativePath: "sources/paper.pdf", bytes: 8, versionHash: VERSION_A };
        },
      }),
      bag(),
      firstDrafts,
      [],
      {},
      {
        sourcePaths: ["sources/paper.pdf"],
        onEvidenceCacheChange: (entries) => { persisted = entries; },
      },
    ));
    const read = await first.read_workspace_file!.execute("read", {
      relativePath: "sources/paper.pdf",
      offset: 0,
      limit: 8,
    });
    const readJson = JSON.parse((read.content[0] as { text: string }).text);
    await first.propose_block_edit!.execute("current", {
      blockId: "b1",
      after: "revised first",
      rationale: "Uses the current read.",
      evidence: [readJson.sourceRef],
    });
    expect(extracts).toBe(1);
    expect(probes).toBe(0);
    expect(persisted).toHaveLength(1);

    const secondDrafts: Draft[] = [];
    const second = byName(createSessionTools(
      bridge({
        readText: () => {
          extracts += 1;
          throw new Error("must not re-extract");
        },
        readVersion: () => {
          probes += 1;
          return { relativePath: "sources/paper.pdf", bytes: 8, versionHash: VERSION_A };
        },
      }),
      bag(),
      secondDrafts,
      [],
      {},
      { sourcePaths: ["sources/paper.pdf"], evidenceCache: persisted },
    ));
    await second.propose_block_edit!.execute("cached", {
      blockId: "b2",
      after: "revised second",
      rationale: "Uses the prior read.",
      evidence: [readJson.sourceRef],
    });
    expect(extracts).toBe(1);
    expect(probes).toBe(1);
    expect(secondDrafts[0]?.evidence).toEqual([readJson.sourceRef]);
  });

  it.each([
    ["changed", () => ({ relativePath: "sources/paper.pdf", bytes: 8, versionHash: VERSION_B })],
    ["deleted", () => { throw new Error("file not found"); }],
  ])("evicts a %s prior-turn source and rejects the proposal", async (_case, readVersion) => {
    const sibling = {
      ...cachedEntry(),
      sourceRef: `sources/paper.pdf#sha256=${EXTRACTED_HASH}&chars=8-16`,
      start: 8,
      end: 16,
      preview: "other chunk",
    };
    let persisted = [cachedEntry(), sibling];
    const drafts: Draft[] = [];
    const tools = byName(createSessionTools(
      bridge({ readVersion }),
      bag(),
      drafts,
      [],
      {},
      {
        sourcePaths: ["sources/paper.pdf"],
        evidenceCache: persisted,
        onEvidenceCacheChange: (entries) => { persisted = entries; },
      },
    ));

    await expect(tools.propose_block_edit!.execute("stale", {
      blockId: "b1",
      after: "revised",
      rationale: "Should fail.",
      evidence: [SOURCE_REF],
    })).rejects.toThrow(/stale.*read_workspace_file again/i);
    expect(persisted).toEqual([]);
    expect(drafts).toEqual([]);
  });

  it.each([
    "sources/paper.pdf",
    `sources/paper.pdf#sha256=${"f".repeat(16)}&chars=0-8`,
    `sources/paper.pdf#sha256=${EXTRACTED_HASH}&chars=1-8`,
  ])("rejects an attached but unrecorded ref: %s", async (forgedRef) => {
    const drafts: Draft[] = [];
    const tools = byName(createSessionTools(
      bridge(),
      bag(),
      drafts,
      [],
      {},
      { sourcePaths: ["sources/paper.pdf"], evidenceCache: [cachedEntry()] },
    ));
    await expect(tools.propose_block_edit!.execute("forged", {
      blockId: "b1",
      after: "revised",
      rationale: "Should fail.",
      evidence: [forgedRef],
    })).rejects.toThrow(/returned by read_workspace_file.*or retained in this session/i);
    expect(drafts).toEqual([]);
  });
});
