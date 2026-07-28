import { createHash, randomUUID } from "node:crypto";

export type McpApprovalDecision = "allow" | "deny";

/** Bounded, redacted approval/call metadata persisted via the transcript channel. */
export type McpApprovalAuditEntry = {
  ts: string;
  approvalId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  serverId: string;
  serverName: string;
  tool: string;
  decision: McpApprovalDecision;
  reason?: string;
  /** sha256[:12] of the bounded approval-preview args; raw args are never logged. */
  argsHash: string;
};

export type McpApprovalRequestInput = {
  workspaceRoot: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  serverId: string;
  serverName: string;
  tool: string;
  /** Already bounded + redacted by the agent-side approval preview. */
  args: unknown;
};

export type McpApprovalOutcome = {
  decision: McpApprovalDecision;
  reason?: string;
};

type PendingApproval = {
  input: McpApprovalRequestInput;
  approvalId: string;
  resolve: (outcome: McpApprovalOutcome, audit: McpApprovalAuditEntry) => void;
  timer: ReturnType<typeof setTimeout>;
};

export const MCP_APPROVAL_EXPIRY_MS = 60_000;

function hashArgs(args: unknown): string {
  try {
    return createHash("sha256").update(JSON.stringify(args) ?? "").digest("hex").slice(0, 12);
  } catch {
    return "unserializable";
  }
}

function auditEntry(
  pending: PendingApproval,
  decision: McpApprovalDecision,
  reason?: string,
): McpApprovalAuditEntry {
  return {
    ts: new Date().toISOString(),
    approvalId: pending.approvalId,
    sessionId: pending.input.sessionId.slice(0, 64),
    runId: pending.input.runId.slice(0, 64),
    toolCallId: pending.input.toolCallId.slice(0, 200),
    serverId: pending.input.serverId.slice(0, 80),
    serverName: pending.input.serverName.slice(0, 80),
    tool: pending.input.tool.slice(0, 120),
    decision,
    reason: reason?.slice(0, 120),
    argsHash: hashArgs(pending.input.args),
  };
}

/**
 * Per-call remote MCP approvals. Key = {workspaceRoot, sessionId, runId,
 * toolCallId} minted into a one-use approvalId; each pending request expires
 * (deny) after 60s and is denied on cancel/disconnect/supersede via the
 * denyAll hooks. Resolution deletes the entry, so replay fails.
 */
export function createMcpApprovalRegistry(opts?: { expiryMs?: number }) {
  const expiryMs = opts?.expiryMs ?? MCP_APPROVAL_EXPIRY_MS;
  const pending = new Map<string, PendingApproval>();
  /** Recently expired ids (bounded) so the route can answer 410 vs 404. */
  const expiredIds: string[] = [];

  const settle = (
    approvalId: string,
    decision: McpApprovalDecision,
    reason?: string,
  ): McpApprovalAuditEntry | undefined => {
    const entry = pending.get(approvalId);
    if (!entry) return undefined;
    pending.delete(approvalId);
    clearTimeout(entry.timer);
    const audit = auditEntry(entry, decision, reason);
    entry.resolve({ decision, reason }, audit);
    return audit;
  };

  const rememberExpired = (approvalId: string) => {
    expiredIds.push(approvalId);
    if (expiredIds.length > 200) expiredIds.splice(0, expiredIds.length - 200);
  };

  return {
    /** Mint a one-use approval bound to workspace/session/run/toolCall. */
    request(input: McpApprovalRequestInput): {
      approvalId: string;
      wait: Promise<{ outcome: McpApprovalOutcome; audit: McpApprovalAuditEntry }>;
    } {
      const approvalId = randomUUID();
      let resolveWait: (value: {
        outcome: McpApprovalOutcome;
        audit: McpApprovalAuditEntry;
      }) => void = () => undefined;
      const wait = new Promise<{ outcome: McpApprovalOutcome; audit: McpApprovalAuditEntry }>(
        (resolve) => {
          resolveWait = resolve;
        },
      );
      const entry: PendingApproval = {
        input,
        approvalId,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        resolve: (outcome, audit) => {
          resolveWait({ outcome, audit });
        },
      };
      entry.timer = setTimeout(() => {
        if (settle(approvalId, "deny", "expired")) rememberExpired(approvalId);
      }, expiryMs);
      entry.timer.unref?.();
      pending.set(approvalId, entry);
      return { approvalId, wait };
    },

    /** One-use resolution; replay / cross-run reuse of an id fails. */
    resolve(
      approvalId: string,
      decision: McpApprovalDecision,
    ): { status: "ok"; audit: McpApprovalAuditEntry } | { status: "expired" | "unknown" } {
      const audit = settle(approvalId, decision, "user");
      if (audit) return { status: "ok", audit };
      return { status: expiredIds.includes(approvalId) ? "expired" : "unknown" };
    },

    /** Deny every pending approval of a run (cancel, disconnect, abort). */
    denyAllForRun(runId: string, reason = "run-cancelled"): McpApprovalAuditEntry[] {
      const audits: McpApprovalAuditEntry[] = [];
      for (const [approvalId, entry] of [...pending.entries()]) {
        if (entry.input.runId !== runId) continue;
        const audit = settle(approvalId, "deny", reason);
        if (audit) audits.push(audit);
      }
      return audits;
    },

    /** Deny every pending approval of a session (superseding run, reset). */
    denyAllForSession(sessionId: string, reason = "superseded"): McpApprovalAuditEntry[] {
      const audits: McpApprovalAuditEntry[] = [];
      for (const [approvalId, entry] of [...pending.entries()]) {
        if (entry.input.sessionId !== sessionId) continue;
        const audit = settle(approvalId, "deny", reason);
        if (audit) audits.push(audit);
      }
      return audits;
    },

    pendingCount(): number {
      return pending.size;
    },
  };
}

export type McpApprovalRegistry = ReturnType<typeof createMcpApprovalRegistry>;
