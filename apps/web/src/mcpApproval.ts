/** Pending per-call remote MCP approval surfaced from the chat stream. */
export type PendingMcpApproval = {
  approvalId: string;
  serverId: string;
  serverName: string;
  tool: string;
  args: unknown;
};

const MAX_ARGS_PREVIEW_CHARS = 4_000;

/** Bounded pretty print of the (already redacted) approval args for the dialog. */
export function formatMcpApprovalArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? "null";
  } catch {
    text = String(args);
  }
  return text.length > MAX_ARGS_PREVIEW_CHARS
    ? `${text.slice(0, MAX_ARGS_PREVIEW_CHARS)}\n…`
    : text;
}
