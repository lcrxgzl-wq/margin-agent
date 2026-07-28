import { useEffect, useRef, useState } from "react";
import { useDialogFocus } from "../dialogFocus";
import { formatMcpApprovalArgs, type PendingMcpApproval } from "../mcpApproval";

type Props = {
  approval: PendingMcpApproval | null;
  onDecision: (decision: "allow" | "deny") => Promise<void> | void;
};

/**
 * Per-call remote MCP approval. Exactly two decisions — 允许一次 / 拒绝;
 * no remember-forever. Undecided requests auto-deny after 60s server-side.
 */
export function McpApprovalDialog({ approval, onDecision }: Props) {
  const [posting, setPosting] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setPosting(false), [approval?.approvalId]);

  useDialogFocus({
    active: !!approval,
    containerRef: panelRef,
    // Default focus lands on 拒绝 so a stray Enter can never allow a remote call.
    initialFocusRef: denyRef,
    canClose: () => !posting,
    onEscape: () => decide("deny"),
  });

  if (!approval) return null;

  const decide = (decision: "allow" | "deny") => {
    if (posting) return;
    setPosting(true);
    void Promise.resolve(onDecision(decision)).finally(() => setPosting(false));
  };

  return (
    <div className="settings-overlay" role="presentation">
      <div
        ref={panelRef}
        className="settings-panel mcp-approval-panel"
        role="dialog"
        aria-modal="true"
        aria-label="远程 MCP 调用审批"
        aria-busy={posting}
      >
        <header className="settings-head">
          <h2>远程 MCP 调用审批</h2>
        </header>
        <div className="mcp-approval-body">
          <p>
            Agent 请求调用远程服务器「{approval.serverName}」的只读工具「{approval.tool}」。
            批准仅本次调用生效；60 秒内未选择将自动拒绝，拒绝不会发起任何网络请求。
          </p>
          <pre className="mcp-approval-args">{formatMcpApprovalArgs(approval.args)}</pre>
        </div>
        <div className="mcp-approval-actions">
          <button
            ref={denyRef}
            type="button"
            className="btn ghost"
            disabled={posting}
            onClick={() => decide("deny")}
          >
            拒绝
          </button>
          <button
            type="button"
            className="btn send"
            disabled={posting}
            onClick={() => decide("allow")}
          >
            允许一次
          </button>
        </div>
      </div>
    </div>
  );
}
