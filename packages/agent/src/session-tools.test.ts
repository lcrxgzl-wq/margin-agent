import { describe, expect, it } from "vitest";
import type { EvidenceCacheEntry } from "@margin/domain";
import type { AgentComment } from "./types.js";
import type { Draft } from "./pi-tools.js";
import {
  createSessionTools,
  type SessionDocBag,
  type SessionSideEffects,
} from "./session-tools.js";

describe("open_document", () => {
  it("demotes documentModeState from full to lean on mid-turn document switch", async () => {
    const bag: SessionDocBag = {
      documentId: "doc-a",
      revision: 0,
      relativePath: "a.md",
      blocks: [{ id: "a1", kind: "paragraph", text: "A", order: 0, contentHash: "a" }],
    };
    const modeState: { documentMode?: "full" | "lean" } = { documentMode: "full" };
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["a.md", "b.md"],
        readText: () => ({ relativePath: "", text: "", bytes: 0 }),
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: async (relativePath) => ({
          document: {
            id: "doc-b",
            relativePath,
            revision: 1,
            contentHash: "hash-b",
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
          blocks: [{ id: "b1", kind: "paragraph", text: "B", order: 0, contentHash: "b" }],
        }),
      },
      bag,
      [],
      [],
      {},
      { documentModeState: modeState },
    );
    const open = tools.find((t) => t.name === "open_document")!;
    const result = await open.execute("1", { relativePath: "b.md" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(modeState.documentMode).toBe("lean");
    expect(payload.warning).toMatch(/demoted to lean/);
    expect(payload.documentMode).toBe("lean");
  });

  it("awaits async bridge opens for DOCX paths", async () => {
    const bag: SessionDocBag = { revision: 0, blocks: [] };
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["paper.docx"],
        readText: () => ({ relativePath: "", text: "", bytes: 0 }),
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: async (relativePath) => {
          expect(relativePath).toBe("paper.docx");
          return {
            document: {
              id: "doc-docx",
              relativePath: "paper.docx",
              revision: 0,
              contentHash: "hash",
              updatedAt: "2026-07-30T00:00:00.000Z",
            },
            blocks: [
              {
                id: "b1",
                kind: "paragraph",
                text: "From DOCX",
                order: 0,
                contentHash: "b1",
              },
            ],
          };
        },
      },
      bag,
      [],
      [],
      {},
    );
    const open = tools.find((t) => t.name === "open_document")!;
    const result = await open.execute("1", { relativePath: "paper.docx" });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      ok: true,
      relativePath: "paper.docx",
      documentId: "doc-docx",
      blockCount: 1,
    });
    expect(bag.documentId).toBe("doc-docx");
    expect(bag.relativePath).toBe("paper.docx");
    expect(bag.blocks).toHaveLength(1);
  });

  it("invalidates a prior source read for the same path after opening it", async () => {
    const bag: SessionDocBag = { revision: 0, blocks: [] };
    let text = "old";
    let reads = 0;
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["paper.md"],
        readText: async (relativePath) => {
          reads += 1;
          return {
            relativePath,
            text,
            bytes: text.length,
            versionHash: text === "new" ? "b".repeat(64) : "a".repeat(64),
          };
        },
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: async (relativePath) => {
          text = "new";
          return {
            document: {
              id: "doc-2",
              relativePath,
              revision: 1,
              contentHash: "hash-2",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
            blocks: [{
              id: "b1",
              kind: "paragraph",
              text: "new",
              order: 0,
              contentHash: "hash-b1",
            }],
          };
        },
      },
      bag,
      [],
      [],
      {},
    );
    const read = tools.find((t) => t.name === "read_workspace_file")!;
    const open = tools.find((t) => t.name === "open_document")!;

    const first = await read.execute("read-1", {
      relativePath: "paper.md",
      offset: 0,
      limit: 3,
    });
    expect(JSON.parse((first.content[0] as { text: string }).text).text).toBe("old");

    await open.execute("open-1", { relativePath: "paper.md" });
    const second = await read.execute("read-2", {
      relativePath: "paper.md",
      offset: 0,
      limit: 3,
    });
    expect(JSON.parse((second.content[0] as { text: string }).text).text).toBe("new");
    expect(reads).toBe(2);
  });

  it("keeps source caches when opening the already active revision is a no-op", async () => {
    const bag: SessionDocBag = {
      documentId: "doc-1",
      revision: 2,
      relativePath: "paper.md",
      blocks: [],
    };
    let reads = 0;
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["paper.md"],
        readText: (relativePath) => {
          reads += 1;
          return {
            relativePath,
            text: "stable",
            bytes: 6,
            versionHash: "a".repeat(64),
          };
        },
        readVersion: (relativePath) => ({
          relativePath,
          bytes: 6,
          versionHash: "a".repeat(64),
        }),
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: async () => ({
          document: {
            id: "doc-1",
            relativePath: "paper.md",
            revision: 2,
            contentHash: "document-hash",
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
          blocks: [],
          alreadyOpen: true,
        }),
      },
      bag,
      [],
      [],
      {},
    );
    const read = tools.find((tool) => tool.name === "read_workspace_file")!;
    const open = tools.find((tool) => tool.name === "open_document")!;

    await read.execute("read-before", { relativePath: "paper.md", offset: 0, limit: 6 });
    const opened = await open.execute("open-current", { relativePath: "paper.md" });
    await read.execute("read-after", { relativePath: "paper.md", offset: 0, limit: 6 });

    expect(JSON.parse((opened.content[0] as { text: string }).text).alreadyOpen).toBe(true);
    expect(reads).toBe(1);
  });

  it("discards old-document artifacts and context before continuing in a newly opened document", async () => {
    const bag: SessionDocBag = {
      documentId: "doc-a",
      revision: 1,
      relativePath: "a.md",
      blocks: [{
        id: "a1",
        kind: "paragraph",
        text: "Document A",
        order: 0,
        contentHash: "hash-a",
      }],
    };
    const drafts: Draft[] = [];
    const comments: AgentComment[] = [];
    const effects: SessionSideEffects = {
      tableCellProposals: [{} as never],
      reviewChecklists: [{} as never],
      cascadeOffer: [{ blockId: "a1", reason: "old document" }],
      finishSummary: "old summary",
    };
    let persistedEvidence: EvidenceCacheEntry[] = [{
      sourceRef: "notes.txt#sha256=0123456789abcdef&chars=0-4",
      relativePath: "notes.txt",
      start: 0,
      end: 4,
      extractedHash: "0123456789abcdef",
      versionHash: "a".repeat(64),
      preview: "note",
      readAt: "2026-08-03T00:00:00.000Z",
    }];
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["notes.txt", "b.md"],
        readText: (relativePath) => ({
          relativePath,
          text: "note",
          bytes: 4,
          versionHash: "a".repeat(64),
        }),
        readVersion: (relativePath) => ({
          relativePath,
          bytes: 4,
          versionHash: "a".repeat(64),
        }),
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: async () => ({
          document: {
            id: "doc-b",
            relativePath: "b.md",
            revision: 3,
            contentHash: "doc-hash-b",
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
          blocks: [{
            id: "b1",
            kind: "paragraph",
            text: "Document B",
            order: 0,
            contentHash: "hash-b",
          }],
        }),
      },
      bag,
      drafts,
      comments,
      effects,
      {
        selectionBlockIds: ["a1"],
        sourcePaths: ["notes.txt"],
        evidenceCache: persistedEvidence,
        onEvidenceCacheChange: (entries) => { persistedEvidence = entries; },
      },
    );
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    await byName.propose_block_edit!.execute("proposal-a", {
      blockId: "a1",
      after: "Revised A",
      rationale: "old document proposal",
      evidence: [],
    });
    await byName.propose_block_comment!.execute("comment-a", {
      blockId: "a1",
      text: "old document comment",
    });
    const opened = await byName.open_document!.execute("open-b", {
      relativePath: "b.md",
    });

    expect(JSON.parse((opened.content[0] as { text: string }).text))
      .toMatchObject({ documentId: "doc-b", discardedArtifactCount: 4 });
    expect(effects.documentSwitchOccurred).toBe(true);
    expect(drafts).toEqual([]);
    expect(comments).toEqual([]);
    expect(persistedEvidence).toEqual([]);
    expect(effects).not.toHaveProperty("tableCellProposals");
    expect(effects).not.toHaveProperty("reviewChecklists");
    expect(effects).not.toHaveProperty("cascadeOffer");
    expect(effects).not.toHaveProperty("finishSummary");
    const listed = await byName.list_workspace_files!.execute("list-b", {});
    expect(JSON.parse((listed.content[0] as { text: string }).text).sourcePaths).toEqual([]);

    await byName.propose_block_edit!.execute("proposal-b", {
      blockId: "b1",
      after: "Revised B",
      rationale: "new document proposal",
      evidence: [],
    });
    await byName.propose_block_comment!.execute("comment-b", {
      blockId: "b1",
      text: "new document comment",
    });
    expect(drafts).toMatchObject([{
      documentId: "doc-b",
      blockId: "b1",
      baseRevision: 3,
    }]);
    expect(comments).toMatchObject([{
      documentId: "doc-b",
      blockId: "b1",
    }]);
  });

  it("allows the same table cell target after switching documents", async () => {
    const tableBlock = {
      id: "shared-table",
      kind: "table" as const,
      text: "Name\tScore\nA\t90",
      order: 0,
      contentHash: "table-hash-a",
    };
    const bag: SessionDocBag = {
      documentId: "doc-a",
      revision: 1,
      relativePath: "a.docx",
      blocks: [tableBlock],
    };
    const effects: SessionSideEffects = {};
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["a.docx", "b.docx"],
        readText: (relativePath) => ({
          relativePath,
          text: "",
          bytes: 0,
          versionHash: "a".repeat(64),
        }),
        readVersion: (relativePath) => ({
          relativePath,
          bytes: 0,
          versionHash: "a".repeat(64),
        }),
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: async () => ({
          document: {
            id: "doc-b",
            relativePath: "b.docx",
            revision: 2,
            contentHash: "doc-hash-b",
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
          blocks: [{ ...tableBlock, contentHash: "table-hash-b" }],
        }),
        readTableCell: async () => ({ address: "B2", text: "90" }),
      },
      bag,
      [],
      [],
      effects,
    );
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const params = {
      blockId: tableBlock.id,
      address: "B2",
      row: 2,
      column: 2,
      before: "90",
      after: "100",
      rationale: "Correct the recorded score.",
    };

    await byName.propose_table_cell_edit!.execute("cell-a", params);
    await expect(byName.propose_table_cell_edit!.execute("duplicate-a", params))
      .rejects.toThrow("table cell already has a proposal this turn");

    const opened = await byName.open_document!.execute("open-b", { relativePath: "b.docx" });
    expect(JSON.parse((opened.content[0] as { text: string }).text))
      .toMatchObject({ documentId: "doc-b", discardedArtifactCount: 1 });

    await expect(byName.propose_table_cell_edit!.execute("cell-b", params)).resolves.toBeDefined();
    expect(effects.tableCellProposals).toMatchObject([{
      documentId: "doc-b",
      blockId: tableBlock.id,
      baseRevision: 2,
      baseHash: "table-hash-b",
    }]);
  });

  it("discards artifacts when the already active document opens at a newer revision", async () => {
    const bag: SessionDocBag = {
      documentId: "doc-1",
      revision: 1,
      relativePath: "paper.md",
      blocks: [{
        id: "old-block",
        kind: "paragraph",
        text: "Old revision",
        order: 0,
        contentHash: "old-hash",
      }],
    };
    const drafts = [{} as Draft];
    const comments = [{} as AgentComment];
    const effects: SessionSideEffects = {
      tableCellProposals: [{} as never],
      reviewChecklists: [{} as never],
    };
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["paper.md"],
        readText: () => ({
          relativePath: "paper.md",
          text: "New revision",
          bytes: 12,
          versionHash: "b".repeat(64),
        }),
        readVersion: () => ({
          relativePath: "paper.md",
          bytes: 12,
          versionHash: "b".repeat(64),
        }),
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: async () => ({
          document: {
            id: "doc-1",
            relativePath: "paper.md",
            revision: 2,
            contentHash: "new-document-hash",
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
          blocks: [{
            id: "new-block",
            kind: "paragraph",
            text: "New revision",
            order: 0,
            contentHash: "new-hash",
          }],
        }),
      },
      bag,
      drafts,
      comments,
      effects,
    );

    const open = tools.find((tool) => tool.name === "open_document")!;
    const result = await open.execute("open-new-revision", { relativePath: "paper.md" });

    expect(JSON.parse((result.content[0] as { text: string }).text))
      .toMatchObject({ documentId: "doc-1", revision: 2, discardedArtifactCount: 4 });
    expect(effects.documentSwitchOccurred).toBe(true);
    expect(drafts).toEqual([]);
    expect(comments).toEqual([]);
    expect(effects).not.toHaveProperty("tableCellProposals");
    expect(effects).not.toHaveProperty("reviewChecklists");
    expect(bag).toMatchObject({ documentId: "doc-1", revision: 2 });
  });
});

