import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BlockSnapshot } from "@margin/domain";

export type DocumentMode = "full" | "lean";
export type DocumentContextTier = "eco" | "standard" | "max";

/** Marker pair for the single authoritative full-document injection slot. */
export const DOCUMENT_FULL_BEGIN = "[Margin 文稿全文";
export const DOCUMENT_FULL_END = "[/Margin 文稿全文]";
export const DOCUMENT_FULL_REMOVED_PLACEHOLDER =
  "[Margin 文稿全文已移除；以本轮注入为准]";

const DOCUMENT_FULL_BLOCK_RE =
  /\[Margin 文稿全文[^\]]*\][\s\S]*?\[\/Margin 文稿全文\]/g;

/** Compaction-style reserve; keep aligned with pi compaction defaults. */
export const DOCUMENT_CONTEXT_RESERVE_TOKENS = 16_384;
export const DOCUMENT_CONTEXT_OUTPUT_RESERVE_TOKENS = 8_192;

export type ResolveDocumentModeInput = {
  tier: DocumentContextTier;
  /** Model context window in tokens; missing/non-positive forces lean. */
  contextWindow: number;
  /** Conservative char≈token size of the candidate full-document injection. */
  documentInjectionChars: number;
  /** Remaining transcript size after stale full-doc copies were stripped. */
  transcriptChars: number;
  /** Session hysteresis after an overflow demotion. */
  leanLocked: boolean;
  /** Current-turn non-document prompt chars (message, selection, hints). */
  turnOverheadChars?: number;
  reserveTokens?: number;
  outputReserveTokens?: number;
};

/**
 * Fit-first: eco and overflow locks stay lean; otherwise inject full text when
 * the conservative char≈token budget still has room.
 */
export function resolveDocumentMode(input: ResolveDocumentModeInput): DocumentMode {
  if (input.tier === "eco" || input.leanLocked) return "lean";
  if (!(input.contextWindow > 0) || input.documentInjectionChars <= 0) return "lean";
  const reserve = input.reserveTokens ?? DOCUMENT_CONTEXT_RESERVE_TOKENS;
  const outputReserve = input.outputReserveTokens ?? DOCUMENT_CONTEXT_OUTPUT_RESERVE_TOKENS;
  const available = input.contextWindow - reserve - outputReserve - Math.max(0, input.transcriptChars) - Math.max(0, input.turnOverheadChars ?? 0);
  if (available < 4_000) return "lean";
  return input.documentInjectionChars <= available ? "full" : "lean";
}

/** Ordered full-document injection with stable block ids for propose_*. */
export function buildFullDocumentInjection(input: {
  blocks: BlockSnapshot[];
  revision: number;
  relativePath?: string;
}): string {
  if (!input.blocks.length) return "";
  const ordered = [...input.blocks].sort((left, right) => left.order - right.order);
  const path = input.relativePath?.trim() || "";
  const header =
    `${DOCUMENT_FULL_BEGIN} revision=${input.revision}` +
    (path ? ` path=${path}` : "") +
    ` blocks=${ordered.length}]`;
  const body = ordered
    .map((block) => `### ${block.id} (${block.kind})\n${block.text}`)
    .join("\n\n");
  return `\n\n${header}\n${body}\n${DOCUMENT_FULL_END}`;
}

export function messageTextChars(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const row = part as { type?: string; text?: unknown };
    if (row.type === "text" && typeof row.text === "string") total += row.text.length;
  }
  return total;
}

export function estimateTranscriptChars(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTextChars(message), 0);
}

function stripDocumentInjectionFromText(text: string): string {
  const stripped = text.replace(DOCUMENT_FULL_BLOCK_RE, DOCUMENT_FULL_REMOVED_PLACEHOLDER);
  return stripped.replace(
    /(\[Margin 文稿全文已移除；以本轮注入为准\]\s*){2,}/g,
    `${DOCUMENT_FULL_REMOVED_PLACEHOLDER}\n`,
  );
}

/** Remove prior full-document copies so only this turn's rebuilt injection remains. */
export function stripDocumentInjections(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      const next = stripDocumentInjectionFromText(content);
      return next === content ? message : { ...message, content: next } as AgentMessage;
    }
    if (!Array.isArray(content)) return message;
    let changed = false;
    const nextContent = content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const row = part as { type?: string; text?: unknown };
      if (row.type !== "text" || typeof row.text !== "string") return part;
      const nextText = stripDocumentInjectionFromText(row.text);
      if (nextText === row.text) return part;
      changed = true;
      return { ...row, text: nextText };
    });
    return changed ? { ...message, content: nextContent } as AgentMessage : message;
  });
}

export function documentModeNote(mode: DocumentMode): string {
  return `documentMode: ${mode}`;
}

export function documentModeOverflowDemotionNote(): string {
  return "documentMode demoted to lean after overflow";
}

export function documentModeSwitchDemotionNote(): string {
  return "documentMode demoted to lean after mid-turn document switch";
}

export function hadContextOverflow(notes: readonly string[]): boolean {
  return notes.some((note) => /context overflow/i.test(note));
}
