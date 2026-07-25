export type AttentionMode = "global" | "selection" | "mixed";

export type AttentionInput = {
  hasSelection: boolean;
  selectionBlockCount: number;
  sourceCount: number;
};

export function attentionMode(input: AttentionInput): AttentionMode {
  if (!input.hasSelection) return "global";
  return input.sourceCount > 0 ? "mixed" : "selection";
}

export const ATTENTION_COPY: Record<AttentionMode, { label: string; hint: string }> = {
  global: { label: "全文", hint: "Agent 通读全文与大纲" },
  selection: { label: "焦点 · 选区", hint: "优先看选区，全文按需读取" },
  mixed: { label: "焦点 · 选区 + 资料", hint: "选区优先，资料与全文按需读取" },
};