describe("write_workspace_file canonical guard", () => {
  it("refuses overwrite of the open document path", async () => {
    const bag: SessionDocBag = {
      documentId: "d1",
      revision: 1,
      relativePath: "fixtures/agent-chapter.md",
      blocks: [],
    };
    const written: string[] = [];
    const tools = createSessionTools(
      {
        listSourceFiles: () => [],
        readText: () => ({ relativePath: "", text: "", bytes: 0 }),
        writeText: async (relativePath, content) => {
          written.push(relativePath);
          return { relativePath, bytes: content.length, created: false };
        },
        openDocument: () => {
          throw new Error("unused");
        },
        listProtectedDocumentPaths: () => ["fixtures/agent-chapter.md"],
      },
      bag,
      [],
      [],
      {},
    );
    const write = tools.find((t) => t.name === "write_workspace_file")!;
    await expect(
      write.execute("1", {
        relativePath: "fixtures/agent-chapter.md",
        content: "hijack",
      }),
    ).rejects.toThrow(/canonical document/);
    expect(written).toEqual([]);
  });

  it("allows creating a new notes file", async () => {
    const bag: SessionDocBag = {
      revision: 0,
      blocks: [],
      relativePath: "fixtures/agent-chapter.md",
    };
    const tools = createSessionTools(
      {
        listSourceFiles: () => [],
        readText: () => ({ relativePath: "", text: "", bytes: 0 }),
        writeText: async (relativePath, content) => ({
          relativePath,
          bytes: content.length,
          created: true,
        }),
        openDocument: () => {
          throw new Error("unused");
        },
        listProtectedDocumentPaths: () => ["fixtures/agent-chapter.md"],
      },
      bag,
      [],
      [],
      {},
    );
    const write = tools.find((t) => t.name === "write_workspace_file")!;
    const result = await write.execute("1", {
      relativePath: "notes/scratch.md",
      content: "# ok\n",
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("invalidates the read cache and evidence refs after writing the same path", async () => {
    const bag: SessionDocBag = {
      revision: 0,
      blocks: [],
      relativePath: "fixtures/agent-chapter.md",
    };
    let text = "old";
    let persisted: import("@margin/domain").EvidenceCacheEntry[] = [{
      sourceRef: "notes/scratch.md#sha256=0123456789abcdef&chars=0-3",
      relativePath: "notes/scratch.md",
      start: 0,
      end: 3,
      extractedHash: "0123456789abcdef",
      versionHash: "a".repeat(64),
      preview: "old",
      readAt: "2026-08-01T00:00:00.000Z",
    }];
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["notes/scratch.md"],
        readText: async (relativePath) => ({
          relativePath,
          text,
          bytes: text.length,
          versionHash: text === "new" ? "b".repeat(64) : "a".repeat(64),
        }),
        writeText: async (relativePath, content) => {
          text = content;
          return { relativePath, bytes: content.length, created: false };
        },
        openDocument: () => {
          throw new Error("unused");
        },
        listProtectedDocumentPaths: () => ["fixtures/agent-chapter.md"],
      },
      bag,
      [],
      [],
      {},
      {
        sourcePaths: ["notes/scratch.md"],
        evidenceCache: persisted,
        onEvidenceCacheChange: (entries) => { persisted = entries; },
      },
    );
    const read = tools.find((t) => t.name === "read_workspace_file")!;
    const write = tools.find((t) => t.name === "write_workspace_file")!;

    const first = await read.execute("read-1", {
      relativePath: "notes/scratch.md",
      offset: 0,
      limit: 3,
    });
    expect(JSON.parse((first.content[0] as { text: string }).text).text).toBe("old");

    await write.execute("write-1", {
      relativePath: "notes/scratch.md",
      content: "new",
    });
    expect(persisted).toEqual([]);

    const second = await read.execute("read-2", {
      relativePath: "notes/scratch.md",
      offset: 0,
      limit: 3,
    });
    expect(JSON.parse((second.content[0] as { text: string }).text).text).toBe("new");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.versionHash).toBe("b".repeat(64));
  });
});

describe("attached source tools", () => {
  it("lists sources, reads bounded chunks, and binds sourceRef evidence", async () => {
    const drafts: import("./pi-tools.js").Draft[] = [];
    let reads = 0;
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["paper.md", "notes/interview.txt", "data/cases.csv"],
        readText: (relativePath) => {
          reads += 1;
          return {
            relativePath,
            text: "甲乙丙丁戊己庚辛",
            bytes: 24,
            versionHash: "a".repeat(64),
          };
        },
        readVersion: (relativePath) => ({
          relativePath,
          bytes: 24,
          versionHash: "a".repeat(64),
        }),
        writeText: async () => {
          throw new Error("unused");
        },
        openDocument: () => {
          throw new Error("unused");
        },
      },
      {
        documentId: "doc-1",
        revision: 2,
        relativePath: "paper.md",
        blocks: [
          {
            id: "b1",
            kind: "paragraph",
            text: "原段落",
            order: 0,
            contentHash: "hash-1",
          },
        ],
      },
      drafts,
      [],
      {},
      { sourcePaths: ["notes/interview.txt", "data/cases.csv"] },
    );
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const listed = await byName.list_workspace_files!.execute("list", {});
    const listedJson = JSON.parse(
      listed.content.find((item) => item.type === "text")!.text,
    );
    expect(listedJson.sourcePaths).toEqual([
      "notes/interview.txt",
      "data/cases.csv",
    ]);

    const full = await byName.read_workspace_file!.execute("read-full", {
      relativePath: "notes/interview.txt",
    });
    const fullJson = JSON.parse(
      full.content.find((item) => item.type === "text")!.text,
    );
    expect(fullJson).toMatchObject({
      text: "甲乙丙丁戊己庚辛",
      offset: 0,
      nextOffset: 8,
      hasMore: false,
      attached: true,
    });
    expect(fullJson.sourceRef).toMatch(/^notes\/interview\.txt#sha256=[a-f0-9]+&chars=0-8$/);

    const first = await byName.read_workspace_file!.execute("read-1", {
      relativePath: "notes/interview.txt",
      offset: 0,
      limit: 4,
    });
    const firstJson = JSON.parse(
      first.content.find((item) => item.type === "text")!.text,
    );
    expect(firstJson).toMatchObject({
      text: "甲乙丙丁",
      nextOffset: 4,
      hasMore: true,
      attached: true,
    });
    expect(firstJson.sourceRef).toMatch(/^notes\/interview\.txt#sha256=[a-f0-9]+&chars=0-4$/);

    const second = await byName.read_workspace_file!.execute("read-2", {
      relativePath: "notes/interview.txt",
      offset: firstJson.nextOffset,
      limit: 20,
    });
    const secondJson = JSON.parse(
      second.content.find((item) => item.type === "text")!.text,
    );
    expect(secondJson).toMatchObject({ text: "戊己庚辛", hasMore: false });
    expect(reads).toBe(1);

    await expect(
      byName.propose_block_edit!.execute("bad-evidence", {
        blockId: "b1",
        after: "新段落",
        rationale: "依据资料修订。",
        evidence: ["notes/not-attached.txt#chars=0-4"],
      }),
    ).rejects.toThrow(/attached sourcePath/);

    await expect(
      byName.propose_block_edit!.execute("unread-evidence", {
        blockId: "b1",
        after: "Revised",
        rationale: "Grounded",
        evidence: ["notes/interview.txt#chars=100-120"],
      } as never),
    ).rejects.toThrow(/returned by read_workspace_file/);
    expect(drafts).toHaveLength(0);

    await byName.propose_block_edit!.execute("good-evidence", {
      blockId: "b1",
      after: "新段落",
      rationale: "依据资料修订。",
      evidence: [firstJson.sourceRef],
    });
    expect(drafts[0]?.evidence).toEqual([firstJson.sourceRef]);
  });
});

describe("profile capability boundary", () => {
  it("keeps minimal Pi limited to essential proposal tools", () => {
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["notes.md"],
        readText: () => ({ relativePath: "notes.md", text: "", bytes: 0 }),
        writeText: async () => ({ relativePath: "notes.md", bytes: 0, created: true }),
        openDocument: () => { throw new Error("unused"); },
      },
      { revision: 0, blocks: [] },
      [],
      [],
      {},
      {
        harnessId: "minimal",
        enforceProfile: true,
        workspaceWriteApprovedPaths: ["notes.md"],
      },
    );
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("get_block");
    expect(names).toContain("propose_block_edit");
    expect(names).toContain("propose_text_patch");
    expect(names).toContain("finish_turn");
    expect(names).not.toContain("list_workspace_files");
    expect(names).not.toContain("write_workspace_file");
    expect(names).not.toContain("load_skill");
    expect(names.length).toBeLessThanOrEqual(6);
  });

  it("limits an approved write to the exact path named by the user", async () => {
    const written: string[] = [];
    const tools = createSessionTools(
      {
        listSourceFiles: () => [],
        readText: () => ({ relativePath: "", text: "", bytes: 0 }),
        writeText: async (relativePath, content) => {
          written.push(relativePath);
          return { relativePath, bytes: content.length, created: true };
        },
        openDocument: () => { throw new Error("unused"); },
      },
      { revision: 0, blocks: [] },
      [],
      [],
      {},
      {
        harnessId: "social-science-zh",
        enforceProfile: true,
        workspaceWriteApprovedPaths: ["notes/approved.md"],
      },
    );
    const write = tools.find((tool) => tool.name === "write_workspace_file")!;
    await expect(write.execute("wrong", {
      relativePath: "notes/other.md",
      content: "no",
    })).rejects.toThrow(/not approved/);
    await write.execute("right", {
      relativePath: "notes/approved.md",
      content: "ok",
    });
    expect(written).toEqual(["notes/approved.md"]);
  });
});

