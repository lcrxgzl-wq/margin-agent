/** Retry settings: attempts are total provider attempts; delay is edited in seconds. */
export const AGENT_RETRY_ATTEMPTS_DEFAULT = 5;
export const AGENT_RETRY_ATTEMPTS_MIN = 1;
export const AGENT_RETRY_ATTEMPTS_MAX = 10;
export const AGENT_RETRY_DELAY_DEFAULT_SECONDS = 30;
export const AGENT_RETRY_DELAY_MIN_SECONDS = 0;
export const AGENT_RETRY_DELAY_MAX_SECONDS = 300;

export function retryAttemptsFromInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const attempts = Number(trimmed);
  if (
    !Number.isInteger(attempts) ||
    attempts < AGENT_RETRY_ATTEMPTS_MIN ||
    attempts > AGENT_RETRY_ATTEMPTS_MAX
  ) return undefined;
  return attempts;
}

export function retryAttemptsToInput(attempts: number | undefined): string {
  return attempts === undefined ? "" : String(attempts);
}

export function retryDelaySecondsToMs(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (
    !Number.isInteger(seconds) ||
    seconds < AGENT_RETRY_DELAY_MIN_SECONDS ||
    seconds > AGENT_RETRY_DELAY_MAX_SECONDS
  ) return undefined;
  return seconds * 1_000;
}

export function retryDelayMsToSeconds(ms: number | undefined): string {
  return ms === undefined ? "" : String(Math.round(ms / 1_000));
}
