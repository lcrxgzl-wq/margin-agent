import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { RiskLevel } from "@margin/domain";
import { assertCanProposeBlock, noteCascadePropose } from "../cascade.js";
import {
  formatResultValue,
  inspectCsv,
  resultRefFor,
  runAnalysis,
  type AnalysisPlan,
  type FilterExpr,
} from "../data/tabular.js";
import type { AnalysisRunStore } from "../data/store.js";
import type { Draft } from "../pi-tools.js";
import type { MarginPack, PackExtras } from "./types.js";

function requireRead(extras?: PackExtras) {
  if (!extras?.readText) {
    throw new Error("Workspace read bridge unavailable for tabular tools");
  }
  return extras.readText;
}

function requireStore(extras?: PackExtras): AnalysisRunStore {
  if (!extras?.analysisStore) {
    throw new Error("Analysis store unavailable");
  }
  return extras.analysisStore;
}

export const dataAnalysisPack: MarginPack = {
  id: "data-analysis",
  toolProfile: [
    "inspect_tabular_file",
    "run_table_analysis",
    "get_analysis_result",
    "propose_block_edit_from_results",
  ],
  createTools: (ctx, drafts, _comments, extras) => {
    const inspectTool: AgentTool = {
      name: "inspect_tabular_file",
      label: "Inspect Tabular File",
      description:
        "Inspect a workspace CSV/TSV (schema, sample, inputHash). Read-only; no arbitrary code.",
      parameters: Type.Object({
        relativePath: Type.String(),
        sampleRows: Type.Optional(Type.Number()),
      }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const readText = requireRead(extras);
        const store = requireStore(extras);
        const params = raw as { relativePath: string; sampleRows?: number };
        const file = await readText(String(params.relativePath));
        if (!/\.(csv|tsv)$/i.test(file.relativePath)) {
          throw new Error("Only .csv / .tsv supported in v1");
        }
        const text =
          /\.tsv$/i.test(file.relativePath) && !file.text.includes(",")
            ? file.text
                .split(/\r?\n/)
                .map((line) =>
                  line
                    .split("\t")
                    .map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
                    .join(","),
                )
                .join("\n")
            : file.text;
        const ds = inspectCsv(file.relativePath, text, params.sampleRows ?? 20);
        store.putDataset(ds);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                datasetRef: ds.datasetRef,
                path: ds.path,
                inputHash: ds.inputHash,
                bytes: ds.bytes,
                rowCount: ds.rowCount,
                columns: ds.columns,
                sample: ds.sample,
                warnings: ds.warnings,
              }),
            },
          ],
          details: { datasetRef: ds.datasetRef, effect: "read" },
        };
      },
    };

    const runTool: AgentTool = {
      name: "run_table_analysis",
      label: "Run Table Analysis",
      description:
        "Run a declarative analysis plan (filter/group/aggregate). No shell, SQL string, or Python.",
      parameters: Type.Object({
        datasetRef: Type.String(),
        plan: Type.Object({
          filters: Type.Optional(
            Type.Array(
              Type.Object({
                column: Type.String(),
                op: Type.String(),
                value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
              }),
            ),
          ),
          groupBy: Type.Optional(Type.Array(Type.String())),
          aggregates: Type.Array(
            Type.Object({
              id: Type.String(),
              op: Type.String(),
              column: Type.Optional(Type.String()),
            }),
          ),
          sort: Type.Optional(
            Type.Array(
              Type.Object({
                column: Type.String(),
                direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
              }),
            ),
          ),
        }),
        missing: Type.Optional(
          Type.Union([Type.Literal("drop"), Type.Literal("keep"), Type.Literal("error")]),
        ),
      }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const store = requireStore(extras);
        const params = raw as {
          datasetRef: string;
          plan: AnalysisPlan;
          missing?: "drop" | "keep" | "error";
        };
        const ds = store.getDataset(String(params.datasetRef));
        const plan = params.plan;
        const allowedOps = new Set([
          "count",
          "sum",
          "mean",
          "median",
          "min",
          "max",
          "stddev",
          "nunique",
          "percent",
        ]);
        for (const a of plan.aggregates ?? []) {
          if (!allowedOps.has(a.op)) throw new Error(`Unsupported aggregate: ${a.op}`);
        }
        for (const f of (plan.filters ?? []) as FilterExpr[]) {
          const ops = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]);
          if (!ops.has(f.op)) throw new Error(`Unsupported filter op: ${f.op}`);
        }
        const run = runAnalysis(ds, plan, { missing: params.missing });
        store.putRun(run);
        const preview = run.resultSets.map((rs) => ({
          id: rs.id,
          columns: rs.columns,
          rowCount: rs.rows.length,
          preview: rs.rows.slice(0, 20).map((row, rowIdx) =>
            Object.fromEntries(
              rs.columns.map((c, i) => [
                c.name,
                {
                  value: row[i],
                  resultRef: resultRefFor(run.runId, rs.id, rowIdx, c.name),
                },
              ]),
            ),
          ),
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                runId: run.runId,
                status: run.status,
                provenance: run.provenance,
                warnings: run.warnings,
                resultSets: preview,
              }),
            },
          ],
          details: { runId: run.runId, effect: "analysis" },
        };
      },
    };

    const getTool: AgentTool = {
      name: "get_analysis_result",
      label: "Get Analysis Result",
      description: "Page through a completed analysis result set with resultRef per cell.",
      parameters: Type.Object({
        runId: Type.String(),
        resultSetId: Type.Optional(Type.String()),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const store = requireStore(extras);
        const params = raw as {
          runId: string;
          resultSetId?: string;
          offset?: number;
          limit?: number;
        };
        const run = store.getRun(String(params.runId));
        const rs =
          run.resultSets.find((r) => r.id === (params.resultSetId ?? "summary")) ??
          run.resultSets[0];
        if (!rs) throw new Error("No result set");
        const offset = Math.max(0, Math.floor(params.offset ?? 0));
        const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 50)));
        const slice = rs.rows.slice(offset, offset + limit);
        const rows = slice.map((row, i) =>
          Object.fromEntries(
            rs.columns.map((c, colIdx) => [
              c.name,
              {
                value: row[colIdx],
                valueType: typeof row[colIdx],
                resultRef: resultRefFor(run.runId, rs.id, offset + i, c.name),
              },
            ]),
          ),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                runId: run.runId,
                resultSetId: rs.id,
                offset,
                limit,
                totalRows: rs.rows.length,
                rows,
                provenance: run.provenance,
              }),
            },
          ],
          details: { runId: run.runId, effect: "read" },
        };
      },
    };

    const proposeFromResults: AgentTool = {
      name: "propose_block_edit_from_results",
      label: "Propose Edit From Results",
      description:
        "Fill a Markdown template with Host-resolved resultRef values and propose a block edit (no apply). Model must not hand-type computed numbers.",
      parameters: Type.Object({
        blockId: Type.String(),
        template: Type.String({
          description: "Markdown with {{token}} placeholders",
        }),
        bindings: Type.Array(
          Type.Object({
            token: Type.String(),
            resultRef: Type.String(),
            format: Type.Optional(
              Type.Object({
                decimals: Type.Optional(Type.Number()),
                percent: Type.Optional(Type.Boolean()),
                thousandsSeparator: Type.Optional(Type.Boolean()),
              }),
            ),
          }),
        ),
        rationale: Type.String(),
        risk: Type.Optional(
          Type.Union([
            Type.Literal("language"),
            Type.Literal("structure"),
            Type.Literal("argument"),
            Type.Literal("fact"),
          ]),
        ),
      }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const store = requireStore(extras);
        const blocks = ctx.getBlocks();
        const documentId = ctx.getDocumentId();
        if (!documentId || !blocks.length) {
          throw new Error("No document open. Call open_document first.");
        }
        const params = raw as {
          blockId: string;
          template: string;
          bindings: Array<{
            token: string;
            resultRef: string;
            format?: { decimals?: number; percent?: boolean; thousandsSeparator?: boolean };
          }>;
          rationale: string;
          risk?: RiskLevel;
        };
        const block = blocks.find((b) => b.id === params.blockId);
        if (!block) throw new Error(`Unknown blockId: ${params.blockId}`);
        if (block.kind === "table") {
          throw new Error("Full-table text replacement is forbidden; table results require a Host-backed cell proposal");
        }
        const scope = {
          ...ctx.proposeScope,
          gate: ctx.cascadeGate ?? ctx.proposeScope?.gate,
        };
        assertCanProposeBlock(params.blockId, scope);
        if (drafts.some((d) => d.blockId === params.blockId)) {
          throw new Error(`Already proposed for ${params.blockId}`);
        }
        let after = String(params.template ?? "");
        const rendered: Array<{ token: string; resultRef: string; renderedValue: string }> =
          [];
        const evidence: string[] = [];
        for (const b of params.bindings ?? []) {
          const { value, run } = store.resolveValue(b.resultRef);
          const renderedValue = formatResultValue(value, b.format);
          const token = b.token.replace(/^\{\{|\}\}$/g, "");
          const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(token)}\\s*\\}\\}`, "g");
          if (!pattern.test(after)) {
            throw new Error(`Template missing {{${token}}}`);
          }
          after = after.replace(pattern, () => renderedValue);
          rendered.push({ token, resultRef: b.resultRef, renderedValue });
          evidence.push(
            `${b.resultRef}=${JSON.stringify(value)}|shown=${renderedValue}|input=${run.provenance.inputHash}|plan=${run.provenance.normalizedPlanHash}`,
          );
        }
        if (/\{\{[^}]+\}\}/.test(after)) {
          throw new Error("Template still has unresolved {{tokens}}");
        }
        const rationale = String(params.rationale ?? "").trim();
        if (!rationale) throw new Error("rationale is empty");
        drafts.push({
          schemaVersion: 1,
          documentId,
          blockId: params.blockId,
          baseRevision: ctx.getRevision(),
          baseHash: block.contentHash,
          before: block.text,
          after,
          rationale,
          risk: params.risk ?? "fact",
          evidence,
        } satisfies Draft);
        noteCascadePropose(scope, params.blockId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                blockId: params.blockId,
                renderedBindings: rendered,
                evidenceRefs: evidence,
                proposalCount: drafts.length,
              }),
            },
          ],
          details: { blockId: params.blockId, effect: "draft" },
        };
      },
    };

    return [inspectTool, runTool, getTool, proposeFromResults];
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
