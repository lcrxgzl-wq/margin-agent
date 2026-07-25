import type { PiLoopOutcome, PiLoopResult } from "./pi-loop.js";

const FAILURE_LABELS: Record<Exclude<PiLoopOutcome, "completed">, string> = {
  aborted: "aborted",
  timed_out: "timed out",
  error: "failed",
};

export function assertPiLoopCompleted(
  result: Pick<PiLoopResult, "outcome" | "notes" | "errorMessage">,
  operation: string,
): void {
  if (result.outcome === "completed") return;

  const detail =
    result.notes[result.notes.length - 1]?.trim() || result.errorMessage?.trim();
  throw new Error(
    `${operation} ${FAILURE_LABELS[result.outcome]}${detail ? `: ${detail}` : ""}`,
  );
}
