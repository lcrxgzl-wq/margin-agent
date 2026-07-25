import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { citeCheck, heuristicComments, styleLint } from "../academic.js";
import type { MarginPack } from "./types.js";

export { citeCheck, heuristicComments, styleLint } from "../academic.js";

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
        const subset = params.blockId ? blocks.filter((b) => b.id === params.blockId) : blocks;
        if (params.blockId && !subset.length) {
          throw new Error(`Unknown blockId: ${params.blockId}`);
        }
        const result = citeCheck(subset);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { count: result.findings.length },
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
        const subset = params.blockId ? blocks.filter((b) => b.id === params.blockId) : blocks;
        if (params.blockId && !subset.length) {
          throw new Error(`Unknown blockId: ${params.blockId}`);
        }
        const result = styleLint(subset);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { count: result.findings.length },
        };
      },
    };

    return [citeTool, styleTool];
  },
  heuristicComments,
};
