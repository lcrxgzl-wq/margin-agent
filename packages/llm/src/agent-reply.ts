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
    return "我是 Margin：帮你改文稿。对选区提提案，你接受或拒绝后才写入。可以说「打开样章」或文件名。";
  }

  if (/^(你好|您好|嗨|哈喽|hello|hi)\b/i.test(msg)) {
    return "你好。我是 Margin：本地文档修订 Agent。打开一篇稿，或直接说想改什么。";
  }

  if (/^(谢谢|多谢|感谢)/i.test(msg)) {
    return "好。还有要改的段落或想继续讨论的点，随时说。";
  }

  const wantsAcademicTalk =
    /讨论|论证|文献|问题意识|理论|材料|审稿/i.test(msg);
  const wantsEditTalk =
    !!excerpt ||
    /重写|润色|改写|段落|这段|这一段/i.test(msg);

  if (wantsAcademicTalk) {
    const head = excerpt
      ? `关于「${excerpt.slice(0, 100)}${excerpt.length > 100 ? "…" : ""}」：`
      : lastUser
        ? `结合刚才你提到的「${lastUser.slice(0, 60)}${lastUser.length > 60 ? "…" : ""}」：`
        : "可以这么看：";
    return `${head}

1) 主张是否落到可核对的事实或材料，而不是停在空话。
2) 依据是在支撑论证，还是只在点名。
3) 材料与推理之间有没有跳跃；缺证据就先标风险，不要编造。

${input.hasDocument ? "若要我动笔，选中一段说「重写」。" : "若要对着正文改，先打开一篇文稿即可。"}`;
  }

  if (wantsEditTalk) {
    const head = excerpt
      ? `关于「${excerpt.slice(0, 100)}${excerpt.length > 100 ? "…" : ""}」：`
      : "可以。";
    return `${head}

说清你想改的方向（更短、更清楚、更正式等），我会对选区提出修改提案，由你接受或拒绝后再写入。

${input.hasDocument ? "选中一段说「重写」即可。" : "先打开一篇文稿，再对着正文改。"}`;
  }

  if (lastUser) {
    return `我接着你刚才说的「${lastUser.slice(0, 72)}${lastUser.length > 72 ? "…" : ""}」听。\n\n你可以直接问我思路、让我读某个文件，或打开一篇文稿开始修订。`;
  }

  return "可以。我是 Margin：帮你改文稿。用自然语言说就行——例如打开某篇文稿、读取一个文件，或说明想怎么改。";
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

/** @deprecated Prefer the active AgentProfile instructions; kept for external callers. */
export function agentSystemPrompt(): string {
  return `你是 Margin：本地文档修订 Agent。短中文；文稿操作须经工具；只提案不 apply；不得虚构事实。`;
}
