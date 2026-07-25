import { Check, ChevronLeft, ChevronRight, History, ListChecks, Pencil, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listDocumentTimeline, readSourceChunk, type Comment, type Proposal, type TimelineEntry } from "../api";
import { proposalChange } from "../proposalChange";
import { filterTimeline, historyEntryView, historyFilters, type HistoryFilter } from "../reviewHistory";
import type { ReviewThread } from "../store";

type Props = {
  proposals: Proposal[];
  comments: Comment[];
  documentId: string;
  busy: boolean;
  dirty: boolean;
  error?: string | null;
  onAccept: (proposalId: string) => void | boolean | Promise<void | boolean>;
  onEdit: (proposalId: string, editedText: string) => void | boolean | Promise<void | boolean>;
  onUndo: (proposalId: string) => void | boolean | Promise<void | boolean>;
  onRewrite: (proposalId: string, blockId: string) => void;
  onActiveProposalChange?: (proposalId: string | null) => void;
  threads?: ReviewThread[];
  activeThreadId?: string | null;
  onOpenThread?: (thread: ReviewThread) => void;
};

const operationName = {
  translate: "翻译",
  polish: "润色",
  rewrite: "改写",
  table_cell: "表格",
} as const;

function EvidenceRef({ reference }: { reference: string }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof readSourceChunk>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = reference.replace(/#.*$/, "");
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || preview || error) return;
    void readSourceChunk(reference)
      .then(setPreview)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  return (
    <div className="evidence-ref">
      <button type="button" title={reference} onClick={toggle}>{label}</button>
      {open ? (
        <p className={error ? "error" : ""}>
          {error || !preview ? error || "正在读取…" : <>
            {preview.excerpt.slice(0, preview.selectionStart)}
            <mark>{preview.excerpt.slice(preview.selectionStart, preview.selectionEnd)}</mark>
            {preview.excerpt.slice(preview.selectionEnd)}
          </>}
        </p>
      ) : null}
    </div>
  );
}

