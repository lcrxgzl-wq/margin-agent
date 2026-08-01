import type { ReviewChecklistItem, ReviewChecklistRun } from "@margin/domain";
import type { ReviewChecklistBundle } from "./api";

export const CITE_CHECK_DISCLOSURE =
  "形态学通过 ≠ 文献真实存在。此检查不验证文献真实性、存在性，也不验证引文是否支持正文主张。";
export const STYLE_LINT_DISCLOSURE = "词表启发，不是全面语体审校。";

export function fixedChecklistDisclosure(checker: ReviewChecklistRun["checker"]): string {
  return checker === "cite_check" ? CITE_CHECK_DISCLOSURE : STYLE_LINT_DISCLOSURE;
}

export function checklistOpenCount(runs: ReviewChecklistBundle[]): number {
  return runs.reduce(
    (total, entry) => total + entry.items.filter((item) => item.status === "open").length,
    0,
  );
}

export type ChecklistItemGroup = {
  issueType: string;
  label: string;
  blocks: Array<{ blockId: string; items: ReviewChecklistItem[] }>;
};

export function groupChecklistItems(items: ReviewChecklistItem[]): ChecklistItemGroup[] {
  const byIssue = new Map<string, ReviewChecklistItem[]>();
  for (const item of items) {
    const current = byIssue.get(item.issueType) ?? [];
    current.push(item);
    byIssue.set(item.issueType, current);
  }
  return [...byIssue.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([issueType, issueItems]) => {
      const byBlock = new Map<string, ReviewChecklistItem[]>();
      for (const item of issueItems) {
        const current = byBlock.get(item.blockId) ?? [];
        current.push(item);
        byBlock.set(item.blockId, current);
      }
      return {
        issueType,
        label: issueItems[0]?.label ?? issueType,
        blocks: [...byBlock.entries()].map(([blockId, blockItems]) => ({
          blockId,
          items: blockItems,
        })),
      };
    });
}

export function replaceChecklistRun(
  current: ReviewChecklistBundle[],
  next: ReviewChecklistBundle,
): ReviewChecklistBundle[] {
  const index = current.findIndex((entry) => entry.run.id === next.run.id);
  if (index < 0) return [...current, next];
  return current.map((entry, entryIndex) => entryIndex === index ? next : entry);
}
