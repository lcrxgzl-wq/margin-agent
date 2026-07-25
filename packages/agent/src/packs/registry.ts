import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getHarness } from "@margin/harness";
import { createCorePaperTools } from "../pi-tools.js";
import type { AgentComment } from "../types.js";
import { academicPack } from "./academic.js";
import { dataAnalysisPack } from "./data-analysis.js";
import type { MarginPack, PackExtras } from "./types.js";
import type { Draft, PaperToolContext } from "../pi-tools.js";

const nonePack: MarginPack = {
  id: "none",
  toolProfile: [],
  createTools: () => [],
};

const ALL_PACKS: MarginPack[] = [academicPack, dataAnalysisPack];

export function getPack(id?: string): MarginPack {
  if (!id) return id === "" ? nonePack : academicPack;
  if (id === "none" || id === "") return nonePack;
  if (id === "data-analysis") return dataAnalysisPack;
  return academicPack;
}

/** Assemble core + all packs whose tools appear in the harness toolProfile. */
export function assemblePaperTools(
  ctx: PaperToolContext,
  drafts: Draft[],
  comments: AgentComment[],
  opts?: { packId?: string; harnessId?: string; extras?: PackExtras },
): AgentTool[] {
  const enabled = new Set(getHarness(opts?.harnessId).toolProfile);
  const coreTools = createCorePaperTools(ctx, drafts, comments);
  const finishTool = coreTools.pop();

  // packId "none" disables all packs; otherwise merge packs filtered by toolProfile.
  const packs =
    opts?.packId === "none" || opts?.packId === ""
      ? []
      : opts?.packId === "data-analysis"
        ? [dataAnalysisPack]
        : opts?.packId === "academic"
          ? [academicPack]
          : ALL_PACKS;

  const packTools = packs.flatMap((pack) =>
    pack.createTools(ctx, drafts, comments, opts?.extras).filter((tool) => enabled.has(tool.name)),
  );

  return [
    ...coreTools,
    ...packTools,
    ...(finishTool ? [finishTool] : []),
  ];
}

export function getHeuristicComments(packId?: string, harnessId?: string) {
  if (packId === "none" || packId === "") return undefined;
  const pack = getPack(packId === "data-analysis" ? "academic" : packId);
  const enabled = new Set(getHarness(harnessId).toolProfile);
  return pack.toolProfile.some((name) => enabled.has(name))
    ? academicPack.heuristicComments
    : undefined;
}
