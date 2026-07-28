import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import {
  clearCurrentSession,
  deleteSession,
  getSession,
  listSessions,
  newSession,
  switchSession,
  type AgentSessionSummary,
  type SessionSnapshot,
} from "../api";
import { useDialogFocus } from "../dialogFocus";
import { formatSessionTime } from "../sessionTime";

type Props = {
  open: boolean;
  /** A chat turn is streaming; session mutations would queue behind it. */
  busy: boolean;
  /** Unsaved canvas edits; switching to another document would drop them. */
  documentDirty?: boolean;
  onClose: () => void;
  onApplySnapshot: (snapshot: SessionSnapshot) => Promise<void>;
};

/**
 * 会话管理：新会话（保留文稿与资料，当前对话入历史）、恢复历史会话、
 * 清空记录（两步确认，销毁当前对话内容）。三者共用 boot 的 snapshot hydrate。
 */
export function SessionMenu({ open, busy, documentDirty = false, onClose, onApplySnapshot }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<AgentSessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Action in flight: "new" | "clear" | sessionId | `del:${sessionId}`. */
  const [pending, setPending] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await listSessions();
      setSessions(result.sessions);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setConfirmClear(false);
    setError(null);
    setSessions(null);
    void refresh();
  }, [open, refresh]);

  useDialogFocus({
    active: open,
    containerRef: panelRef,
    canClose: () => !pending,
    onEscape: onClose,
  });

  if (!open) return null;

  const run = async (key: string, action: () => Promise<void>) => {
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const applyAndClose = async (snapshot: SessionSnapshot) => {
    await onApplySnapshot(snapshot);
    onClose();
  };

  const handleNew = () =>
    void run("new", async () => {
      await applyAndClose(await newSession());
    });

  const handleSwitch = (sessionId: string) => {
    if (
      documentDirty &&
      !window.confirm("当前文稿有未保存的修改。切换会话后这些修改会丢失，仍要切换吗？")
    ) {
      return;
    }
    void run(sessionId, async () => {
      await applyAndClose(await switchSession(sessionId));
    });
  };

  const handleDelete = (sessionId: string) =>
    void run(`del:${sessionId}`, async () => {
      await deleteSession(sessionId);
      await refresh();
    });

  const handleClear = () =>
    void run("clear", async () => {
      await clearCurrentSession();
      // clear returns a thin ack; re-read the session snapshot so the UI
      // hydrates exactly like boot / new / switch.
      await applyAndClose(await getSession());
    });

  const locked = Boolean(busy || pending);

  return (
    <div className="settings-overlay" role="presentation">
      <div
        ref={panelRef}
        className="settings-panel session-menu"
        role="dialog"
        aria-modal="true"
        aria-label="会话管理"
      >
        <header className="settings-head">
          <div>
            <h2>会话</h2>
            <p>新会话保留当前文稿与资料，当前对话会存入历史。</p>
          </div>
          <button
            type="button"
            className="settings-close"
            disabled={Boolean(pending)}
            onClick={onClose}
            aria-label="关闭会话管理"
            title="关闭"
          >
            <X size={18} />
          </button>
        </header>

        <div className="session-menu-body">
          <button
            type="button"
            className="btn session-new"
            disabled={locked}
            onClick={handleNew}
          >
            <Plus size={15} aria-hidden /> 新会话
          </button>

          <section className="session-history" aria-label="历史会话">
            <h3>历史会话</h3>
            {sessions === null && !error ? (
              <p className="extensions-empty" role="status">正在加载…</p>
            ) : null}
            {sessions?.length === 0 ? (
              <p className="extensions-empty">暂无历史会话</p>
            ) : null}
            {sessions?.length ? (
              <ul className="session-list">
                {sessions.map((session) => (
                  <li key={session.sessionId} className="session-item">
                    <button
                      type="button"
                      className="session-switch"
                      disabled={locked}
                      onClick={() => handleSwitch(session.sessionId)}
                      title="恢复此会话"
                    >
                      <span className="session-title">{session.title}</span>
                      <span className="session-meta">
                        {formatSessionTime(session.updatedAt)}
                        {session.turnCount ? ` · ${session.turnCount} 轮` : ""}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="session-delete"
                      aria-label={`删除会话「${session.title}」`}
                      title="删除此历史会话"
                      disabled={locked}
                      onClick={() => handleDelete(session.sessionId)}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {error ? <p className="settings-msg err" role="status">{error}</p> : null}

          <section className="session-danger">
            {confirmClear ? (
              <div className="session-clear-confirm" role="alertdialog" aria-label="确认清空记录">
                <p>清空当前对话记录？不可撤销；已存入历史的会话不受影响。</p>
                <div className="session-clear-actions">
                  <button
                    type="button"
                    className="btn session-danger-btn"
                    disabled={pending === "clear"}
                    onClick={handleClear}
                  >确认清空</button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={pending === "clear"}
                    onClick={() => setConfirmClear(false)}
                  >取消</button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn ghost session-clear-btn"
                disabled={locked}
                onClick={() => setConfirmClear(true)}
              >清空记录</button>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
