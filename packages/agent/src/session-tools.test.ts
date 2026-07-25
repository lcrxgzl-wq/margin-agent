import { describe, expect, it } from "vitest";
import { createSessionTools, type SessionDocBag } from "./session-tools.js";

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
          };
        },
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

describe("remote MCP tools", () => {
  it("exposes only the host-provided MCP list and delegates calls", async () => {
    const calls: unknown[] = [];
    const tools = createSessionTools(
      {
        listSourceFiles: () => [],
        readText: () => ({ relativePath: "", text: "", bytes: 0 }),
        writeText: async () => ({ relativePath: "", bytes: 0, created: true }),
        openDocument: () => { throw new Error("unused"); },
        mcp: {
          listTools: async () => [{
            serverId: "mcp-1",
            serverName: "Library",
            name: "lookup",
            description: "Read evidence",
          }],
          callTool: async (input) => {
            calls.push(input);
            return "evidence-result";
          },
        },
      },
      { revision: 0, blocks: [] },
      [],
      [],
      {},
    );
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const listed = await byName.list_mcp_tools!.execute("list", {});
    expect(JSON.parse(listed.content[0]!.type === "text" ? listed.content[0].text : "{}"))
      .toMatchObject({ tools: [{ name: "lookup" }] });
    const called = await byName.call_mcp_tool!.execute("call", {
      serverId: "mcp-1",
      name: "lookup",
      arguments: { query: "sport" },
    });
    expect(called.content[0]).toMatchObject({ type: "text", text: "evidence-result" });
    expect(calls).toEqual([{ serverId: "mcp-1", name: "lookup", arguments: { query: "sport" } }]);
  });
});
