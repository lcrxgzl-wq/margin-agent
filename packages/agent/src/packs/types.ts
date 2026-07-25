import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Draft, PaperToolContext } from "../pi-tools.js";
import type { AgentComment } from "../types.js";
import type { AnalysisRunStore } from "../data/store.js";

export type PackExtras = {
  readText?: (relativePath: string) => Promise<{
    relativePath: string;
    text: string;
    bytes: number;
  }> | {
    relativePath: string;
    text: string;
    bytes: number;
  };
  analysisStore?: AnalysisRunStore;
};

export type MarginPack = {
  id: string;
  toolProfile: string[];
  createTools: (
    ctx: PaperToolContext,
    drafts: Draft[],
    comments: AgentComment[],
    extras?: PackExtras,
  ) => AgentTool[];
  heuristicComments?: typeof import("../academic.js").heuristicComments;
};
