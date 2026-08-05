import type { ProposalOperationKind, ProposalTargetLanguage } from "@margin/domain";

export type SelectionEditIntent = {
  operation: ProposalOperationKind;
  instruction: string;
  targetLanguage?: ProposalTargetLanguage;
};

export function inferTranslationTarget(selectionText: string): ProposalTargetLanguage {
  const cjk = (selectionText.match(/[\u3400-\u9fff]/g) ?? []).length;
  const letters = (selectionText.match(/[A-Za-z]/g) ?? []).length;
  return cjk > letters * 0.35 ? "en" : "zh-CN";
}

export function translationIntent(
  selectionText: string,
  targetLanguage = inferTranslationTarget(selectionText),
): SelectionEditIntent {
  return targetLanguage === "en"
    ? {
        operation: "translate",
        targetLanguage,
        instruction: "将所选文本翻译成规范英语，准确保留术语、引文、数字和事实，不新增内容。",
      }
    : {
        operation: "translate",
        targetLanguage,
        instruction: "将所选文本翻译成简体中文，准确保留术语、引文、数字和事实，不新增内容。",
      };
}

export const polishIntent: SelectionEditIntent = {
  operation: "polish",
  instruction: "润色所选文本，使表达准确、清楚、克制；保持原意、事实和引文，不新增证据。",
};

export function selectionEditIntent(text: string, selectionText = ""): SelectionEditIntent | null {
  const value = text.trim();
  if (!value || value.length > 240) return null;

  if (/^(?:请)?(?:翻译|翻成|译成|translate)(?:为|成|to)?\s*(?:简体中文|中文|汉语)?(?:这段|选区|文字)?[。！!]?$/i.test(value)) {
    return translationIntent(selectionText, /简体中文|中文|汉语/i.test(value) ? "zh-CN" : undefined);
  }
  if (/^(?:请)?(?:翻译|翻成|译成|translate)(?:为|成|to)?\s*(?:英文|英语|english)(?:这段|选区|文字)?[。！!]?$/i.test(value)) {
    return translationIntent(selectionText, "en");
  }
  if (/^(?:请)?(?:润色|polish)(?:一下|这段|选区|文字)?[。！!]?$/i.test(value)) {
    return polishIntent;
  }
  if (/^(?:请)?(?:重写|改写|精简|压缩|扩写)(?:一下|这段|选区|文字)?[。！!]?$/i.test(value)) {
    return {
      operation: "rewrite",
      instruction: `${value.replace(/[。！!]$/, "")}；只处理所选文本，保持事实、引文和未选中文字不变。`,
    };
  }
  if (/^(?:重写|改写|润色|精简|压缩|扩写)\s*[：:].+/i.test(value)) {
    return {
      operation: /^润色/.test(value) ? "polish" : "rewrite",
      instruction: `${value}；只处理所选文本，保持事实、引文和未选中文字不变。`,
    };
  }
  return null;
}
