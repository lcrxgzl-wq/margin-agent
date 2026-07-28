import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, FolderOpen, RefreshCw, X } from "lucide-react";
import {
  importWorkspaceDocx,
  listFiles,
  type Block,
  type DocumentMeta,
} from "../api";
import { useDialogFocus } from "../dialogFocus";

type ImportReport = { ok: boolean; flags?: string[] };

type Props = {
  open: boolean;
  onClose: () => void;
  onOpened: (document: DocumentMeta, blocks: Block[], report?: ImportReport) => void;
};

/**
 * 直接打开 DOCX：列出工作区内可见的 .docx（如 imports/），选中即导入。
 * 不经过模型解释路径；loading / empty / error / success 状态都在本对话框内。
 */
export function OpenDocxDialog({ open, onClose, onOpened }: Props) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setFiles(null);
    setLoadError(null);
    setImportError(null);
    void listFiles()
      .then((result) => {
        setFiles(result.files.filter((file) => /\.docx$/i.test(file)));
      })
      .catch((reason) => {
        setLoadError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    setImporting(null);
    load();
  }, [open, load]);

  useDialogFocus({
    active: open,
    containerRef: panelRef,
    canClose: () => importing === null,
    onEscape: onClose,
  });

  if (!open) return null;

  const importFile = async (relativePath: string) => {
    if (importing) return;
    setImporting(relativePath);
    setImportError(null);
    try {
      const result = await importWorkspaceDocx(relativePath);
      onOpened(result.document, result.blocks, result.report);
      onClose();
    } catch (reason) {
      setImportError(
        `导入 ${relativePath} 失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
      setImporting(null);
    }
  };

  return (
    <div className="settings-overlay" role="presentation">
      <div
        ref={panelRef}
        className="settings-panel open-docx-panel"
        role="dialog"
        aria-modal="true"
        aria-label="打开 DOCX"
        aria-busy={importing !== null}
      >
        <header className="settings-head">
          <div>
            <h2>打开 DOCX</h2>
            <p>选择工作区中的 .docx 文件直接导入，无需经过模型。</p>
          </div>
          <button
            type="button"
            className="settings-close"
            disabled={importing !== null}
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <X size={18} />
          </button>
        </header>

        {files === null && !loadError ? (
          <p className="settings-msg" role="status">
            <RefreshCw size={14} className="spin" aria-hidden /> 正在列出工作区文件…
          </p>
        ) : null}

        {loadError ? (
          <p className="settings-msg err" role="alert">
            读取工作区文件失败:{loadError}{" "}
            <button type="button" className="linkish" onClick={load}>重试</button>
          </p>
        ) : null}

        {files !== null && !files.length ? (
          <div className="extensions-empty open-docx-empty">
            <FolderOpen size={18} aria-hidden />
            <p>工作区里没有 .docx 文件。把文件放进 imports/ 目录后重试。</p>
            <button type="button" className="linkish" onClick={load}>刷新列表</button>
          </div>
        ) : null}

        {files?.length ? (
          <ul className="open-docx-list">
            {files.map((file) => (
              <li key={file}>
                <button
                  type="button"
                  disabled={importing !== null}
                  onClick={() => void importFile(file)}
                >
                  <FileText size={15} aria-hidden />
                  <span>{file}</span>
                  {importing === file ? <em role="status">导入中…</em> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {importError ? <p className="settings-msg err" role="alert">{importError}</p> : null}
      </div>
    </div>
  );
}
