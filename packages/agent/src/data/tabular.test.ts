import { describe, expect, it } from "vitest";
import { contentHash } from "@margin/domain";
import { AnalysisRunStore } from "./store.js";
import {
  type DatasetHandle,
  formatResultValue,
  inspectCsv,
  parseCsv,
  resultRefFor,
  runAnalysis,
} from "./tabular.js";
import { createPaperTools } from "../pi-tools.js";

describe("tabular engine", () => {
  it("parses csv and aggregates by group", () => {
    const csv = `group,score
A,10
A,20
B,30
`;
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual(["group", "score"]);
    expect(rows).toHaveLength(3);
    const ds = inspectCsv("data/x.csv", csv);
    const run = runAnalysis(ds, {
      groupBy: ["group"],
      aggregates: [
        { id: "n", op: "count" },
        { id: "mean_score", op: "mean", column: "score" },
      ],
      sort: [{ column: "group", direction: "asc" }],
    });
    expect(run.resultSets[0]!.rows).toEqual([
      ["A", 2, 15],
      ["B", 1, 30],
    ]);
    expect(formatResultValue(12, { decimals: 2 })).toBe("12.00");
    expect(formatResultValue(12.5, { percent: true, decimals: 1 })).toBe("12.5%");
  });

  it("validates aggregate columns before reading dataset rows", () => {
    const ds = inspectCsv("data/x.csv", "score\n10\n");
    Object.defineProperty(ds, "_rows", {
      get() {
        throw new Error("rows read before aggregate validation");
      },
    });

    expect(() =>
      runAnalysis(ds, {
        aggregates: [{ id: "total", op: "sum", column: "missing" }],
      }),
    ).toThrow("Unknown aggregate column: missing");
  });

  it("rejects duplicate result column names", () => {
    const ds = inspectCsv("data/x.csv", "group,score\nA,10\n");

    expect(() =>
      runAnalysis(ds, {
        aggregates: [
          { id: "total", op: "sum", column: "score" },
          { id: "total", op: "count" },
        ],
      }),
    ).toThrow("Duplicate aggregate id: total");
    expect(() =>
      runAnalysis(ds, {
        groupBy: ["group"],
        aggregates: [{ id: "group", op: "count" }],
      }),
    ).toThrow("Aggregate id conflicts with groupBy column: group");
    expect(() =>
      runAnalysis(ds, {
        groupBy: ["group", "group"],
        aggregates: [{ id: "count", op: "count" }],
      }),
    ).toThrow("Duplicate groupBy column: group");
  });

  it("computes min and max without spreading large columns", () => {
    const rowCount = 200_000;
    const ds = {
      datasetRef: "ds_large",
      path: "data/large.csv",
      inputHash: "large",
      bytes: 0,
      rowCount,
      columns: [{ name: "value", inferredType: "integer", nullCount: 0 }],
      sample: [[0]],
      warnings: [],
      _rows: Array.from({ length: rowCount }, (_, value) => ({ value })),
    } satisfies DatasetHandle;

    const run = runAnalysis(ds, {
      aggregates: [
        { id: "minimum", op: "min", column: "value" },
        { id: "maximum", op: "max", column: "value" },
      ],
    });

    expect(run.resultSets[0]!.rows).toEqual([[0, rowCount - 1]]);
  });

  it("stops scanning when a grouping exceeds the result limit", () => {
    const rowCount = 10_002;
    const rows: Array<Record<string, unknown>> = Array.from(
      { length: rowCount },
      (_, group) => ({ group: `g${group}` }),
    );
    Object.defineProperty(rows, 10_001, {
      get() {
        throw new Error("scanned past group limit");
      },
    });
    const ds = {
      datasetRef: "ds_many_groups",
      path: "data/many-groups.csv",
      inputHash: "many-groups",
      bytes: 0,
      rowCount,
      columns: [{ name: "group", inferredType: "string", nullCount: 0 }],
      sample: [["g0"]],
      warnings: [],
      _rows: rows,
    } satisfies DatasetHandle;

    expect(() =>
      runAnalysis(ds, {
        groupBy: ["group"],
        aggregates: [{ id: "count", op: "count" }],
      }),
    ).toThrow("Result too large (max 10000 rows)");
  });
});

describe("propose_block_edit_from_results", () => {
  it("host-binds numbers into a proposal with evidence", async () => {
    const csv = `group,score\nA,10\nA,20\n`;
    const store = new AnalysisRunStore();
    const ds = inspectCsv("data/x.csv", csv);
    store.putDataset(ds);
    const run = runAnalysis(ds, {
      aggregates: [{ id: "mean_score", op: "mean", column: "score" }],
    });
    store.putRun(run);
    const ref = resultRefFor(run.runId, "summary", 0, "mean_score");

    const blockText = "| 均值 |\n| --- |\n| TBD |";
    const drafts: import("../pi-tools.js").Draft[] = [];
    const tools = createPaperTools(
      {
        getBlocks: () => [
          {
            id: "b1",
            kind: "paragraph",
            text: blockText,
            order: 0,
            contentHash: contentHash(blockText),
          },
        ],
        getDocumentId: () => "doc1",
        getRevision: () => 1,
      },
      drafts,
      [],
      {
        harnessId: "social-science-zh",
        extras: {
          analysisStore: store,
          readText: () => ({ relativePath: "data/x.csv", text: csv, bytes: csv.length }),
        },
      },
    );
    const propose = tools.find((t) => t.name === "propose_block_edit_from_results")!;
    await propose.execute("1", {
      blockId: "b1",
      template: "| 均值 |\n| --- |\n| {{mean}} |",
      bindings: [{ token: "mean", resultRef: ref, format: { decimals: 1 } }],
      rationale: "填入分组均值",
      risk: "fact",
    });
    expect(drafts[0]?.after).toContain("15.0");
    expect(drafts[0]?.evidence[0]).toContain(ref);
    expect(drafts[0]?.baseHash).toBe(contentHash(blockText));
  });

  it("does not route analysis results through a flattened table replacement", async () => {
    const store = new AnalysisRunStore();
    const csv = `score\n10\n20\n`;
    const ds = inspectCsv("data/x.csv", csv);
    store.putDataset(ds);
    const run = runAnalysis(ds, {
      aggregates: [{ id: "mean_score", op: "mean", column: "score" }],
    });
    store.putRun(run);
    const ref = resultRefFor(run.runId, "summary", 0, "mean_score");
    const drafts: import("../pi-tools.js").Draft[] = [];
    const tools = createPaperTools(
      {
        getBlocks: () => [{
          id: "table-1",
          kind: "table",
          text: "均值\nTBD",
          order: 0,
          contentHash: contentHash("均值\nTBD"),
        }],
        getDocumentId: () => "doc1",
        getRevision: () => 1,
      },
      drafts,
      [],
      {
        harnessId: "social-science-zh",
        extras: {
          analysisStore: store,
          readText: () => ({ relativePath: "data/x.csv", text: csv, bytes: csv.length }),
        },
      },
    );
    const propose = tools.find((tool) => tool.name === "propose_block_edit_from_results")!;

    await expect(propose.execute("table", {
      blockId: "table-1",
      template: "均值\n{{mean}}",
      bindings: [{ token: "mean", resultRef: ref }],
      rationale: "填入均值。",
    })).rejects.toThrow(/Full-table text replacement is forbidden/);
    expect(drafts).toHaveLength(0);
  });
});
