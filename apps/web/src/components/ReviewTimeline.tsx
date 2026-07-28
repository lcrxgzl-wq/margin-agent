import { useCallback, useEffect, useState } from "react";
import { History, X } from "lucide-react";
import { listDocumentTimeline, type TimelineEntry } from "../api";

function kindLabel(kind: string | null): string {
  if (kind === "Y") return "接受";
  if (kind === "N") return "拒绝";
  if (kind === "E") return "编辑";
  return kind || "—";
}

export function ReviewTimeline({ documentId }: { documentId: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listDocumentTimeline(documentId);
      setEntries(data.entries);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [documentId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => setOpen(false), [documentId]);

  return (
    <div className="review-timeline">
      <button
        type="button"
        className="icon-button timeline-toggle"
        title="审阅记录"
        aria-label="审阅记录"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <History size={17} strokeWidth={1.8} />
      </button>
      {open ? (
        <div className="timeline-panel">
          <div className="timeline-heading">
            <span>审阅记录</span>
            <button
              type="button"
              className="icon-button"
              title="关闭"
              aria-label="关闭审阅记录"
              onClick={() => setOpen(false)}
            >
              <X size={15} />
            </button>
          </div>
          {error ? <p className="timeline-empty">{error}</p> : null}
          {!error && entries.length === 0 ? (
            <p className="timeline-empty">尚无接受 / 拒绝记录。</p>
          ) : null}
          <ul className="timeline-list">
            {entries.map((e) => (
              <li key={e.id} className={e.ok ? "ok" : "fail"}>
                <span className="timeline-meta">
                  {new Date(e.createdAt).toLocaleString()} · {kindLabel(e.decisionKind)}
                  {e.afterRevision != null
                    ? ` · r${e.beforeRevision}→r${e.afterRevision}`
                    : ` · r${e.beforeRevision}`}
                  {!e.ok && e.reason ? ` · ${e.reason}` : ""}
                </span>
                {e.rationale ? <span className="timeline-rationale">{e.rationale}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