export function ReviewPanel({
  proposals,
  comments,
  documentId,
  busy,
  dirty,
  error,
  onAccept,
  onEdit,
  onUndo,
  onRewrite,
  onActiveProposalChange,
  threads = [],
  activeThreadId,
  onOpenThread,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(proposals[0]?.id ?? null);
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState("");
  const [view, setView] = useState<"queue" | "history">("queue");
  const [history, setHistory] = useState<TimelineEntry[]>([]);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const activeIndex = Math.max(0, proposals.findIndex((proposal) => proposal.id === activeId));
  const proposal = proposals[activeIndex];
  const changeResult = useMemo(() => {
    if (!proposal) return { change: null, error: null };
    try {
      return { change: proposalChange(proposal), error: null };
    } catch (reason) {
      return {
        change: null,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }, [proposal]);
  const change = changeResult.change;
  const disabled = busy || dirty;
  const visibleHistory = useMemo(
    () => filterTimeline(history, historyFilter),
    [history, historyFilter],
  );

  useEffect(() => {
    if (!proposals.length) {
      setActiveId(null);
      setEditing(false);
      return;
    }
    if (!proposals.some((candidate) => candidate.id === activeId)) {
      setActiveId(proposals[0]!.id);
      setEditing(false);
    }
  }, [activeId, proposals]);

  useEffect(() => {
    onActiveProposalChange?.(proposal?.id ?? null);
  }, [onActiveProposalChange, proposal?.id]);

  useEffect(() => {
    setView("queue");
    setHistory([]);
    setHistoryFilter("all");
    setHistoryError(null);
  }, [documentId]);

  useEffect(() => {
    if (view !== "history") return;
    let cancelled = false;
    void listDocumentTimeline(documentId, 200)
      .then((result) => {
        if (cancelled) return;
        setHistory(result.entries);
        setHistoryError(null);
      })
      .catch((reason) => {
        if (!cancelled) setHistoryError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, proposals.length, view]);

  const move = (direction: -1 | 1) => {
    const next = (activeIndex + direction + proposals.length) % proposals.length;
    setActiveId(proposals[next]!.id);
    setEditing(false);
  };

  return (
    <section className="review-panel" aria-label="审阅">
      <nav className="review-sections" aria-label="审阅视图">
        <button type="button" className={view === "queue" ? "active" : ""} onClick={() => setView("queue")}><ListChecks />待确认{proposals.length ? <b>{proposals.length}</b> : null}</button>
        <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}><History />历史</button>
      </nav>
      {view === "queue" ? <>
      {threads.length > 0 && onOpenThread ? (
        <div className="review-threads" aria-label="线程收件箱">
          {threads.map((thread) => {
            const pending = proposals.filter((proposal) => proposal.blockId === thread.anchor.blockId).length;
            const excerpt = (thread.anchor.tableCell?.before ?? thread.anchor.selectionText).trim();
            return (
              <button
                type="button"
                key={thread.id}
                className={`review-thread-item${thread.id === activeThreadId ? " active" : ""}`}
                onClick={() => onOpenThread(thread)}
              >
                <span className="review-thread-excerpt">{excerpt.length > 42 ? `${excerpt.slice(0, 42)}…` : excerpt || "（整个段落）"}</span>
                {pending ? <b>{pending} 待审</b> : <i>讨论</i>}
              </button>
            );
          })}
        </div>
      ) : null}
      {dirty ? (
        <p className="review-warning">正文有未保存修改。保存或撤销后才能处理提案。</p>
      ) : null}
      {error ? <p className="review-error" role="alert">{error}</p> : null}
      {changeResult.error ? (
        <p className="review-error" role="alert">{changeResult.error}</p>
      ) : proposal && change ? (
        <div className="review-current">
          <header className="review-heading">
            <div>
              <strong>{operationName[change.kind]}</strong>
              <span>{change.scope === "selection" ? "仅替换选中文字" : change.scope === "table_cell" ? `单元格 ${change.address}` : "整段提案"}</span>
            </div>
            {proposals.length > 1 ? (
              <div className="review-nav" aria-label="切换提案">
                <button type="button" onClick={() => move(-1)} aria-label="上一处" title="上一处"><ChevronLeft /></button>
                <span>{activeIndex + 1}/{proposals.length}</span>
                <button type="button" onClick={() => move(1)} aria-label="下一处" title="下一处"><ChevronRight /></button>
              </div>
            ) : <span className="review-count">1 处待确认</span>}
          </header>

          <p className="review-rationale">{proposal.rationale}</p>
          <div className="review-change" aria-label="局部修订对比">
            <div className="review-fragment before">
              <span>{change.kind === "translate" ? "原文" : change.kind === "table_cell" ? `${change.address} 当前` : "修改前"}</span>
              <del>{change.beforeFragment || "（空）"}</del>
            </div>
            <div className="review-fragment after">
              <span>{change.kind === "translate" ? "译文" : change.kind === "table_cell" ? `${change.address} 建议` : "修改后"}</span>
              <ins>{change.afterFragment || "（空）"}</ins>
            </div>
          </div>
          {(change.contextBefore || change.contextAfter) ? (
            <p className="review-context" aria-label="所在上下文">
              {change.contextStartsMidway ? "…" : ""}{change.contextBefore}
              <mark>{change.beforeFragment}</mark>
              {change.contextAfter}{change.contextEndsMidway ? "…" : ""}
            </p>
          ) : null}
          {proposal.evidence?.length ? (
            <div className="proposal-evidence" aria-label="资料依据">
              <span>依据</span>
              {proposal.evidence.map((reference) => <EvidenceRef key={reference} reference={reference} />)}
            </div>
          ) : null}

          {editing ? (
            <div className="review-editor">
              <label htmlFor={`proposal-edit-${proposal.id}`}>
                {change.scope === "selection" ? "编辑替换文本" : change.scope === "table_cell" ? `编辑单元格 ${change.address}` : "编辑完整段落"}
              </label>
              <textarea
                id={`proposal-edit-${proposal.id}`}
                value={editedText}
                disabled={busy}
                autoFocus
                onChange={(event) => setEditedText(event.target.value)}
              />
              <div className="review-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={disabled || !editedText.trim()}
                  onClick={() => {
                    void Promise.resolve(onEdit(proposal.id, change.composeEditedText(editedText)))
                      .then((ok) => {
                        if (ok !== false) setEditing(false);
                      });
                  }}
                ><Check />确认编辑</button>
                <button type="button" disabled={busy} onClick={() => setEditing(false)}><X />取消</button>
              </div>
            </div>
          ) : (
            <div className="review-actions">
              <button type="button" className="primary" disabled={disabled} onClick={() => { void Promise.resolve(onAccept(proposal.id)); }}><Check />Y 接受</button>
              <button type="button" disabled={disabled} onClick={() => { setEditedText(change.editValue); setEditing(true); }}><Pencil />E 编辑</button>
              <button type="button" disabled={disabled} onClick={() => { void Promise.resolve(onUndo(proposal.id)); }}><X />N 撤回</button>
              <button type="button" disabled={disabled} onClick={() => onRewrite(proposal.id, proposal.blockId)}><RotateCcw />重写</button>
            </div>
          )}
        </div>
      ) : (
        <div className="review-empty">
          <strong>没有待确认改动</strong>
          <p>选中文字后可直接翻译、润色或改写。</p>
        </div>
      )}

      {comments.length ? (
        <div className="review-comments">
          <h3>边注</h3>
          {comments.map((comment) => (
            <p className={comment.severity === "warn" ? "warn" : ""} key={comment.id}>{comment.text}</p>
          ))}
        </div>
      ) : null}
      </> : (
        <div className="review-history">
          <nav className="review-sections review-history-filters" aria-label="历史筛选">
            {historyFilters.map((item) => (
              <button
                type="button"
                key={item.id}
                className={historyFilter === item.id ? "active" : ""}
                onClick={() => setHistoryFilter(item.id)}
              >{item.label}</button>
            ))}
          </nav>
          {historyError ? <p className="review-error">{historyError}</p> : null}
          {!historyError && !visibleHistory.length ? (
            <p className="review-history-empty">
              {history.length ? "该筛选下没有记录。" : "尚无接受、编辑或撤回记录。"}
            </p>
          ) : null}
          <ol>
            {visibleHistory.map((entry) => {
              const item = historyEntryView(entry);
              return (
                <li key={entry.id} className={item.accepted ? "ok" : "rejected"}>
                  <div>
                    <strong>{item.action}</strong>
                    <time>{new Date(entry.createdAt).toLocaleString()}</time>
                  </div>
                  {entry.rationale ? <p>{entry.rationale}</p> : null}
                  {item.beforeExcerpt != null || item.afterExcerpt != null ? (
                    <div className="review-history-diff" aria-label="修订前后">
                      {item.beforeExcerpt != null ? (
                        <div className="review-fragment before">
                          <span>前</span>
                          <del>{item.beforeExcerpt}</del>
                        </div>
                      ) : null}
                      {item.afterExcerpt != null ? (
                        <div className="review-fragment after">
                          <span>后</span>
                          <ins>{item.afterExcerpt}</ins>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <span>
                    {entry.blockId ? `块 ${entry.blockId} · ` : ""}
                    r{entry.beforeRevision}{entry.afterRevision != null ? ` → r${entry.afterRevision}` : ""}
                    {!entry.ok && entry.reason ? ` · ${entry.reason}` : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
