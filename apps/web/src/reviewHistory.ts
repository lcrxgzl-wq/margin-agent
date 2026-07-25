import type { TimelineEntry } from "./api";

export type HistoryFilter = "all" | "accepted" | "rejected";

export const historyFilters: Array<{ id: HistoryFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "accepted", label: "已接受" },
  { id: "rejected", label: "已拒绝" },
];

const EXCERPT_MAX = 48;

const operationLabels: Record<string, string> = {
  translate: "翻译",
  polish: "润色",
  rewrite: "改写",
  table_cell: "表格",
};

export function operationLabel(kind: string | null): string {
  if (!kind) return "提案";
  return operationLabels[kind] ?? kind;
}

function decisionLabel(entry: TimelineEntry): string {
  if (!entry.ok && entry.reason !== "rejected") {
    return `应用失败（${entry.reason ?? "未知原因"}）`;
  }
  if (entry.decisionKind === "Y") return "Y 接受";
  if (entry.decisionKind === "N") return "N 拒绝";
  if (entry.decisionKind === "E") return "E 编辑后接受";
  return entry.decisionKind || "未知";
}

/** Collapse whitespace and truncate a before/after fragment for the history list. */
export function excerpt(text: string | null, max = EXCERPT_MAX): string | null {
  if (text == null) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "（空）";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export type HistoryEntryView = {
  /** e.g. "翻译 → E 编辑后接受" */
  action: string;
  accepted: boolean;
  beforeExcerpt: string | null;
  afterExcerpt: string | null;
};

export function historyEntryView(entry: TimelineEntry): HistoryEntryView {
  return {
    action: `${operationLabel(entry.operationKind)} → ${decisionLabel(entry)}`,
    accepted: entry.ok,
    beforeExcerpt: excerpt(entry.beforeText),
    afterExcerpt: excerpt(entry.afterText),
  };
}

export function filterTimeline(entries: TimelineEntry[], filter: HistoryFilter): TimelineEntry[] {
  if (filter === "accepted") return entries.filter((entry) => entry.ok);
  if (filter === "rejected") {
    return entries.filter((entry) => !entry.ok && entry.reason === "rejected");
  }
  return entries;
}
