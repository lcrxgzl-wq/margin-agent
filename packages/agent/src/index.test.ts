import { describe, expect, it } from "vitest";
import {
  citeCheck,
  createPaperAgentAdapter,
  createPaperTools,
  preferredEngine,
  resolveBlockSnapshot,
  resolveEngine,
  runBlockScan,
  searchBlocks,
  styleLint,
  buildOutline,
  unknownBlockIdError,
} from "./index.js";

const sampleBlocks = [
  {
    id: "h1",
    kind: "heading" as const,
    text: "# 县域教育",
    order: 0,
    contentHash: "h",
  },
  {
    id: "b1",
    kind: "paragraph" as const,
    text: "既有研究（张三，2020）较少讨论执行张力，亦见深度赋能叙事。DOI 10.1000/xyz123",
    order: 1,
    contentHash: "x",
  },
];

const tableBlock = {
  id: "t1",
  kind: "table" as const,
  text: "姓名\t分数\n张三\t90",
  order: 2,
  contentHash: "table-hash",
};

describe("paper agent adapter", () => {
  it("exposes agent-first metadata", () => {
    const a = createPaperAgentAdapter();
    expect(a.id).toBe("margin-paper-agent");
    expect(a.version).toBe("0.1.0");
    expect(preferredEngine()).toBe("pi");
  });

  it("default resolveEngine is pi", () => {
    const prev = process.env.MARGIN_ENGINE;
    delete process.env.MARGIN_ENGINE;
    try {
      expect(resolveEngine()).toBe("pi");
    } finally {
      if (prev === undefined) delete process.env.MARGIN_ENGINE;
      else process.env.MARGIN_ENGINE = prev;
    }
  });

  it("simple engine scans via llm/harness (mock)", async () => {
    const prev = process.env.MARGIN_ENGINE;
    process.env.MARGIN_ENGINE = "simple";
    try {
      const phases: string[] = [];
      const result = await runBlockScan(
        {
          documentId: "d1",
          revision: 0,
          blocks: sampleBlocks,
        },
        undefined,
        (e) => phases.push(e.phase),
      );
      expect(result.engine).toBe("simple");
      expect(result.proposals.length).toBeGreaterThan(0);
      expect(result.comments?.length).toBeGreaterThan(0);
      expect(result.steps?.length).toBeGreaterThan(0);
      expect(phases.length).toBeGreaterThan(0);
      expect(phases[0]).toContain("读取");
    } finally {
      if (prev === undefined) delete process.env.MARGIN_ENGINE;
      else process.env.MARGIN_ENGINE = prev;
    }
  });

  it("selects simple before execution when no key exists", async () => {
    const prev = process.env.MARGIN_ENGINE;
    delete process.env.MARGIN_ENGINE;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MARGIN_API_KEY;
    delete process.env.MARGIN_BASE_URL;
    try {
      expect(resolveEngine()).toBe("pi");
      const result = await runBlockScan({
        documentId: "d1",
        revision: 0,
        blocks: [sampleBlocks[1]!],
      });
      expect(result.engine).toBe("simple");
      expect(result.proposals).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.MARGIN_ENGINE;
      else process.env.MARGIN_ENGINE = prev;
    }
  });

  it("simple scan skips flattened table blocks instead of drafting a full-table replacement", async () => {
    const prev = process.env.MARGIN_ENGINE;
    process.env.MARGIN_ENGINE = "simple";
    try {
      const result = await runBlockScan(
        { documentId: "d1", revision: 0, blocks: [tableBlock] },
        [tableBlock.id],
      );
      expect(result.proposals).toHaveLength(0);
      expect(result.steps).toContain("跳过表格 1/1");
    } finally {
      if (prev === undefined) delete process.env.MARGIN_ENGINE;
      else process.env.MARGIN_ENGINE = prev;
    }
  });

  it("preferSimple bypasses the pi tool loop for one selected block", async () => {
    const previous = Object.fromEntries(
      [
        "MARGIN_ENGINE",
        "MARGIN_API_FORMAT",
        "MARGIN_BASE_URL",
        "MARGIN_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
      ].map((key) => [key, process.env[key]]),
    );
    process.env.MARGIN_ENGINE = "pi";
    delete process.env.MARGIN_BASE_URL;
    delete process.env.MARGIN_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const result = await runBlockScan(
        {
          documentId: "d1",
          revision: 7,
          blocks: sampleBlocks,
          instruction: "Make it concise.",
          preferSimple: true,
        },
        ["b1"],
      );
      expect(result.engine).toBe("simple");
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]).toMatchObject({
        documentId: "d1",
        blockId: "b1",
        baseRevision: 7,
        baseHash: "x",
        before: sampleBlocks[1]!.text,
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reports readable progress for a direct multi-block proposal", async () => {
    const result = await runBlockScan(
      {
        documentId: "d1",
        revision: 2,
        blocks: sampleBlocks,
        instruction: "Make both blocks concise.",
        preferSimple: true,
      },
      ["h1", "b1"],
    );

    expect(result.proposals).toHaveLength(2);
    expect(result.steps).toEqual([
      "读取跨段落选区",
      "生成修订提案 1/2",
      "生成修订提案 2/2",
      "完成（2 处提案）",
    ]);
  });

  it("preserves unselected text on both edges of a cross-paragraph selection", async () => {
    const edgeBlocks = [
      { id: "a", kind: "paragraph" as const, text: "KEEP-A select-A", order: 0, contentHash: "a" },
      { id: "b", kind: "paragraph" as const, text: "middle", order: 1, contentHash: "b" },
      { id: "c", kind: "paragraph" as const, text: "select-C KEEP-C", order: 2, contentHash: "c" },
    ];
    const result = await runBlockScan(
      {
        documentId: "d1",
        revision: 2,
        blocks: edgeBlocks,
        instruction: "Rewrite only the selection.",
        operation: "rewrite",
        selectionText: "select-Amiddleselect-C",
        selectionRanges: [
          { blockId: "a", start: 7, end: 15, before: "select-A" },
          { blockId: "b", start: 0, end: 6, before: "middle" },
          { blockId: "c", start: 0, end: 8, before: "select-C" },
        ],
        selectionContextChars: 48_000,
        preferSimple: true,
      },
      ["a", "b", "c"],
    );

    expect(result.proposals).toHaveLength(3);
    expect(result.proposals[0]).toMatchObject({
      before: "KEEP-A select-A",
      operation: {
        scope: "selection",
        selection: { start: 7, end: 15, before: "select-A" },
      },
    });
    expect(result.proposals[0]?.after.startsWith("KEEP-A ")).toBe(true);
    expect(result.proposals[1]?.operation?.scope).toBe("block");
    expect(result.proposals[2]).toMatchObject({
      before: "select-C KEEP-C",
      operation: {
        scope: "selection",
        selection: { start: 0, end: 8, before: "select-C" },
      },
    });
    expect(result.proposals[2]?.after.endsWith(" KEEP-C")).toBe(true);
  });

  it("rejects cross-paragraph selection text without exact ranges", async () => {
    await expect(runBlockScan(
      {
        documentId: "d1",
        revision: 2,
        blocks: sampleBlocks,
        selectionText: `${sampleBlocks[0]!.text}${sampleBlocks[1]!.text}`,
        preferSimple: true,
      },
      ["h1", "b1"],
    )).rejects.toThrow(/requires exact per-block ranges/);
  });

  it("creates a cell-only proposal for an exact table target", async () => {
    const result = await runBlockScan(
      {
        documentId: "d1",
        revision: 4,
        blocks: [tableBlock],
        instruction: "Polish this cell.",
        operation: "polish",
        tableCell: { row: 2, column: 2, address: "B2", before: "90" },
        preferSimple: true,
      },
      [tableBlock.id],
    );

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      blockId: tableBlock.id,
      baseHash: tableBlock.contentHash,
      before: "90",
      tableCell: { row: 2, column: 2, address: "B2", before: "90" },
    });
    expect(result.proposals[0]?.operation).toBeUndefined();
    expect(result.proposals[0]?.after).not.toContain(tableBlock.text);
  });
});

