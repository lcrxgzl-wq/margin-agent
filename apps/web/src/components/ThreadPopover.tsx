import { ArrowUp, Check, Pencil, RotateCcw, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { Comment, Proposal } from "../api";
import { submitEnterFrom } from "../ime";
import { defaultThreadFloatRect } from "../layoutGeometry";
import { proposalChange } from "../proposalChange";
import type { ReviewThread } from "../store";
import type { ChatMessage } from "./Chat";

const operationName = {
  translate: "翻译",
  polish: "润色",
  rewrite: "改写",
  table_cell: "表格",
} as const;

type ProposalCardProps = {
  proposal: Proposal;
  disabled: boolean;
  busy: boolean;
  onAccept: (proposalId: string) => void | boolean | Promise<void | boolean>;
  onEdit: (proposalId: string, editedText: string) => void | boolean | Promise<void | boolean>;
  onUndo: (proposalId: string) => void | boolean | Promise<void | boolean>;
  onRewrite: (proposalId: string, blockId: string) => void;
};

function ThreadProposalCard({
  proposal,
  disabled,
  busy,
  onAccept,
  onEdit,
  onUndo,
  onRewrite,
}: ProposalCardProps) {
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState("");
  const changeResult = useMemo(() => {
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

  useEffect(() => {
    setEditing(false);
    setEditedText("");
  }, [proposal.id]);

  if (changeResult.error || !change) {
    return <p className="review-error" role="alert">{changeResult.error ?? "这条提案无法解析。"}</p>;
  }

  return (
    <div className="review-current thread-proposal">
      <header className="review-heading">
        <div>
          <strong>{operationName[change.kind]}</strong>
          <span>{change.scope === "selection" ? change.granularityLabel : change.scope === "table_cell" ? `单元格 ${change.address}` : "整段提案"}</span>
        </div>
      </header>
      <p className="review-rationale">{proposal.rationale}</p>
      <div className="review-change" aria-label="局部修订对比">
        <div className="review-fragment before">
          <span>{change.kind === "translate" ? "原文" : "修改前"}</span>
          <del>{change.beforeFragment || "（空）"}</del>
        </div>
        <div className="review-fragment after">
          <span>{change.kind === "translate" ? "译文" : "修改后"}</span>
          <ins>{change.afterFragment || "（空）"}</ins>
        </div>
      </div>
      {editing ? (
        <div className="review-editor">
          <textarea
            value={editedText}
            disabled={busy}
            autoFocus
            aria-label="编辑替换文本"
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
          <button type="button" disabled={disabled} onClick={() => { void Promise.resolve(onUndo(proposal.id)); }}><X />N 拒绝</button>
          <button type="button" disabled={disabled} title="重新生成另一版" onClick={() => onRewrite(proposal.id, proposal.blockId)}><RotateCcw />重写</button>
        </div>
      )}
    </div>
  );
}

type Props = {
  thread: ReviewThread;
  anchorAlive: boolean;
  proposals: Proposal[];
  comments: Comment[];
  messages: ChatMessage[];
  retryMessageId?: string;
  busy: boolean;
  statusLine: string;
  dirty: boolean;
  onSend: (text: string) => void;
  onRetry?: (messageId: string) => void;
  onAccept: (proposalId: string) => void | boolean | Promise<void | boolean>;
  onEdit: (proposalId: string, editedText: string) => void | boolean | Promise<void | boolean>;
  onUndo: (proposalId: string) => void | boolean | Promise<void | boolean>;
  onRewrite: (proposalId: string, blockId: string) => void;
  onCollapse: () => void;
  onClose: () => void;
};

const POPOVER_WIDTH = 520;
const MIN_SIZE = { width: 340, height: 260 };

/** In-place anchored thread: discussion + pending proposals fused around one selection. */
export function ThreadPopover({
  thread,
  anchorAlive,
  proposals,
  comments,
  messages,
  retryMessageId,
  busy,
  statusLine,
  dirty,
  onSend,
  onRetry,
  onAccept,
  onEdit,
  onUndo,
  onRewrite,
  onCollapse,
  onClose,
}: Props) {
  const [draft, setDraft] = useState("");
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseLeft: number; baseTop: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; baseWidth: number; baseHeight: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const excerpt = thread.anchor.tableCell?.before ?? thread.anchor.selectionText;

  const position = useMemo(() => {
    return defaultThreadFloatRect(thread.pos, viewport);
  }, [thread.pos, viewport]);

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
  const activeWidth = Math.min(size?.width ?? position.width, Math.max(0, viewport.width - 16));
  const activeHeight = Math.min(size?.height ?? position.height, Math.max(0, viewport.height - 16));
  const left = clamp(position.x + (drag?.dx ?? 0), 8, viewport.width - activeWidth - 8);
  const top = clamp(position.y + (drag?.dy ?? 0), 8, viewport.height - activeHeight - 8);

  const onHeadPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, baseLeft: left, baseTop: top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHeadPointerMove = (event: PointerEvent<HTMLElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setDrag({
      dx: active.baseLeft + (event.clientX - active.startX) - position.x,
      dy: active.baseTop + (event.clientY - active.startY) - position.y,
    });
  };
  const onHeadPointerEnd = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const onResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const base = event.currentTarget.closest(".thread-popover")?.getBoundingClientRect();
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseWidth: size?.width ?? base?.width ?? POPOVER_WIDTH,
      baseHeight: size?.height ?? base?.height ?? 360,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = resizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setSize({
      width: clamp(
        active.baseWidth + (event.clientX - active.startX),
        Math.min(MIN_SIZE.width, viewport.width - left - 8),
        viewport.width - left - 8,
      ),
      height: clamp(
        active.baseHeight + (event.clientY - active.startY),
        Math.min(MIN_SIZE.height, viewport.height - top - 8),
        viewport.height - top - 8,
      ),
    });
  };
  const onResizePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
  };

  useEffect(() => {
    setDrag(null);
    setSize(null);
  }, [thread.id]);

  useEffect(() => {
    const updateViewport = () => setViewport({
      width: window.innerWidth,
      height: window.innerHeight,
    });
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [thread.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, proposals.length, busy]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCollapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCollapse]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSend(text);
  };

  return (
    <>
      <div className="thread-backdrop" onClick={onCollapse} aria-hidden />
      <section
        className="thread-popover"
        role="dialog"
        aria-label="选区线程"
        style={{
          left,
          top,
          width: activeWidth,
          height: activeHeight,
        }}
      >
        <header
          className="thread-head"
          onPointerDown={onHeadPointerDown}
          onPointerMove={onHeadPointerMove}
          onPointerUp={onHeadPointerEnd}
          onPointerCancel={onHeadPointerEnd}
        >
          <blockquote className="thread-quote" title={excerpt}>
            {thread.anchor.tableCell ? `单元格 ${thread.anchor.tableCell.address}：` : ""}
            {excerpt.length > 96 ? `${excerpt.slice(0, 96)}…` : excerpt || "（整个段落）"}
          </blockquote>
          <button type="button" className="icon-button" aria-label="关闭线程" title="关闭线程" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        {!anchorAlive ? <p className="thread-stale">锚点文字已随正文变化，请以最新正文为准。</p> : null}
        <div className="thread-scroll" ref={scrollRef}>
          {proposals.map((proposal) => (
            <ThreadProposalCard
              key={proposal.id}
              proposal={proposal}
              disabled={busy || dirty}
              busy={busy}
              onAccept={onAccept}
              onEdit={onEdit}
              onUndo={onUndo}
              onRewrite={onRewrite}
            />
          ))}
          {comments.length ? (
            <div className="thread-notes">
              {comments.map((comment) => (
                <p className={comment.severity === "warn" ? "warn" : ""} key={comment.id}>{comment.text}</p>
              ))}
            </div>
          ) : null}
          {messages.length ? (
            <div className="thread-messages">
              {messages.map((message) => (
                <Fragment key={message.id}>
                  <p data-role={message.role} className="thread-message">
                    {message.text || (busy ? "…" : "")}
                  </p>
                  {message.id === retryMessageId && onRetry ? (
                    <div className="task-receipt retry" role="status">
                      <span>请求未完成</span>
                      <button type="button" disabled={busy} onClick={() => onRetry(message.id)}>
                        <RotateCcw size={12} aria-hidden />
                        重试
                      </button>
                    </div>
                  ) : null}
                </Fragment>
              ))}
            </div>
          ) : null}
          {busy && statusLine ? <p className="thread-status">{statusLine}</p> : null}
          {!proposals.length && !messages.length && !busy ? (
            <p className="thread-empty">就这段文字提问，或直接说「润色」「译成英文」「更学术一点」。</p>
          ) : null}
        </div>
        <footer className="thread-composer">
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            placeholder="就这段提问或下指令…"
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (submitEnterFrom(event)) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="button"
            className="icon-button thread-send"
            aria-label="发送"
            title="发送"
            disabled={busy || !draft.trim()}
            onClick={submit}
          >
            <ArrowUp size={15} />
          </button>
        </footer>
        <div
          className="thread-resize"
          aria-hidden
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerEnd}
          onPointerCancel={onResizePointerEnd}
        />
      </section>
    </>
  );
}
