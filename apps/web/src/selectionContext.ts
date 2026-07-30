export const SELECTION_CONTEXT_MIN_CHARS = 1_000;
export const SELECTION_CONTEXT_MAX_CHARS = 100_000;

/** Character input -> API value. Blank follows the context tier; invalid -> undefined. */
export function selectionContextInputToChars(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const chars = Number(trimmed);
  if (
    !Number.isInteger(chars) ||
    chars < SELECTION_CONTEXT_MIN_CHARS ||
    chars > SELECTION_CONTEXT_MAX_CHARS
  ) {
    return undefined;
  }
  return chars;
}

/** Persisted cap -> number input text; undefined means follow the context tier. */
export function selectionContextCharsToInput(chars: number | undefined): string {
  return chars === undefined ? "" : String(chars);
}
