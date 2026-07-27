import type { PiLoopOutcome, PiLoopResult } from "./pi-loop.js";

const FAILURE_LABELS: Record<Exclude<PiLoopOutcome, "completed">, string> = {
  aborted: "aborted",
  timed_out: "timed out",
  error: "failed",
};

export class PiLoopFailure extends Error {
  readonly outcome: Exclude<PiLoopOutcome, "completed">;
  readonly notes: string[];
  readonly toolAudit: PiLoopResult["toolAudit"];

  constructor(
    operation: string,
    result: PiLoopResult & { outcome: Exclude<PiLoopOutcome, "completed"> },
  ) {
    const detail = result.notes[result.notes.length - 1]?.trim() || result.errorMessage?.trim();
    super(`${operation} ${FAILURE_LABELS[result.outcome]}${detail ? `: ${detail}` : ""}`);
    this.name = "PiLoopFailure";
    this.outcome = result.outcome;
    this.notes = [...result.notes];
    this.toolAudit = [...result.toolAudit];
  }
}

export function assertPiLoopCompleted(
  result: PiLoopResult,
  operation: string,
): void {
  if (result.outcome === "completed") return;
  throw new PiLoopFailure(operation, result as PiLoopResult & {
    outcome: Exclude<PiLoopOutcome, "completed">;
  });
}
