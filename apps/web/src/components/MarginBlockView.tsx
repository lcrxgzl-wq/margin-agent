import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";
import { usePending } from "../pendingContext";
import { proposalChange, type ProposalChange } from "../proposalChange";

function displayFragment(text: string, scope: ProposalChange["scope"]) {
  return scope === "block" ? text.replace(/^#{1,6}\s+/, "") : text;
}

export function MarginBlockView({ node }: NodeViewProps) {
  const { byBlock, commentsByBlock, onAccept, onEdit, onUndo, onRewrite, busy } = usePending();
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [editedText, setEditedText] = useState("");
  const blockId = String(node.attrs.blockId ?? "");
  const kind = String(node.attrs.kind ?? "paragraph");
  const proposals = byBlock.get(blockId) ?? [];
  const notes = commentsByBlock.get(blockId) ?? [];
  const pending = proposals.length > 0;

  return (
    <NodeViewWrapper
      as="div"
      className={`margin-block-wrap${pending ? " is-pending" : ""}`}
      data-block-id={blockId}
      data-kind={kind}
      data-pending={pending ? "1" : "0"}
    >
      <div className={`margin-block kind-${kind}`} data-pending={pending ? "1" : "0"}>
        <NodeViewContent as="div" className="margin-block-content" />
      </div>
      {notes.length > 0 ? (
        <div className="side-notes" contentEditable={false}>
          {notes.map((c) => (
            <div
              key={c.id}
              className={`side-note${c.severity === "warn" ? " warn" : ""}`}
            >
              {c.text}
            </div>
          ))}
        </div>
      ) : null}
      {proposals.map((proposal, idx) => {
        let change: ProposalChange;
        try {
          change = proposalChange(proposal);
        } catch (reason) {
          return (
            <div key={proposal.id} className="pending-rail" contentEditable={false}>
              <p className="review-error" role="alert">
                {reason instanceof Error ? reason.message : String(reason)}
              </p>
            </div>
          );
        }
        const scopeLabel = change.scope === "selection"
          ? change.granularityLabel
          : change.scope === "table_cell"
            ? `单元格 ${change.address}`
            : "整段提案";
        return (
          <div key={proposal.id} className="pending-rail" contentEditable={false}>
            <div className="label">
              待确认改动{proposals.length > 1 ? ` ${idx + 1}/${proposals.length}` : ""} ·{" "}
              {proposal.risk} · {scopeLabel}
            </div>
            <div className="hint">{proposal.rationale}</div>
            {proposal.evidence?.length ? (
              <div className="proposal-evidence" aria-label="资料依据">
                <span>依据</span>
                {proposal.evidence.map((reference) => (
                  <code key={reference} title={reference}>
                    {reference}
                  </code>
                ))}
              </div>
            ) : null}
            <div className="compare">
              <div className="col">
                <span className="col-label">{change.kind === "translate" ? "原文" : "修改前"}</span>
                <div className="col-body">{displayFragment(change.beforeFragment, change.scope) || "（空）"}</div>
              </div>
              <div className="col">
                <span className="col-label">{change.kind === "translate" ? "译文" : "修改后"}</span>
                <div className="col-body after">{displayFragment(change.afterFragment, change.scope) || "（空）"}</div>
              </div>
            </div>
            {change.scope === "selection" ? (
              <div className="patch-context">
                {change.contextStartsMidway ? "…" : ""}{change.contextBefore}{change.contextAfter}{change.contextEndsMidway ? "…" : ""}
              </div>
            ) : null}
            {editingProposalId === proposal.id ? (
              <>
                <textarea
                  aria-label="编辑建议文本"
                  disabled={busy}
                  value={editedText}
                  onChange={(event) => setEditedText(event.target.value)}
                />
                <div className="actions">
                  <button
                    className="btn ok"
                    type="button"
                    disabled={busy || !editedText.trim()}
                    onClick={() => onEdit(proposal.id, change.composeEditedText(editedText))}
                  >
                    保存
                  </button>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditingProposalId(null);
                      setEditedText("");
                    }}
                  >
                    取消
                  </button>
                </div>
              </>
            ) : (
              <div className="actions">
                <button
                  className="btn ok"
                  type="button"
                  disabled={busy}
                  onClick={() => onAccept(proposal.id)}
                >
                  接受
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditingProposalId(proposal.id);
                    setEditedText(change.editValue);
                  }}
                >
                  编辑
                </button>
                <button
                  className="btn warn"
                  type="button"
                  disabled={busy}
                  onClick={() => onUndo(proposal.id)}
                >
                  拒绝
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => onRewrite(proposal.id, proposal.blockId)}
                >
                  重写
                </button>
              </div>
            )}
          </div>
        );
      })}
    </NodeViewWrapper>
  );
}
