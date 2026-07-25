import { useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { listFiles } from "../api";

type Props = {
  attachedPaths: string[];
  busy: boolean;
  documentPath?: string;
  onToggle: (relativePath: string) => Promise<void>;
};

function pathKey(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function isSupportedSource(relativePath: string): boolean {
  return /\.(md|markdown|txt|csv|pdf|docx)$/i.test(relativePath);
}

export function SourcePicker({ attachedPaths, busy, documentPath, onToggle }: Props) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const requestId = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const choices = useMemo(() => {
    const documentKey = documentPath ? pathKey(documentPath) : "";
    const seen = new Set<string>();
    return files.filter((relativePath) => {
      const key = pathKey(relativePath);
      if (!isSupportedSource(relativePath) || key === documentKey || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [documentPath, files]);

  const attachedKeys = useMemo(
    () => new Set(attachedPaths.map((relativePath) => pathKey(relativePath))),
    [attachedPaths],
  );

  useEffect(() => {
    setOpen(false);
  }, [documentPath]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    void listFiles()
      .then((data) => {
        if (requestId.current === currentRequest) setFiles(data.files);
      })
      .catch((reason) => {
        if (requestId.current === currentRequest) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (requestId.current === currentRequest) setLoading(false);
      });
    return () => {
      requestId.current += 1;
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`source-picker${attachedPaths.length ? " has-sources" : ""}`}
    >
      <button
        type="button"
        className="icon-button source-picker-toggle"
        disabled={busy}
        aria-expanded={open}
        aria-label={attachedPaths.length ? `资料，已挂 ${attachedPaths.length} 份` : "添加资料"}
        title={attachedPaths.length ? `已挂 ${attachedPaths.length} 份资料` : "添加资料"}
        onClick={() => setOpen((value) => !value)}
      >
        <Paperclip size={17} strokeWidth={1.8} />
        {attachedPaths.length ? <span className="source-count">{attachedPaths.length}</span> : null}
      </button>

      {open ? (
        <div className="source-picker-panel" role="dialog" aria-label="选择资料">
          <div className="source-picker-heading">
            <span>资料</span>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭资料面板"
              title="关闭"
              onClick={() => setOpen(false)}
            >
              <X size={15} />
            </button>
          </div>
          {loading ? <p className="source-picker-note">正在读取工作区…</p> : null}
          {error ? <p className="source-picker-note error">{error}</p> : null}
          {!loading && !error && choices.length === 0 ? (
            <p className="source-picker-note">没有可用的 TXT、Markdown、CSV、PDF 或 DOCX。</p>
          ) : null}
          {!loading && !error && choices.length ? (
            <ul className="source-picker-list">
              {choices.map((relativePath) => (
                <li key={pathKey(relativePath)}>
                  <label title={relativePath}>
                    <input
                      type="checkbox"
                      checked={attachedKeys.has(pathKey(relativePath))}
                      disabled={busy || savingPath !== null}
                      onChange={() => {
                        setSavingPath(relativePath);
                        void onToggle(relativePath).finally(() => setSavingPath(null));
                      }}
                    />
                    <span>{relativePath}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
