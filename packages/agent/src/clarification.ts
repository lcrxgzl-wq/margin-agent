import { getHarness } from "@margin/harness";

/** Max clarification turns per rewrite/edit thread before the agent must propose. */
export const MAX_CLARIFICATION_ROUNDS = 3;

/** User asked to rewrite/edit manuscript content (or is mid-clarification answer). */
export function isEditOrRewriteIntent(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  if (/改吧|可以改了|直接改|按这个改|退出追问/.test(t)) return true;
  return /重写|改写|改一下|修改|编辑|润色|收紧|扩写|压缩|替换|删掉|删去|加上|补上|把这段|这段|选区|修订|更学术|更清楚|更克制|改得|写得|语气|措辞|论证/.test(
    t,
  );
}

export function clampClarificationRound(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_CLARIFICATION_ROUNDS, Math.floor(n));
}

/**
 * After a turn: proposals reset the thread; otherwise edit/socratic threads advance
 * the clarification counter (capped at MAX).
 */
export function nextClarificationRound(input: {
  previous: number;
  message: string;
  proposalCount: number;
  chatMode?: "direct" | "socratic";
}): number {
  if (input.proposalCount > 0) return 0;
  const prev = clampClarificationRound(input.previous);
  const inThread =
    prev > 0 ||
    input.chatMode === "socratic" ||
    isEditOrRewriteIntent(input.message);
  if (!inThread) return 0;
  return clampClarificationRound(prev + 1);
}

/** Host-injected prompt appendix: collaboration clarify with hard budget. */
export function buildClarificationHint(input: {
  clarificationRound: number;
  chatMode?: "direct" | "socratic";
  maxRounds?: number;
  harnessId?: string;
}): string {
  const max = input.maxRounds ?? MAX_CLARIFICATION_ROUNDS;
  const used = clampClarificationRound(input.clarificationRound);
  const remaining = Math.max(0, max - used);
  // socratic-revision-zh is loadable on skillScope "all" (academic profile).
  const socraticPointer =
    getHarness(input.harnessId).skills.scope === "all"
      ? `可 load_skill("socratic-revision-zh").`
      : "";

  if (used >= max) {
    return `\n\n[澄清预算已用尽 ${used}/${max}] 禁止再追问。基于已有信息与合理假设立即调用 propose_*（或明确说明无法改的原因）；回复中用一句话交代假设。${socraticPointer}`;
  }

  const budget = `澄清预算 ${used}/${max}（本线程还可追问 ${remaining} 轮）。`;

  if (input.chatMode === "socratic") {
    return `\n\n[模式=苏格拉底追问] ${budget} 先提 1–2 个尖锐问题澄清目标/证据/限定；用户说「改吧/可以改了/直接改」或预算将尽时收敛并提案。禁止空泛追问与无限循环。${socraticPointer}`;
  }

  return `\n\n[协作澄清] ${budget} 用户要求重写/编辑时：若指令过模糊、无法得到可验收结果，可先问 1–2 个尖锐问题；够具体则直接 propose_*。禁止无限追问；预算用尽必须提案。${socraticPointer}`;
}
