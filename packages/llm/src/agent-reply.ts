import type { ChatHistoryTurn } from "./history.js";
import { formatHistoryForPrompt, trimHistory } from "./history.js";

export type AgentReplyInput = {
  message: string;
  excerpt?: string;
  outlineHint?: string;
  history?: ChatHistoryTurn[];
  hasDocument?: boolean;
};

/** Offline agent voice — conversation first, not a command menu. */
export function mockAgentReply(input: AgentReplyInput): string {
  const msg = input.message.trim();
  const excerpt = (input.excerpt ?? "").trim();
  const prior = trimHistory(input.history ?? []);
  const lastUser = [...prior].reverse().find((t) => t.role === "user")?.text;

  if (/^(你是谁|你是什麼|你是什么|介绍一下你自己|who are you|what are you)/i.test(msg)) {
    return "我是 Margin：本机学术写作 Agent。打开文稿、讨论论证、提出可 Accept/Undo 的段级修订——定稿权在你。说「打开样章」或文件名即可。";
  }

  if (/^(你好|您好|嗨|哈喽|hello|hi)\b/i.test(msg)) {
    return "在。打开一篇稿，还是先聊论证？";
  }

  if (/^(谢谢|多谢|感谢)/i.test(msg)) {
    return "好。还有要改的段落或想继续讨论的点，随时说。";
  }

  const wantsPaperTalk =
    !!excerpt ||
    /讨论|论证|文献|问题意识|理论|材料|重写|润色|改写|审稿|段落|这段|这一段/i.test(msg);

  if (wantsPaperTalk) {
    const head = excerpt
      ? `关于「${excerpt.slice(0, 100)}${excerpt.length > 100 ? "…" : ""}」：`
      : lastUser
        ? `结合刚才你提到的「${lastUser.slice(0, 60)}${lastUser.length > 60 ? "…" : ""}」：`
        : "可以这么看：";
    return `${head}

1) 问题意识有没有落到可观察的现象，而不是停在口号。
2) 文献是在对话，还是只在点名——相对既有研究推进了哪一步。
3) 材料与理论之间有没有跳跃；缺证据就先标风险，不要编造引语或文献。

${input.hasDocument ? "若要我动笔，选中一段说「重写」。" : "若要对着正文改，先打开一篇文稿即可。"}`;
  }

  if (lastUser) {
    return `我接着你刚才说的「${lastUser.slice(0, 72)}${lastUser.length > 72 ? "…" : ""}」听。\n\n你可以直接问我思路、让我读某个文件，或打开一篇文稿开始修订。`;
  }

  return "可以。把你想做的事用自然语言说就行——例如打开某篇文稿、读取一个文件、或先讨论问题意识。";
}

export function buildAgentUserPrompt(input: AgentReplyInput): string {
  const historyBlock = formatHistoryForPrompt(input.history ?? []);
  return `${historyBlock ? `对话历史：\n${historyBlock}\n\n` : ""}用户：
"""
${input.message}
"""
${input.excerpt?.trim() ? `选区：\n"""\n${input.excerpt.trim()}\n"""\n` : ""}${
    input.outlineHint ? `当前文稿标题线索：${input.outlineHint}\n` : ""
  }${input.hasDocument ? "（已打开文稿）" : "（尚未打开文稿）"}
请回复。`;
}

/** @deprecated Prefer harness.systemPrompt; kept for any external callers. */
export function agentSystemPrompt(): string {
  return `你是 Margin：本地学术写作 Agent。短中文；文稿操作须经工具；只提案不 apply；不得虚构文献或访谈引语。`;
}
