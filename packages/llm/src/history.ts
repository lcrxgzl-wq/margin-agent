export type ChatHistoryTurn = {
  role: "user" | "assistant";
  text: string;
};

const DEFAULT_MAX = 12;

/** Keep the last N turns (user+assistant pairs count toward the cap). */
export function trimHistory<T extends { text: string }>(
  turns: T[],
  maxTurns = DEFAULT_MAX,
): T[] {
  if (turns.length <= maxTurns) return turns;
  return turns.slice(-maxTurns);
}

/** Compact transcript for LLM prompts. */
export function formatHistoryForPrompt(
  turns: ChatHistoryTurn[],
  maxTurns = DEFAULT_MAX,
): string {
  const kept = trimHistory(turns, maxTurns);
  if (!kept.length) return "";
  return kept
    .map((t) => `${t.role === "user" ? "用户" : "助手"}: ${t.text.slice(0, 400)}`)
    .join("\n");
}
