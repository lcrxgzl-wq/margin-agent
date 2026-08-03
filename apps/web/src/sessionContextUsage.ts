import type { SessionContextUsage } from "./api";

/** Refresh server-authoritative usage without letting a status read fail the completed action. */
export async function refreshSessionContextUsage(
  loadSession: () => Promise<{ context?: SessionContextUsage }>,
  setContextUsage: (usage: SessionContextUsage | null) => void,
): Promise<boolean> {
  try {
    const session = await loadSession();
    setContextUsage(session.context ?? null);
    return true;
  } catch {
    setContextUsage(null);
    return false;
  }
}
