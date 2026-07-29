/** Agent 请求超时输入换算：UI 用秒（10–600，留空 = 默认 120 秒），API 用毫秒。 */
export const AGENT_TIMEOUT_DEFAULT_SECONDS = 120;
export const AGENT_TIMEOUT_MIN_SECONDS = 10;
export const AGENT_TIMEOUT_MAX_SECONDS = 600;

/** Seconds input → ms for the API. Blank clears (null); invalid → undefined. */
export function agentTimeoutSecondsToMs(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (
    !Number.isInteger(seconds) ||
    seconds < AGENT_TIMEOUT_MIN_SECONDS ||
    seconds > AGENT_TIMEOUT_MAX_SECONDS
  ) {
    return undefined;
  }
  return seconds * 1000;
}

/** Persisted ms → seconds input text; undefined → "" (default). */
export function agentTimeoutMsToSeconds(ms: number | undefined): string {
  return ms === undefined ? "" : String(Math.round(ms / 1000));
}
