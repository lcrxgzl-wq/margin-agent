import type { DocumentMeta } from "./api";

export const UNSAVED_DOCUMENT_REPLACEMENT_MESSAGE =
  "当前文稿有未保存的修改。继续打开文稿后这些修改会丢失，仍要继续吗？";

export const ASYNC_DOCUMENT_CONFLICT_MESSAGE =
  "请求期间文稿已被编辑、保存或切换。为避免覆盖，已保留当前画布；请先保存或另存当前修改，再重新打开文稿同步结果。";

function workspacePathKey(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

export function sameDocumentIdentity(
  current: Pick<DocumentMeta, "id" | "relativePath"> | null | undefined,
  next: Pick<DocumentMeta, "id" | "relativePath"> | null | undefined,
): boolean {
  return Boolean(
    current &&
      next &&
      current.id === next.id &&
      workspacePathKey(current.relativePath) === workspacePathKey(next.relativePath),
  );
}

export function confirmDocumentReplacement(
  documentDirty: boolean,
  confirm: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  return !documentDirty || confirm(UNSAVED_DOCUMENT_REPLACEMENT_MESSAGE);
}

/** Chat turns that only list workspace materials and do not replace the open document. */
export function isWorkspaceListChatIntent(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (/^(?:打开|open)\s*(文稿|文章|文件|文档|论文)?\s*$/i.test(text)) return true;
  return (
    /^(?:请)?(?:列出|查看|显示)(?:一下)?(?:工作区)?(?:有哪些)?(?:文件|文稿|文章)(?:列表)?[。！？!?]?$/i.test(text) ||
    /^(?:有哪些)(?:文件|文稿|文章)[。！？!?]?$/i.test(text) ||
    /^(?:list(?:\s+files)?|ls)[.!?]?$/i.test(text)
  );
}

/** Chat turns that open/import a document and may discard the current canvas. */
export function isDocumentReplacementChatIntent(message: string): boolean {
  const text = message.trim();
  if (!text || isWorkspaceListChatIntent(text)) return false;
  if (/^(?:样章|示范|示例)$/.test(text)) return true;
  if (/^(?:请)?(?:打开|open)\b/i.test(text) || /^(?:请)?打开/.test(text)) return true;
  if (/(?:导入|import)\b/i.test(text) && /\.docx(?:\b|["'`”》])/i.test(text)) return true;
  return false;
}

export function canApplyDocumentImportResponse(
  requestDocumentGeneration: number,
  currentDocumentGeneration: number,
): boolean {
  return requestDocumentGeneration === currentDocumentGeneration;
}

export function shouldPreserveDirtyDocumentOnImport(
  currentDocument: Pick<DocumentMeta, "id" | "relativePath"> | null,
  importedDocument: Pick<DocumentMeta, "id" | "relativePath">,
  documentDirty: boolean,
): boolean {
  return documentDirty && sameDocumentIdentity(currentDocument, importedDocument);
}

export function canApplyDocumentResponse(opts: {
  requestDocument: Pick<DocumentMeta, "id" | "relativePath" | "revision" | "contentHash"> | null;
  currentDocument: Pick<DocumentMeta, "id" | "relativePath" | "revision" | "contentHash"> | null;
  documentDirty: boolean;
  requestGeneration: number;
  currentGeneration: number;
}): boolean {
  if (opts.documentDirty || opts.currentGeneration > opts.requestGeneration) return false;
  if (!opts.requestDocument || !opts.currentDocument) {
    return opts.requestDocument === opts.currentDocument;
  }
  return (
    sameDocumentIdentity(opts.requestDocument, opts.currentDocument) &&
    opts.requestDocument.revision === opts.currentDocument.revision &&
    opts.requestDocument.contentHash === opts.currentDocument.contentHash
  );
}