describe("academic heuristics", () => {
  it("cite_check marks not_verified", () => {
    const r = citeCheck([sampleBlocks[1]!]);
    expect(r.disclaimer).toMatch(/未验证/);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.every((f) => f.heuristic_only && f.verification === "not_verified")).toBe(
      true,
    );
  });

  it("style_lint hits clichés", () => {
    const r = styleLint([sampleBlocks[1]!]);
    expect(r.findings.some((f) => f.label.includes("赋能"))).toBe(true);
  });

  it("outline and search are stable", () => {
    expect(buildOutline(sampleBlocks)).toEqual([
      { blockId: "h1", level: 1, title: "县域教育", order: 0 },
    ]);
    expect(searchBlocks(sampleBlocks, "执行张力")).toHaveLength(1);
  });
});

describe("paper tools", () => {
  it("list/get/propose/comment/cite/style/finish without LLM", async () => {
    const drafts: import("./pi-tools.js").Draft[] = [];
    const comments: import("./types.js").AgentComment[] = [];
    const summaries: string[] = [];
    const tools = createPaperTools(
      {
        getBlocks: () => sampleBlocks,
        getDocumentId: () => "doc1",
        getRevision: () => 3,
        onFinishSummary: (summary) => summaries.push(summary),
      },
      drafts,
      comments,
    );
    expect(tools.map((t) => t.name)).toEqual([
      "get_document_outline",
      "list_blocks",
      "get_block",
      "search_blocks",
      "offer_cascade",
      "propose_block_edit",
      "propose_block_comment",
      "cite_check",
      "style_lint",
      "inspect_tabular_file",
      "run_table_analysis",
      "get_analysis_result",
      "propose_block_edit_from_results",
      "finish_turn",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    await byName.get_document_outline!.execute("1", {});
    await byName.search_blocks!.execute("2", { query: "张三" });
    const cite = await byName.cite_check!.execute("3", {});
    const citeJson = JSON.parse(
      cite.content.find((c) => c.type === "text")!.text,
    );
    expect(citeJson.findings[0].verification).toBe("not_verified");

    await byName.propose_block_edit!.execute("4", {
      blockId: "b1",
      after: "修订后文本。",
      rationale: "去掉套话。",
      risk: "language",
    });
    expect(drafts[0]?.baseRevision).toBe(3);
    expect(drafts[0]?.baseHash).toBe("x");

    await byName.propose_block_comment!.execute("5", {
      blockId: "b1",
      text: "建议补充材料—理论桥接",
      severity: "warning",
    });
    expect(comments[0]?.ephemeral).toBe(true);
    expect(comments[0]?.severity).toBe("warn");

    const fin = await byName.finish_turn!.execute("6", {
      summary: "结构分析长文只应作为收束，不应单独消失。",
    });
    expect(fin.terminate).toBe(true);
    expect(summaries).toEqual(["结构分析长文只应作为收束，不应单独消失。"]);
  });

  it("omits pack tools for the minimal harness or none pack", () => {
    const ctx = {
      getBlocks: () => sampleBlocks,
      getDocumentId: () => "doc1",
      getRevision: () => 3,
    };
    const minimalTools = createPaperTools(ctx, [], [], { harnessId: "minimal" });
    const noPackTools = createPaperTools(ctx, [], [], { packId: "none" });
    const emptyPackTools = createPaperTools(ctx, [], [], { packId: "" });

    for (const tools of [minimalTools, noPackTools, emptyPackTools]) {
      const names = tools.map((tool) => tool.name);
      expect(names).not.toContain("cite_check");
      expect(names).not.toContain("style_lint");
    }
  });

  it("deduplicates proposals and terminates when every scan target is covered", async () => {
    const drafts: import("./pi-tools.js").Draft[] = [];
    const tools = createPaperTools(
      {
        getBlocks: () => sampleBlocks,
        getDocumentId: () => "doc1",
        getRevision: () => 3,
        proposeScope: { primaryAllowlist: ["b1"] },
        terminateWhenPrimaryCovered: true,
      },
      drafts,
      [],
      { packId: "none" },
    );
    const propose = tools.find((tool) => tool.name === "propose_block_edit")!;
    const first = await propose.execute("first", {
      blockId: "b1",
      after: "修订文本",
      rationale: "减少重复调用。",
      risk: "argumentation",
    });
    const duplicate = await propose.execute("duplicate", {
      blockId: "b1",
      after: "另一版修订",
      rationale: "不应覆盖首份提案。",
    });

    expect(first.terminate).toBe(true);
    expect(drafts[0]?.risk).toBe("argument");
    expect(duplicate.terminate).toBe(true);
    expect(drafts).toHaveLength(1);
    expect(duplicate.details).toMatchObject({ duplicate: true });
  });

  it("reuses the block index across block-addressing tools in one turn", async () => {
    let mapCalls = 0;
    const blocks = new Proxy(sampleBlocks, {
      get(target, property, receiver) {
        if (property !== "map") return Reflect.get(target, property, receiver);
        return (...args: Parameters<typeof target.map>) => {
          mapCalls += 1;
          return target.map(...args);
        };
      },
    });
    const tools = createPaperTools(
      {
        getBlocks: () => blocks,
        getDocumentId: () => "doc1",
        getRevision: () => 3,
      },
      [],
      [],
      { packId: "none" },
    );
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    await byName.get_block!.execute("get", { blockId: "b1" });
    await byName.propose_block_edit!.execute("propose", {
      blockId: "b1",
      after: "修订文本。",
      rationale: "测试索引复用。",
    });
    await byName.propose_block_comment!.execute("comment", {
      blockId: "b1",
      text: "测试索引复用。",
    });

    expect(mapCalls).toBe(1);
  });

  it("does not create an unsafe full-table text proposal", async () => {
    const drafts: import("./pi-tools.js").Draft[] = [];
    const tools = createPaperTools(
      {
        getBlocks: () => [...sampleBlocks, tableBlock],
        getDocumentId: () => "doc1",
        getRevision: () => 3,
      },
      drafts,
      [],
      { packId: "none" },
    );
    const propose = tools.find((tool) => tool.name === "propose_block_edit")!;

    await expect(propose.execute("table", {
      blockId: tableBlock.id,
      after: "姓名\t分数\n张三\t100",
      rationale: "修改成绩。",
    })).rejects.toThrow(/Full-table text replacement is forbidden/);
    expect(drafts).toHaveLength(0);
    expect(tools.map((tool) => tool.name)).not.toContain("propose_table_cell_edit");
  });

  it("creates a review-only cell proposal when the Host supplies an exact resolver", async () => {
    const collected: import("@margin/domain").TableCellProposalDraft[] = [];
    const drafts: import("./pi-tools.js").Draft[] = [];
    const tools = createPaperTools(
      {
        getBlocks: () => [...sampleBlocks, tableBlock],
        getDocumentId: () => "doc1",
        getRevision: () => 3,
        getTableCell: (blockId, row, column) =>
          blockId === tableBlock.id && row === 2 && column === 2
            ? { address: "B2", text: "90" }
            : undefined,
        onTableCellProposal: (proposal) => collected.push(proposal),
      },
      drafts,
      [],
      { packId: "none" },
    );
    const propose = tools.find((tool) => tool.name === "propose_table_cell_edit")!;
    const result = await propose.execute("cell", {
      blockId: tableBlock.id,
      address: "B2",
      row: 2,
      column: 2,
      before: "90",
      after: "100",
      rationale: "修正录入值。",
      risk: "fact",
    });

    expect(drafts).toHaveLength(0);
    expect(collected).toEqual([expect.objectContaining({
      blockId: tableBlock.id,
      baseHash: tableBlock.contentHash,
      applyMode: "host_table_cell_patch",
      cell: { address: "B2", row: 2, column: 2, before: "90", after: "100" },
    })]);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      applied: false,
      persisted: false,
      requiresHostReview: true,
    });
  });

  it("rejects stale or mismatched table cell targets", async () => {
    const tools = createPaperTools(
      {
        getBlocks: () => [...sampleBlocks, tableBlock],
        getDocumentId: () => "doc1",
        getRevision: () => 3,
        getTableCell: () => ({ address: "B2", text: "90" }),
        onTableCellProposal: () => undefined,
      },
      [],
      [],
      { packId: "none" },
    );
    const propose = tools.find((tool) => tool.name === "propose_table_cell_edit")!;
    await expect(propose.execute("wrong-address", {
      blockId: tableBlock.id,
      address: "C2",
      row: 2,
      column: 2,
      before: "90",
      after: "100",
      rationale: "测试。",
    })).rejects.toThrow(/address/);
    await expect(propose.execute("stale", {
      blockId: tableBlock.id,
      address: "B2",
      row: 2,
      column: 2,
      before: "91",
      after: "100",
      rationale: "测试。",
    })).rejects.toThrow(/stale/);
  });
  it("resolveBlockSnapshot remaps stale ooxml body-index ids", () => {
    const blocks = [
      {
        id: "ooxml-p-19-aabbccddeeff",
        kind: "paragraph" as const,
        text: "当前段落",
        order: 0,
        contentHash: "cur",
      },
      {
        id: "ooxml-p-21-112233445566",
        kind: "paragraph" as const,
        text: "邻段",
        order: 1,
        contentHash: "n",
      },
    ];
    const resolved = resolveBlockSnapshot(blocks, "ooxml-p-19-56e637661df7");
    expect(resolved.block.id).toBe("ooxml-p-19-aabbccddeeff");
    expect(resolved.remappedFrom).toBe("ooxml-p-19-56e637661df7");
    expect(() => resolveBlockSnapshot(blocks, "ooxml-p-99-deadbeef")).toThrow(/Nearest:.*ooxml-p-21/);
    expect(() => resolveBlockSnapshot(blocks, "not-a-block")).toThrow(/Sample current ids/);
    expect(unknownBlockIdError(blocks, "ooxml-p-19-x").message).toMatch(/Call list_blocks/);
  });

  it("get_block remaps stale hash suffix and refreshes index after in-place reindex", async () => {
    const bag = {
      blocks: [
        {
          id: "ooxml-p-19-oldhash00001",
          kind: "paragraph" as const,
          text: "旧文",
          order: 0,
          contentHash: "old",
        },
      ],
    };
    const tools = createPaperTools(
      {
        getBlocks: () => bag.blocks,
        getDocumentId: () => "doc1",
        getRevision: () => 1,
      },
      [],
      [],
      { packId: "none" },
    );
    const getBlock = tools.find((tool) => tool.name === "get_block")!;

    const remapped = await getBlock.execute("stale", { blockId: "ooxml-p-19-56e637661df7" });
    expect(remapped.details).toMatchObject({
      blockId: "ooxml-p-19-oldhash00001",
      remappedFrom: "ooxml-p-19-56e637661df7",
    });
    expect(JSON.parse(remapped.content[0]!.text)).toMatchObject({
      id: "ooxml-p-19-oldhash00001",
      resolvedFrom: "ooxml-p-19-56e637661df7",
    });

    // Same array reference, new ids (reindex after apply) must not serve stale map entries.
    bag.blocks.splice(0, bag.blocks.length, {
      id: "ooxml-p-19-newhash00002",
      kind: "paragraph" as const,
      text: "新文",
      order: 0,
      contentHash: "new",
    });
    const afterReindex = await getBlock.execute("fresh", { blockId: "ooxml-p-19-newhash00002" });
    expect(afterReindex.details).toMatchObject({ blockId: "ooxml-p-19-newhash00002", remappedFrom: null });
    const viaStale = await getBlock.execute("via-stale", { blockId: "ooxml-p-19-oldhash00001" });
    expect(viaStale.details).toMatchObject({
      blockId: "ooxml-p-19-newhash00002",
      remappedFrom: "ooxml-p-19-oldhash00001",
    });
  });

});
