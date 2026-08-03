import type { BlockSnapshot } from "@margin/domain";

export const MAX_CASCADE_CANDIDATES = 5;
export const MAX_CASCADE_PROPOSALS_PER_TURN = 3;

export type CascadeCandidate = {
  blockId: string;
  reason: string;
  query?: string;
};

/** Per-turn scout state for cascade consistency. */
export type CascadeGate = {
  outlineCalled: boolean;
  searchCalled: boolean;
  offered: CascadeCandidate[];
  /** Proposals already made outside primary/selection this turn. */
  cascadeProposeCount: number;
};

export function createCascadeGate(): CascadeGate {
  return {
    outlineCalled: false,
    searchCalled: false,
    offered: [],
    cascadeProposeCount: 0,
  };
}

export type ProposeScope = {
  /** Scan: only these ids are primary targets. */
  primaryAllowlist?: string[];
  /** Session: user selection — always propose-ok. */
  selectionBlockIds?: string[];
  /** User-confirmed cascade targets. */
  cascadeConfirmedIds?: string[];
  /** When true (session with selection or after offer), gate out-of-scope proposes. */
  enforceCascadeGate?: boolean;
  /** User already confirmed cascade this thread — skip re-scout for confirmed ids. */
  cascadeUnlocked?: boolean;
  gate?: CascadeGate;
  /** Fit-first document injection mode; full skips outline/search scout ceremony. */
  documentMode?: "full" | "lean";
};

export function isPrimaryProposeTarget(blockId: string, scope: ProposeScope): boolean {
  const primary = scope.primaryAllowlist;
  if (primary?.length) return primary.includes(blockId);
  const selection = scope.selectionBlockIds ?? [];
  if (selection.length) return selection.includes(blockId);
  // No selection / no primary list → treat as unrestricted primary.
  return !scope.enforceCascadeGate || !(scope.cascadeConfirmedIds?.length);
}

/**
 * Host gate: primary/selection ok; out-of-scope needs cascadeConfirmedIds
 * (and outline+search scout when not in full documentMode).
 */
export function assertCanProposeBlock(blockId: string, scope: ProposeScope): void {
  if (isPrimaryProposeTarget(blockId, scope)) return;

  if (!scope.enforceCascadeGate && !scope.primaryAllowlist?.length) {
    return;
  }

  const gate = scope.gate;
  const confirmed = new Set(scope.cascadeConfirmedIds ?? []);
  const fullMode = scope.documentMode === "full";

  if (!confirmed.has(blockId)) {
    throw new Error(
      fullMode
        ? `选区外提案被拒绝（${blockId}）。请用 offer_cascade 列出相关段，等用户确认「一并改」后再对该 blockId 调用 propose_*。`
        : `选区外提案被拒绝（${blockId}）。请先 get_document_outline + search_blocks，用 offer_cascade 列出相关段，等用户确认「一并改」后再对该 blockId 调用 propose_*。`,
    );
  }
  if (!scope.cascadeUnlocked && !fullMode && (!gate?.outlineCalled || !gate?.searchCalled)) {
    throw new Error(
      `联动提案前须先调用 get_document_outline 与 search_blocks（${blockId}）。`,
    );
  }
  if ((gate?.cascadeProposeCount ?? 0) >= MAX_CASCADE_PROPOSALS_PER_TURN) {
    throw new Error(
      `本轮联动提案已达上限 ${MAX_CASCADE_PROPOSALS_PER_TURN}；其余相关段请下一轮再提。`,
    );
  }
}

export function noteCascadePropose(scope: ProposeScope, blockId: string): void {
  if (isPrimaryProposeTarget(blockId, scope)) return;
  if (scope.gate) scope.gate.cascadeProposeCount += 1;
}

export function normalizeCascadeOffer(
  raw: unknown,
  blocks: BlockSnapshot[],
): CascadeCandidate[] {
  const byId = new Set(blocks.map((b) => b.id));
  if (!Array.isArray(raw)) return [];
  const out: CascadeCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { blockId?: unknown; reason?: unknown; query?: unknown };
    const blockId = String(row.blockId ?? "").trim();
    const reason = String(row.reason ?? "").trim();
    if (!blockId || !reason || !byId.has(blockId)) continue;
    if (out.some((c) => c.blockId === blockId)) continue;
    out.push({
      blockId,
      reason: reason.slice(0, 200),
      query: row.query != null ? String(row.query).slice(0, 80) : undefined,
    });
    if (out.length >= MAX_CASCADE_CANDIDATES) break;
  }
  return out;
}

/** Compact outline for prompt injection (titles only). maxHeadings 0 = unlimited. */
export function formatOutlineHint(blocks: BlockSnapshot[], maxHeadings = 24): string {
  const sorted = [...blocks]
    .filter((b) => b.kind === "heading")
    .sort((a, c) => a.order - c.order);
  const headings = maxHeadings > 0 ? sorted.slice(0, maxHeadings) : sorted;
  if (!headings.length) return "";
  const lines = headings.map((b) => {
    const m = /^(#{1,6})\s+(.*)$/s.exec(b.text);
    const level = m?.[1].length ?? 1;
    const title = (m?.[2] ?? b.text).trim().slice(0, 60);
    return `${"  ".repeat(Math.max(0, level - 1))}- ${title} (${b.id})`;
  });
  return `\n大纲（仅标题）：\n${lines.join("\n")}`;
}