describe("finish_turn summary host wiring", () => {
  it("stores finish_turn.summary on session effects for the visible reply", async () => {
    const effects: import("./session-tools.js").SessionSideEffects = {};
    const tools = createSessionTools(
      {
        listSourceFiles: () => [],
        readText: () => ({ relativePath: "", text: "", bytes: 0 }),
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: () => {
          throw new Error("unused");
        },
      },
      {
        documentId: "doc-1",
        revision: 1,
        relativePath: "paper.md",
        blocks: [
          {
            id: "b1",
            kind: "paragraph",
            text: "一段正文",
            order: 0,
            contentHash: "h1",
          },
        ],
      },
      [],
      [],
      effects,
    );
    const finish = tools.find((tool) => tool.name === "finish_turn")!;
    await finish.execute("fin", {
      summary: "拒稿点一：摘要承诺未被方法章兑现。",
    });
    expect(effects.finishSummary).toBe("拒稿点一：摘要承诺未被方法章兑现。");
  });
});

describe("list_workspace_files", () => {
  it("lists workspace materials by default and absolute directories when provided", async () => {
    const tools = createSessionTools(
      {
        listSourceFiles: () => ["notes.txt"],
        listExternalDirectory: (absolutePath) => ({
          path: absolutePath.replace(/\\/g, "/"),
          files: [`${absolutePath.replace(/\\/g, "/")}/a.pdf`],
          directories: [`${absolutePath.replace(/\\/g, "/")}/notes`],
          truncated: false,
        }),
        readText: () => ({ relativePath: "", text: "", bytes: 0 }),
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: async () => {
          throw new Error("unused");
        },
      },
      {
        documentId: "doc-1",
        revision: 1,
        relativePath: "paper.md",
        blocks: [],
      },
      [],
      [],
      {},
    );
    const list = tools.find((tool) => tool.name === "list_workspace_files")!;

    const workspace = JSON.parse(
      ((await list.execute("list-ws", {})).content[0] as { text: string }).text,
    );
    expect(workspace.files).toEqual(["notes.txt"]);

    const external = JSON.parse(
      ((await list.execute("list-ext", {
        directory: "E:/academic/spviolence/park",
      })).content[0] as { text: string }).text,
    );
    expect(external.path).toBe("E:/academic/spviolence/park");
    expect(external.files).toEqual(["E:/academic/spviolence/park/a.pdf"]);
    expect(external.directories).toEqual(["E:/academic/spviolence/park/notes"]);
  });

  it("passes recursive list options to the host bridge", async () => {
    const seen: Array<{ recursive?: boolean; extensions?: string[]; query?: string }> = [];
    const tools = createSessionTools(
      {
        listSourceFiles: () => [],
        listExternalDirectory: (_absolutePath, opts) => {
          seen.push(opts ?? {});
          return {
            path: "E:/data",
            files: ["E:/data/a.pdf"],
            directories: [],
            truncated: false,
          };
        },
        readText: () => ({ relativePath: "", text: "", bytes: 0, versionHash: "v" }),
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: async () => {
          throw new Error("unused");
        },
      },
      { documentId: "doc-1", revision: 1, relativePath: "paper.md", blocks: [] },
      [],
      [],
      {},
    );
    const list = tools.find((tool) => tool.name === "list_workspace_files")!;
    await list.execute("list-rec", {
      directory: "E:/data",
      recursive: true,
      extensions: [".pdf"],
      query: "report",
    });
    expect(seen).toEqual([
      { recursive: true, extensions: [".pdf"], query: "report" },
    ]);
  });

  it("maps host filesystem errors to actionable Chinese", async () => {
    const tools = createSessionTools(
      {
        listSourceFiles: () => [],
        readText: () => {
          throw new Error(
            "path is outside workspace; unlimited read is off — enable in Agent settings, or unset MARGIN_UNLIMITED=0",
          );
        },
        writeText: async () => ({ relativePath: "", bytes: 0, created: false }),
        openDocument: async () => {
          throw new Error("unused");
        },
      },
      { documentId: "doc-1", revision: 1, relativePath: "paper.md", blocks: [] },
      [],
      [],
      {},
    );
    const read = tools.find((tool) => tool.name === "read_workspace_file")!;
    await expect(read.execute("read", { relativePath: "E:/secret.env" })).rejects.toThrow(
      /外读已关闭/,
    );
  });
});
