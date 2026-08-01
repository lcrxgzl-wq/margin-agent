import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  citeCheck,
  createReviewChecklistRun,
  heuristicComments,
  styleLint,
} from "../academic.js";
import { resolveBlockSnapshot } from "../pi-tools.js";
import type { MarginPack } from "./types.js";

export {
  CITE_CHECK_DISCLAIMER,
  STYLE_LINT_DISCLAIMER,
  citeCheck,
  createReviewChecklistRun,
  createReviewChecklistRuns,
  heuristicComments,
  styleLint,
} from "../academic.js";

export const academicPack: MarginPack = {
  id: "academic",
  toolProfile: ["cite_check", "style_lint"],
  createTools: (ctx) => {
    const requireBlocks = () => {
      const blocks = ctx.getBlocks();
      if (!ctx.getDocumentId() || !blocks.length) {
        throw new Error("No document open. Call open_document first.");
      }
      return blocks;
    };

    const citeTool: AgentTool = {
      name: "cite_check",
      label: "Cite Check",
      description:
        "Heuristic citation morphology check only. Does NOT verify literature existence or authenticity. Read-only.",
      parameters: Type.Object({
        blockId: Type.Optional(Type.String()),
      }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const blocks = requireBlocks();
        const params = raw as { blockId?: string };
        const subset = params.blockId
          ? [resolveBlockSnapshot(blocks, String(params.blockId)).block]
          : blocks;
        const result = citeCheck(subset);
        const checklist = createReviewChecklistRun("cite_check", ctx.getDocumentId(), subset);
        ctx.onReviewChecklistRun?.(checklist);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { count: result.findings.length, runId: checklist.run.id },
        };
      },
    };

    const styleTool: AgentTool = {
      name: "style_lint",
      label: "Style Lint",
      description: "Heuristic academic cliché / empty phrasing scan. Read-only.",
      parameters: Type.Object({
        blockId: Type.Optional(Type.String()),
      }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const blocks = requireBlocks();
        const params = raw as { blockId?: string };
        const subset = params.blockId
          ? [resolveBlockSnapshot(blocks, String(params.blockId)).block]
          : blocks;
        const result = styleLint(subset);
        const checklist = createReviewChecklistRun("style_lint", ctx.getDocumentId(), subset);
        ctx.onReviewChecklistRun?.(checklist);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { count: result.findings.length, runId: checklist.run.id },
        };
      },
    };

    return [citeTool, styleTool];
  },
  heuristicComments,
};
