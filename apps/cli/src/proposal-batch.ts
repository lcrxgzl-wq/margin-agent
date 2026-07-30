import type { BlockSnapshot, Decision, DocumentMeta, Proposal } from "@margin/domain";
import {
  applyApproved,
  getDocument,
  getLatestDecision,
  getLatestProposalApplyEvent,
  getProposal,
  listBlocks,
  completeProposalResolutionBatch,
  reopenProposalResolutionBatch,
  saveProposalResolutionBatch,
  type Workspace,
} from "@margin/storage-local";

export type ResolveProposalsInput = {
  proposalIds: string[];
  expectedRevision: number;
  expectedHash: string;
};

type ResolveProposalsSuccess = {
  ok: true;
  document: DocumentMeta;
  blocks: BlockSnapshot[];
  proposals: Proposal[];
  decisions: Decision[];
  replayed?: true;
};

export type ResolveProposalsResult =
  | ResolveProposalsSuccess
  | { ok: false; reason: string };

/** Check a stale canvas request before it can mutate the active agent session. */
export function isActiveDocumentRequest(
  activeDocumentId: string | undefined,
  requestedDocumentId: string,
): boolean {
  return activeDocumentId === requestedDocumentId;
}

export function parseResolveProposalsInput(value: unknown): ResolveProposalsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.proposalIds) || body.proposalIds.length < 1 || body.proposalIds.length > 100) {
    throw new Error("proposalIds must contain 1 to 100 ids");
  }
  const proposalIds = body.proposalIds;
  if (proposalIds.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim())) {
    throw new Error("proposalIds must contain non-empty trimmed strings");
  }
  if (new Set(proposalIds).size !== proposalIds.length) {
    throw new Error("proposalIds must be unique");
  }
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
    throw new Error("expectedRevision must be a non-negative integer");
  }
  if (typeof body.expectedHash !== "string" || !/^[a-f0-9]{16}$/.test(body.expectedHash)) {
    throw new Error("expectedHash must be a 16-character content hash");
  }
  return {
    proposalIds: proposalIds as string[],
    expectedRevision: body.expectedRevision as number,
    expectedHash: body.expectedHash,
  };
}

export async function resolveProposalsAtomically(
  workspace: Workspace,
  documentId: string,
  input: ResolveProposalsInput,
): Promise<ResolveProposalsResult> {
  getDocument(workspace, documentId);
  const proposals = input.proposalIds.map((id) => getProposal(workspace, id));
  if (proposals.some((proposal) => proposal.documentId !== documentId)) {
    return { ok: false, reason: "document_mismatch" };
  }

  if (proposals.every((proposal) => proposal.status !== "proposed")) {
    const decisions: Decision[] = [];
    const replayable = proposals.every((proposal) => {
      const decision = getLatestDecision(workspace, proposal.id);
      const event = getLatestProposalApplyEvent(workspace, proposal.id);
      if (decision?.kind !== "Y" || !event?.ok || event.decisionId !== decision.id) return false;
      decisions.push(decision);
      return true;
    });
    if (replayable) {
      return {
        ok: true,
        document: getDocument(workspace, documentId),
        blocks: listBlocks(workspace, documentId),
        proposals,
        decisions,
        replayed: true,
      };
    }
  }

  const unavailable = proposals.find((proposal) => proposal.status !== "proposed");
  if (unavailable) {
    return {
      ok: false,
      reason: unavailable.status === "decided" ? "proposal_resolving" : "proposal_already_resolved",
    };
  }

  const { batch, decisions } = saveProposalResolutionBatch(
    workspace,
    documentId,
    input.proposalIds,
    input.expectedRevision,
    input.expectedHash,
  );
  let result: Awaited<ReturnType<typeof applyApproved>>;
  try {
    result = await applyApproved(
      workspace,
      documentId,
      input.expectedRevision,
      input.expectedHash,
      input.proposalIds,
      { requireAll: true },
    );
  } catch (error) {
    reopenProposalResolutionBatch(workspace, batch.id);
    throw error;
  }
  if (!result.ok) {
    reopenProposalResolutionBatch(workspace, batch.id);
    return result;
  }
  completeProposalResolutionBatch(workspace, batch.id);
  return { ...result, proposals, decisions };
}
