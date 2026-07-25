import { trimHistory, type ChatHistoryTurn } from "@margin/llm";

const MAX_TURNS = 12;

export type ChatMemoryTurn = ChatHistoryTurn & { threadId?: string };

/** In-process short memory for one localhost session. */
export class ChatMemory {
  private turns: ChatMemoryTurn[] = [];

  list(): ChatMemoryTurn[] {
    return [...this.turns];
  }

  /** Snapshot before appending the current user message. */
  prior(): ChatHistoryTurn[] {
    return trimHistory(this.turns, MAX_TURNS).map(({ role, text }) => ({ role, text }));
  }

  remember(role: "user" | "assistant", text: string, threadId?: string) {
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
        .filter((t) => (t.role === "user" || t.role === "assistant") && t.text?.trim())
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
