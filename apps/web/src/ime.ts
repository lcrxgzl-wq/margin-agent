/**
 * IME composition guard for Enter-to-submit composers.
 *
 * Enter submits and Shift+Enter inserts a line break, but only while no IME
 * composition session is active — a composing Enter confirms the candidate
 * and must never submit chat or Quick Edit.
 */
export type SubmitEnterEvent = {
  key: string;
  shiftKey: boolean;
  /** Native KeyboardEvent.isComposing (true while the IME session is open). */
  isComposing?: boolean;
};

export function isSubmitEnter(event: SubmitEnterEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

/** Adapt a React keyboard event to the guard's shape. */
export function submitEnterFrom(
  event: Pick<React.KeyboardEvent, "key" | "shiftKey" | "nativeEvent">,
): boolean {
  return isSubmitEnter({
    key: event.key,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
  });
}
