import { describe, expect, it, vi } from "vitest";
import {
  canApplyDocumentImportResponse,
  canApplyDocumentResponse,
  confirmDocumentReplacement,
  confirmSaveBeforeContinue,
  isDocumentReplacementChatIntent,
  isWorkspaceListChatIntent,
  sameDocumentIdentity,
  shouldPreserveDirtyDocumentOnImport,
  UNSAVED_DOCUMENT_CONTINUE_MESSAGE,
  UNSAVED_DOCUMENT_REPLACEMENT_MESSAGE,
} from "./documentSafety";

const documentA = {
  id: "doc-1",
  relativePath: "imports/draft.docx",
  revision: 3,
  contentHash: "hash-3",
};

describe("document replacement safety", () => {
  it("does not prompt for a clean document", () => {
    const confirm = vi.fn(() => false);
    expect(confirmDocumentReplacement(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("blocks a dirty document replacement when the author declines", () => {
    const confirm = vi.fn(() => false);
    expect(confirmDocumentReplacement(true, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(UNSAVED_DOCUMENT_REPLACEMENT_MESSAGE);
  });

  it("allows a dirty document replacement when the author confirms", () => {
    expect(confirmDocumentReplacement(true, () => true)).toBe(true);
  });

  it("asks to save-and-continue only when the canvas is dirty", () => {
    const confirm = vi.fn(() => true);
    expect(confirmSaveBeforeContinue(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmSaveBeforeContinue(true, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledWith(UNSAVED_DOCUMENT_CONTINUE_MESSAGE);
    expect(confirmSaveBeforeContinue(true, () => false)).toBe(false);
  });

  it("rejects an import response after the visible document state changes", () => {
    expect(canApplyDocumentImportResponse(4, 4)).toBe(true);
    expect(canApplyDocumentImportResponse(4, 5)).toBe(false);
  });

  it("keeps unsaved canvas edits when reopening the same document", () => {
    expect(shouldPreserveDirtyDocumentOnImport(
      documentA,
      { id: documentA.id, relativePath: "imports\\draft.docx" },
      true,
    )).toBe(true);
    expect(shouldPreserveDirtyDocumentOnImport(documentA, documentA, false)).toBe(false);
    expect(shouldPreserveDirtyDocumentOnImport(
      documentA,
      { id: "doc-2", relativePath: documentA.relativePath },
      true,
    )).toBe(false);
  });

  it("treats slash variants of the same document path as one document", () => {
    expect(sameDocumentIdentity(
      { id: "doc-1", relativePath: "imports\\draft.docx" },
      { id: "doc-1", relativePath: "imports/draft.docx" },
    )).toBe(true);
    expect(sameDocumentIdentity(
      { id: "doc-1", relativePath: "imports/draft.docx" },
      { id: "doc-2", relativePath: "imports/draft.docx" },
    )).toBe(false);
  });

  it("does not overwrite edits made while an async response is pending", async () => {
    let currentDocument = documentA;
    let documentDirty = false;
    let releaseResponse!: (document: typeof documentA) => void;
    const response = new Promise<typeof documentA>((resolve) => {
      releaseResponse = resolve;
    });
    const applied = response.then((nextDocument) => {
      if (canApplyDocumentResponse({
        requestDocument: documentA,
        currentDocument,
        documentDirty,
        requestGeneration: 4,
        currentGeneration: 4,
      })) {
        currentDocument = nextDocument;
        return true;
      }
      return false;
    });

    documentDirty = true;
    releaseResponse({ ...documentA, revision: 4, contentHash: "hash-4" });

    expect(await applied).toBe(false);
    expect(currentDocument).toBe(documentA);
  });

  it("rejects a stale response after a save, document switch, or newer request", () => {
    const baseline = {
      requestDocument: documentA,
      documentDirty: false,
      requestGeneration: 4,
      currentGeneration: 4,
    };
    expect(canApplyDocumentResponse({
      ...baseline,
      currentDocument: documentA,
    })).toBe(true);
    expect(canApplyDocumentResponse({
      ...baseline,
      currentDocument: { ...documentA, revision: 4, contentHash: "hash-4" },
    })).toBe(false);
    expect(canApplyDocumentResponse({
      ...baseline,
      currentDocument: { ...documentA, id: "doc-2" },
    })).toBe(false);
    expect(canApplyDocumentResponse({
      ...baseline,
      currentDocument: documentA,
      currentGeneration: 5,
    })).toBe(false);
  });

  it("does not let a landing-page response replace a document opened meanwhile", () => {
    expect(canApplyDocumentResponse({
      requestDocument: null,
      currentDocument: documentA,
      documentDirty: false,
      requestGeneration: 1,
      currentGeneration: 1,
    })).toBe(false);
  });

  it("allows list intents while dirty without treating them as replacements", () => {
    expect(isWorkspaceListChatIntent("有哪些文件")).toBe(true);
    expect(isWorkspaceListChatIntent("打开文稿")).toBe(true);
    expect(isDocumentReplacementChatIntent("有哪些文件")).toBe(false);
    expect(isDocumentReplacementChatIntent("打开文稿")).toBe(false);
  });

  it("treats open/import document turns as replacement intents", () => {
    expect(isDocumentReplacementChatIntent("打开 imports/sport value.docx")).toBe(true);
    expect(isDocumentReplacementChatIntent("打开样章")).toBe(true);
    expect(isDocumentReplacementChatIntent("open notes.md")).toBe(true);
  });
});
