import { trimHistory, type ChatHistoryTurn } from "@margin/llm";

const MAX_TURNS = 12;

export type ChatMemoryTurn = {
  /** "system" turns are UI-visible host notes; never sent to the LLM. */
  role: "user" | "assistant" | "system";
  text: string;
  threadId?: string;
};

/** In-process short memory for one localhost session. */
export class ChatMemory {
  private turns: ChatMemoryTurn[] = [];

  list(): ChatMemoryTurn[] {
    return [...this.turns];
  }

  /** Snapshot before appending the current user message. */
  prior(): ChatHistoryTurn[] {
    const llmTurns = this.turns.flatMap((turn) =>
      turn.role === "system" ? [] : [{ role: turn.role, text: turn.text }],
    );
    return trimHistory(llmTurns, MAX_TURNS).map(({ role, text }) => ({ role, text }));
  }

  remember(role: "user" | "assistant" | "system", text: string, threadId?: string) {
    const t = text.trim();
    if (!t) return;
    this.turns = trimHistory([
      ...this.turns,
      { role, text: t, ...(threadId ? { threadId } : {}) },
    ], MAX_TURNS);
  }

  /** Replace in-memory turns (e.g. hydrate from disk). */
  hydrate(turns: ChatMemoryTurn[]) {
    this.turns = trimHistory(
      turns
        .filter((t) => (t.role === "user" || t.role === "assistant" || t.role === "system") && t.text?.trim())
        .map((t) => ({
          role: t.role,
          text: t.text.trim(),
          ...(t.threadId ? { threadId: t.threadId } : {}),
        })),
      MAX_TURNS,
    );
  }

  clear() {
    this.turns = [];
  }
}
