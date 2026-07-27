import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getHarness, hasCapability } from "@margin/harness";
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

/** Assemble core and pack tools permitted by the active profile capabilities. */
export function assemblePaperTools(
  ctx: PaperToolContext,
  drafts: Draft[],
  comments: AgentComment[],
  opts?: { packId?: string; harnessId?: string; extras?: PackExtras },
): AgentTool[] {
  const profile = getHarness(opts?.harnessId);
  const inspectTools = new Set(["get_document_outline", "list_blocks", "get_block", "search_blocks"]);
  const proposeTools = new Set([
    "get_block",
    "offer_cascade",
    "propose_block_edit",
    "propose_table_cell_edit",
    "propose_block_comment",
    "finish_turn",
  ]);
  const coreTools = createCorePaperTools(ctx, drafts, comments).filter((tool) =>
    (hasCapability(profile, "document.inspect") && inspectTools.has(tool.name)) ||
    (hasCapability(profile, "document.propose") && proposeTools.has(tool.name)),
  );
  const finishTool = coreTools.find((tool) => tool.name === "finish_turn");
  const activeCoreTools = coreTools.filter((tool) => tool.name !== "finish_turn");

  // packId "none" disables all packs; otherwise filter packs by capabilities.
  const packs =
    opts?.packId === "none" || opts?.packId === ""
      ? []
      : opts?.packId === "data-analysis"
        ? [dataAnalysisPack]
        : opts?.packId === "academic"
          ? [academicPack]
          : ALL_PACKS;

  const packTools = packs.flatMap((pack) => {
    const enabled = pack.id === "academic"
      ? hasCapability(profile, "review.academic")
      : pack.id === "data-analysis" && hasCapability(profile, "analysis.tabular");
    return enabled ? pack.createTools(ctx, drafts, comments, opts?.extras) : [];
  });

  return [
    ...activeCoreTools,
    ...packTools,
    ...(finishTool ? [finishTool] : []),
  ];
}

export function getHeuristicComments(packId?: string, harnessId?: string) {
  if (packId === "none" || packId === "") return undefined;
  const pack = getPack(packId === "data-analysis" ? "academic" : packId);
  return hasCapability(getHarness(harnessId), "review.academic") && pack.toolProfile.length
    ? academicPack.heuristicComments
    : undefined;
}
