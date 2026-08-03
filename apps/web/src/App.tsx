import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Download, FolderOpen, MessageSquare, X } from "lucide-react";
import {
  api,
  isNativeDocx,
  listComments,
  listProposals,
  listReviewChecklists,
  saveSessionThreads,
  translateSelection,
  getSession,  type Block,
  type DocumentMeta,
  type LlmSettingsPublic,
  type SessionReviewThread,
  type SessionSnapshot,} from "./api";
import { Chat } from "./components/Chat";
import { AnchorRail } from "./components/AnchorRail";
import { McpApprovalDialog } from "./components/McpApprovalDialog";
import { OpenDocxDialog } from "./components/OpenDocxDialog";
import { RewritePrompt } from "./components/RewritePrompt";
import { SelectionBubble } from "./components/SelectionBubble";
import { SelectionMenu } from "./components/SelectionMenu";
import { SettingsHub } from "./components/SettingsHub";
import { SessionMenu } from "./components/SessionMenu";
import { ThreadPopover } from "./components/ThreadPopover";
import { TranslationPopover, type TranslationState } from "./components/TranslationPopover";
import type { CanvasFocusRequest } from "./components/canvasTypes";
import { clampFloatRect, defaultFloatRect, type FloatRect } from "./layoutGeometry";
import { MarginStoreProvider, useMarginStore, type ReviewThread, type SelectionInput, type ThreadAnchor } from "./store";
import { useWorkspaceActions } from "./useWorkspaceActions";
import { executableChatRetry } from "./chatRetry";
import { polishIntent, translationIntent } from "./selectionEditIntent";
import { selectionEditUnavailableReason } from "./selectionSafety";
import { clearChatAfterDirectDocumentOpen, resyncChatAfterAgentDocumentOpen } from "./documentChatSync";
import {
  canApplyDocumentImportResponse,
  sameDocumentIdentity,
  shouldPreserveDirtyDocumentOnImport,
} from "./documentSafety";
import {
  openThreadSelectionDisposition,
  proposalMatchesSelection,
  sameSelectionIdentity,
  sameTranslationSelectionIdentity,
  selectionAnchorAlive,
  selectionOwnedByOpenThread,
  selectionClearlyDivergedFromThread,
  shouldCancelTranslationForSelectionEvent,
} from "./selectionIdentity";

const Canvas = lazy(() =>
  import("./components/Canvas").then((module) => ({ default: module.Canvas })),
);

export function App() {
  return (
    <MarginStoreProvider>
      <Workspace />
    </MarginStoreProvider>
  );
}

function Workspace() {
  const store = useMarginStore();
  const storeRef = useRef(store);
  storeRef.current = store;
  const documentStateRef = useRef({
    key: `${store.doc?.id ?? "closed"}:${store.doc?.revision ?? "-"}:${store.documentDirty ? "dirty" : "clean"}`,
    generation: 0,
  });
  const chatDocumentIdRef = useRef(store.doc?.id ?? null);
  const sessionHydrationDocumentIdRef = useRef<string | null>(null);
  const documentStateKey = `${store.doc?.id ?? "closed"}:${store.doc?.revision ?? "-"}:${store.documentDirty ? "dirty" : "clean"}`;
  if (documentStateRef.current.key !== documentStateKey) {
    documentStateRef.current = {
      key: documentStateKey,
      generation: documentStateRef.current.generation + 1,
    };
  }
  const [layoutMode, setLayoutMode] = useState<"dock" | "float" | "focus">(() => {
    const saved = localStorage.getItem("margin_layout");
    return saved === "float" || saved === "focus" ? saved : "dock";
  });
  const [sidecarActivity, setSidecarActivity] = useState<"chat" | "review">("chat");
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<CanvasFocusRequest | null>(null);
  const [officeReady, setOfficeReady] = useState(false);
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [docxPickerOpen, setDocxPickerOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [dockWidth, setDockWidth] = useState(() => {
    const saved = localStorage.getItem("margin_dock_width");
    const parsed = saved === null ? Number.NaN : Number(saved);
    return Number.isFinite(parsed) ? Math.min(520, Math.max(320, parsed)) : 380;
  });
  const [floatRect, setFloatRect] = useState<FloatRect>(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    try {
      const saved = JSON.parse(localStorage.getItem("margin_float_rect") || "null") as Partial<FloatRect> | null;
      if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) {
        return clampFloatRect(saved as FloatRect, viewport);
      }
    } catch {
      // Ignore invalid local layout state.
    }
    return defaultFloatRect(viewport);
  });
  const saveDocumentRef = useRef<(() => Promise<boolean>) | null>(null);
  const actions = useWorkspaceActions({
    onSelectionRunStart: (anchor) => {
      storeRef.current.openThread({
        id: crypto.randomUUID(),
        anchor,
        pos: storeRef.current.selection.anchor,
        collapsed: false,
        createdAt: new Date().toISOString(),
      });
    },
    saveDocument: () => saveDocumentRef.current?.() ?? Promise.resolve(false),
  });
  const [themeMode, setThemeMode] = useState<"light" | "dark" | "system">(() => {
    const saved = localStorage.getItem("margin_theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [selectionClearToken, setSelectionClearToken] = useState(0);
  const [translation, setTranslation] = useState<TranslationState | null>(null);
  const translationRequestRef = useRef(0);
  const translationAbortRef = useRef<AbortController | null>(null);
  const cancelTranslation = useCallback(() => {
    translationRequestRef.current += 1;
    translationAbortRef.current?.abort();
    translationAbortRef.current = null;
    setTranslation(null);
  }, []);
  const clearSelectionEverywhere = () => {
    cancelTranslation();
    store.clearSelection();
    setSelectionClearToken((value) => value + 1);
  };

  useEffect(() => localStorage.setItem("margin_layout", layoutMode), [layoutMode]);
  useEffect(() => {
    setSidecarActivity("chat");
  }, [store.doc?.id]);
  useEffect(() => {
    cancelTranslation();
  }, [store.doc?.id, store.doc?.revision, cancelTranslation]);
  useEffect(() => () => {
    translationRequestRef.current += 1;
    const controller = translationAbortRef.current;
    translationAbortRef.current = null;
    controller?.abort();
  }, []);
  useEffect(() => localStorage.setItem("margin_dock_width", String(dockWidth)), [dockWidth]);
  useEffect(() => {
    const persist = window.setTimeout(() => {
      if (window.innerWidth > 960) {
        localStorage.setItem("margin_float_rect", JSON.stringify(floatRect));
      }
    }, 180);
    return () => window.clearTimeout(persist);
  }, [floatRect]);
  useEffect(() => {
    const clamp = () => {
      if (window.innerWidth <= 960) return;
      setFloatRect((rect) => {
        return clampFloatRect(rect, { width: window.innerWidth, height: window.innerHeight });
      });
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  useEffect(() => {
    // 仅在换文档时重置 ready；revision 变化（手动保存/accept）由 OfficeCanvas
    // 自己在重载前后回调 onReadyChange(false/true)。手动保存不重载画布
    // （loadedRevisionRef 预同步），若在此按 revision 重置会让 ready 永久卡 false，
    // ReviewPanel 的 reviewBusy 随之卡死（保存后 Y/N/E 全部禁用）。
    setOfficeReady(false);
  }, [store.doc?.id]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = themeMode === "system"
        ? media.matches ? "dark" : "light"
        : themeMode;
      document.documentElement.dataset.themeMode = themeMode;
    };
    localStorage.setItem("margin_theme", themeMode);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themeMode]);

  const beginDockResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 960) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = dockWidth;
    const move = (next: PointerEvent) => {
      setDockWidth(Math.min(520, Math.max(320, startWidth + startX - next.clientX)));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    window.addEventListener("blur", finish, { once: true });
  };

  const beginFloatDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (layoutMode !== "float" || window.innerWidth <= 960) return;
    if ((event.target as Element).closest("button, textarea, input, select, a")) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, rect: floatRect };
    const move = (next: PointerEvent) => {
      setFloatRect((rect) => ({
        ...rect,
        x: Math.max(8, Math.min(window.innerWidth - rect.width - 8, start.rect.x + next.clientX - start.x)),
        y: Math.max(8, Math.min(window.innerHeight - rect.height - 8, start.rect.y + next.clientY - start.y)),
      }));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    window.addEventListener("blur", finish, { once: true });
  };

  const beginFloatResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (layoutMode !== "float" || window.innerWidth <= 960) return;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY, rect: floatRect };
    const move = (next: PointerEvent) => {
      setFloatRect((rect) => ({
        ...rect,
        width: Math.min(window.innerWidth - start.rect.x - 8, Math.max(340, start.rect.width + next.clientX - start.x)),
        height: Math.min(window.innerHeight - start.rect.y - 8, Math.max(360, start.rect.height + next.clientY - start.y)),
      }));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    window.addEventListener("blur", finish, { once: true });
  };

  /** Shared hydrate for boot / 新会话 / 恢复历史会话 / 清空记录 (identical snapshot shape). */
  const applySessionSnapshot = async (
    session: SessionSnapshot,
    opts?: { keepEmptyMessages?: boolean },
  ) => {
    if (session.llm) storeRef.current.setLlm(session.llm);
    storeRef.current.setContextUsage(session.context ?? null);
    if (typeof session.clarificationRounds === "number") {
      storeRef.current.setClarificationRounds(session.clarificationRounds);
    }
    const restoredThreadIds = new Set(
      (session.opened ? session.review?.threads ?? [] : [])
        .filter((thread) => thread.documentId === session.opened?.document.id)
        .map((thread) => thread.id),
    );
    const turns = session.chat?.turns?.filter((turn) =>
      turn.text?.trim() && (!turn.threadId || restoredThreadIds.has(turn.threadId)),
    ) ?? [];
    const hydratedMessages: import("./components/Chat").ChatMessage[] = turns.map((t) => ({
      id: crypto.randomUUID(),
      role: t.role,
      text: t.text,
      threadId: t.threadId,
    }));
    if (session.task) {
      if (session.task.status === "interrupted") {
        hydratedMessages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          text: `上轮任务已中断：${session.task.objective}`,
          task: session.task,
        });
      } else {
        let lastAssistant = -1;
        for (let index = hydratedMessages.length - 1; index >= 0; index -= 1) {
          if (hydratedMessages[index]?.role === "assistant") {
            lastAssistant = index;
            break;
          }
        }
        if (lastAssistant >= 0) hydratedMessages[lastAssistant] = {
          ...hydratedMessages[lastAssistant],
          task: session.task,
        };
      }
    }
    // Chat is authoritative in the snapshot and must not wait on proposal/comment refreshes.
    if (hydratedMessages.length || !opts?.keepEmptyMessages) {
      storeRef.current.setMessages(hydratedMessages);
    }
    if (session.opened) {
      const currentDocument = storeRef.current.doc;
      const preserveDocumentDirty = Boolean(
        storeRef.current.documentDirty &&
          sameDocumentIdentity(currentDocument, session.opened.document),
      );
      if (currentDocument && currentDocument.id !== session.opened.document.id) {
        sessionHydrationDocumentIdRef.current = session.opened.document.id;
      }
      storeRef.current.setDocBundle(session.opened.document, session.opened.blocks, {
        preserveDocumentDirty,
      });
      const [proposals, comments, checklists] = await Promise.all([
        listProposals(session.opened.document.id),
        listComments(session.opened.document.id),
        listReviewChecklists(session.opened.document.id),
      ]);
      if (
        storeRef.current.doc?.id !== session.opened.document.id ||
        storeRef.current.doc.revision !== session.opened.document.revision
      ) return;
      storeRef.current.setProposals(proposals.proposals);
      storeRef.current.setComments(comments.comments ?? []);
      storeRef.current.setChecklists(checklists.runs);
      storeRef.current.setThreads((session.review?.threads ?? [])
        .filter((thread) => thread.documentId === session.opened?.document.id)
        .map((thread) => ({
          id: thread.id,
          anchor: thread.anchor,
          pos: null,
          collapsed: true,
          createdAt: thread.createdAt,
        })));
      const interruptedBlockId = session.task?.status === "interrupted"
        ? session.task.selection?.blockIds[0]
        : undefined;
      if (interruptedBlockId) {
        storeRef.current.setSelection({
          blockId: interruptedBlockId,
          text: session.task?.selection?.text ?? "",
          selectionStart: session.task?.selection?.start,
          anchor: null,
        });
      } else if (!storeRef.current.selection.blockId) {
        const thread = [...proposals.proposals].reverse().find((proposal) =>
          proposal.operation?.scope === "selection" || proposal.tableCell,
        );
        if (thread?.operation?.selection) {
          storeRef.current.setSelection({
            blockId: thread.blockId,
            text: thread.operation.selection.before,
            selectionStart: thread.operation.selection.start,
            anchor: null,
          });
        } else if (thread?.tableCell) {
          storeRef.current.setSelection({
            blockId: thread.blockId,
            text: thread.tableCell.before,
            selectionStart: 0,
            tableCell: thread.tableCell,
            anchor: null,
          });
        }
      }
    } else if (storeRef.current.doc) {
      // The target session has no open document — close the canvas too.
      storeRef.current.clearDocument();
    }
    if (session.sourcePaths) storeRef.current.setSourcePaths(session.sourcePaths);
  };

  useEffect(() => {
    const currentDocumentId = store.doc?.id ?? null;
    const previousDocumentId = chatDocumentIdRef.current;
    chatDocumentIdRef.current = currentDocumentId;
    if (
      !sessionHydrated ||
      !previousDocumentId ||
      !currentDocumentId ||
      previousDocumentId === currentDocumentId
    ) return;
    if (sessionHydrationDocumentIdRef.current === currentDocumentId) {
      sessionHydrationDocumentIdRef.current = null;
      return;
    }
    void resyncChatAfterAgentDocumentOpen({
      previousDocumentId,
      nextDocumentId: currentDocumentId,
      clearMessages: () => storeRef.current.setMessages([]),
      loadSnapshot: getSession,
      applySnapshot: async (session) => {
        if (storeRef.current.doc?.id !== currentDocumentId) return;
        await applySessionSnapshot(session);
      },
    }).catch(actions.messageError);
  }, [sessionHydrated, store.doc?.id]);

  useEffect(() => {
    let active = true;
    const sessionGeneration = documentStateRef.current.generation;
    void getSession()
      .then(async (session) => {
        if (!active || documentStateRef.current.generation !== sessionGeneration) return;
        await applySessionSnapshot(session, { keepEmptyMessages: true });
        if (active) setSessionHydrated(true);
      })
      .catch((error) => {
        if (active) store.setBootError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  const threadSyncKey = JSON.stringify(store.threads.map((thread) => ({
    id: thread.id,
    anchor: thread.anchor,
    collapsed: thread.collapsed,
    createdAt: thread.createdAt,
  })));
  useEffect(() => {
    const documentId = store.doc?.id;
    if (!sessionHydrated || !documentId) return;
    const threads = store.threads.map((thread) => ({
      id: thread.id,
      anchor: thread.anchor,
      collapsed: thread.collapsed,
      createdAt: thread.createdAt,
    }));
    const timer = window.setTimeout(() => {
      void saveSessionThreads(documentId, threads).catch((error) => {
        console.error("Failed to persist review threads", error);
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [sessionHydrated, store.doc?.id, threadSyncKey]);

  if (store.bootError) {
    return (
      <div className="boot-error">
        <h1 className="brand">Margin</h1>
        <p>无法连接本地 Agent：{store.bootError}</p>
        <p className="hint">请运行 pnpm mvp，并用带 token 的链接打开。</p>
      </div>
    );
  }

  const activeDocument = store.doc;
  const title = activeDocument?.relativePath.replace(/^.*[\\/]/, "") || "";
  const landing = !activeDocument;
  const workspaceStyle = { "--sidecar-width": `${dockWidth}px` } as CSSProperties;
  const sidecarStyle = !landing && layoutMode === "float"
    ? { left: floatRect.x, top: floatRect.y, width: floatRect.width, height: floatRect.height }
    : undefined;
  const activeThread = store.threads.find((thread) => thread.id === store.activeThreadId) ?? null;
  const popoverOpen = Boolean(activeDocument && activeThread && !activeThread.collapsed);
  const threadRetry = activeThread && !store.busy
    ? executableChatRetry({
        messages: store.messages,
        currentDocument: activeDocument
          ? { id: activeDocument.id, revision: activeDocument.revision }
          : undefined,
        documentDirty: store.documentDirty,
        currentThreadIds: store.threads.map((thread) => thread.id),
      })
    : null;
  const threadRetryMessageId = threadRetry && threadRetry.threadId === activeThread?.id
    ? threadRetry.errorMessageId
    : undefined;
  const revealThread = (thread: ReviewThread) => {
    // The popover owns this selection's review actions; keep the sidecar on
    // the global conversation so the same proposal never has two action surfaces.
    setSidecarActivity("chat");
    store.focusThread(thread.id);
    const query = thread.anchor.tableCell?.before || thread.anchor.selectionText;
    if (query.trim()) {
      const proposalId = store.proposals.find((proposal) =>
        proposalMatchesSelection(proposal, thread.anchor),
      )?.id;
      setFocusRequest({
        key: `${thread.id}:${Date.now()}`,
        query,
        proposalId,
        threadId: thread.id,
        blockId: thread.anchor.blockId,
        tableCell: thread.anchor.tableCell,
      });
    }
  };
  const openBlockAnchor = (anchor: ThreadAnchor) => {
    store.openThread({
      id: crypto.randomUUID(),
      anchor,
      pos: null,
      collapsed: false,
      createdAt: new Date().toISOString(),
    });
    const query = anchor.tableCell?.before || anchor.selectionText;
    if (query.trim()) {
      const proposalId = store.proposals.find((proposal) =>
        proposalMatchesSelection(proposal, anchor),
      )?.id;
      setFocusRequest({
        key: `anchor:${Date.now()}`,
        query,
        proposalId,
        blockId: anchor.blockId,
        tableCell: anchor.tableCell,
      });
    }
  };
  const threadAnchorAlive = !activeThread || selectionAnchorAlive(activeThread.anchor, store.blocks);
  // Stable handler: Canvas memo can cache-hit across App renders; only storeRef is fresh.
  const onCanvasSelectionChange = useCallback((event: SelectionInput & {
    programmaticThreadId?: string;
    userInitiated?: boolean;
  }) => {
    const current = storeRef.current;
    const { programmaticThreadId, userInitiated = false, ...selection } = event;
    const sameSelection = Boolean(
      current.selection.blockId &&
      selection.blockId &&
      sameTranslationSelectionIdentity({
        blockId: current.selection.blockId,
        selectionText: current.selection.text,
        selectionStart: current.selection.selectionStart,
        selectionRanges: current.selection.selectionRanges,
        tableCell: current.selection.tableCell,
      }, {
        blockId: selection.blockId,
        selectionText: selection.text,
        selectionStart: selection.selectionStart,
        selectionRanges: selection.selectionRanges,
        tableCell: selection.tableCell,
      }),
    );
    const openThread = current.activeThreadId
      ? current.threads.find((candidate) => candidate.id === current.activeThreadId)
      : null;
    const threadDisposition = openThread && !openThread.collapsed
      ? openThreadSelectionDisposition(openThread, {
          ...selection,
          programmaticThreadId,
          userInitiated,
        })
      : "selection";
    if (threadDisposition === "ignore") return;
    if (shouldCancelTranslationForSelectionEvent(sameSelection, threadDisposition)) {
      cancelTranslation();
    }
    if (openThread && threadDisposition === "thread") {
      current.setSelection({
        blockId: openThread.anchor.blockId,
        blockIds: openThread.anchor.blockIds,
        selectionRanges: openThread.anchor.selectionRanges,
        text: openThread.anchor.selectionText,
        selectionStart: openThread.anchor.selectionStart,
        tableCell: openThread.anchor.tableCell,
        crossTableCells: openThread.anchor.crossTableCells,
        anchor: selection.anchor,
      });
      if (selection.anchor) current.updateThreadPosition(openThread.id, selection.anchor);
      return;
    }
    current.setSelection(selection);
    // Selecting a different span while a thread is open should return the floating
    // tools — otherwise the bubble stays hidden behind popoverOpen forever.
    // Compare block+text only so precise-start probes do not collapse the thread.
    if (
      openThread &&
      !openThread.collapsed &&
      selectionClearlyDivergedFromThread(openThread.anchor, selection)
    ) {
      current.collapseThread(openThread.id);
    }
    if (!selection.anchor || !selection.blockId) return;
    const thread = current.threads.find((candidate) =>
      sameSelectionIdentity(candidate.anchor, {
        blockId: selection.blockId!,
        selectionRanges: selection.selectionRanges,
        selectionText: selection.text,
        selectionStart: selection.selectionStart,
        tableCell: selection.tableCell,
      }),
    );
    if (thread) current.updateThreadPosition(thread.id, selection.anchor);
  }, [cancelTranslation]);

  const startTranslation = useCallback(() => {
    const current = storeRef.current;
    const anchor = current.selection.anchor;
    const source = current.selection.rawText ?? current.selection.text;
    if (!anchor || !source.trim()) return;
    current.setMenu(null);
    translationAbortRef.current?.abort();
    const controller = new AbortController();
    translationAbortRef.current = controller;
    const requestId = ++translationRequestRef.current;
    const target = translationIntent(source).targetLanguage ?? "zh-CN";
    setTranslation({ anchor: { ...anchor }, source, status: "loading" });
    void translateSelection(source, target, controller.signal)
      .then((data) => {
        if (translationRequestRef.current !== requestId) return;
        setTranslation({
          anchor: { ...anchor },
          source,
          status: "done",
          result: data.translation,
        });
      })
      .catch((reason) => {
        if (translationRequestRef.current !== requestId) return;
        setTranslation({
          anchor: { ...anchor },
          source,
          status: "error",
          error: reason instanceof Error ? reason.message : String(reason),
        });
      })
      .finally(() => {
        if (translationRequestRef.current === requestId && translationAbortRef.current === controller) {
          translationAbortRef.current = null;
        }
      });
  }, []);

  const onSaveHandlerChange = useCallback((save: (() => Promise<boolean>) | null) => {
    saveDocumentRef.current = save;
  }, []);

  const onMarkNotice = useCallback((textNotice: string) => {
    storeRef.current.appendMessage({ id: crypto.randomUUID(), role: "assistant", text: textNotice });
  }, []);

  const onDocumentSaved = useCallback((document: DocumentMeta, blocks: Block[]) => {
    const current = storeRef.current;
    current.setDocBundle(document, blocks);
    // A successful native save supersedes every pending proposal on
    // the server. Clear stale cards immediately; the refresh below
    // remains authoritative for comments and any future statuses.
    current.setProposals([]);
    void Promise.all([
      listProposals(document.id),
      listComments(document.id),
      listReviewChecklists(document.id),
    ])
      .then(([proposals, comments, checklists]) => {
        if (storeRef.current.doc?.id !== document.id || storeRef.current.doc.revision !== document.revision) return;
        storeRef.current.setProposals(proposals.proposals);
        storeRef.current.setComments(comments.comments ?? []);
        storeRef.current.setChecklists(checklists.runs);
      })
      .catch((error) => {
        storeRef.current.appendMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          text: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  return (
    <div className={`app ${landing ? "chat-only" : `with-doc layout-${layoutMode}`}`} style={workspaceStyle}>
      {activeDocument ? (
        <section className="canvas-pane">
          <header className="doc-bar">
            <div className="doc-heading">
              <span className="doc-title" title={activeDocument.relativePath}>{title}</span>
              {store.documentDirty ? <span className="doc-dirty">未保存</span> : null}
              {!store.documentDirty && store.proposals.length ? (
                <button
                  type="button"
                  className="doc-pending"
                  onClick={() => {
                    setSidecarActivity("review");
                    if (layoutMode === "focus") setLayoutMode("float");
                  }}
                >{store.proposals.length} 处待审</button>
              ) : null}
            </div>
            <div className="doc-bar-actions">
              <button
                type="button"
                className="icon-button"
                title="打开 DOCX"
                aria-label="打开 DOCX"
                disabled={store.busy}
                onClick={() => setDocxPickerOpen(true)}
              >
                <FolderOpen size={17} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="icon-button"
                title="导出 Word"
                aria-label="导出 Word"
                disabled={store.busy || store.documentDirty}
                onClick={() => void actions.exportWord().catch(actions.messageError)}
              >
                <Download size={17} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="icon-button close-document"
                title="关闭文稿"
                aria-label="关闭文稿"
                disabled={store.busy}
                onClick={() => void actions.closeDocument().catch(actions.messageError)}
              >
                <X size={17} strokeWidth={1.8} />
              </button>
            </div>
          </header>
          <Suspense
            fallback={
              <div className="paper">
                <p className="empty-paper">正在打开文稿…</p>
              </div>
            }
          >
          <Canvas
              document={activeDocument}
              blocks={store.blocks}
              proposals={store.proposals}
              comments={store.comments}
              busy={store.busy}
              statusLine=""
              activeProposalId={activeProposalId}
              focusRequest={focusRequest}
              onAccept={actions.onAccept}
              onEdit={actions.onEdit}
              onUndo={actions.onUndo}
              onMarkNotice={onMarkNotice}
              onRewrite={(proposalId, blockId) =>
                void actions.onRewriteProposal(proposalId, blockId).catch(actions.messageError)
              }
              onSelectionChange={onCanvasSelectionChange}
              onContextMenu={store.setMenu}
              onDirtyChange={store.setDocumentDirty}
              onSaveHandlerChange={onSaveHandlerChange}
              clearSelectionSignal={selectionClearToken}
              onDocumentSaved={onDocumentSaved}
              onReadyChange={setOfficeReady}
            />
          </Suspense>
          <AnchorRail
            blocks={store.blocks}
            threads={store.threads}
            proposals={store.proposals}
            comments={store.comments}
            activeThreadId={store.activeThreadId}
            onOpenThread={revealThread}
            onOpenAnchor={openBlockAnchor}
          />
        </section>
      ) : null}
      <div
        className={`sidecar-shell${landing ? " landing-shell" : ""}`}
        style={sidecarStyle}
      >
        {!landing && layoutMode === "dock" ? (
          <div
            className="sidecar-dock-resizer"
            role="separator"
            aria-label="调整侧栏宽度"
            aria-orientation="vertical"
            aria-valuemin={320}
            aria-valuemax={520}
            aria-valuenow={Math.round(dockWidth)}
            tabIndex={0}
            onPointerDown={beginDockResize}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setDockWidth((width) => Math.min(520, Math.max(320, width + (event.key === "ArrowLeft" ? 16 : -16))));
            }}
          />
        ) : null}
      <Chat
        messages={store.messages}
        busy={store.busy}
        statusHint={store.statusLine}
        landing={landing}
        docTitle={title || undefined}
        documentPath={activeDocument?.relativePath}
        documentId={activeDocument?.id}
        documentRevision={activeDocument?.revision}
        llmMode={store.llm?.llmMode ?? (store.llm?.provider?.apiKeySet ? "byok" : "mock")}
        contextUsage={store.contextUsage}
        selectionHint={
          (store.selection.rawText ?? store.selection.text).trim()
            ? (store.selection.rawText ?? store.selection.text).trim().slice(0, 48) + ((store.selection.rawText ?? store.selection.text).length > 48 ? "…" : "")
            : undefined
        }
        selectionBlockCount={
          store.selection.blockIds?.length ?? (store.selection.blockId ? 1 : 0)
        }
        sourcePaths={store.sourcePaths}
        onToggleSourcePath={actions.onToggleSourcePath}
        cascadeOffer={store.cascadeOffer}
        onCascadeLocalOnly={actions.onCascadeLocalOnly}
        onCascadeConfirm={actions.onCascadeConfirm}
        composerPrefill={store.composerPrefill}
        onComposerPrefillConsumed={() => store.setComposerPrefill(null)}
        onSend={actions.onSend}
        onCancel={actions.canCancel ? actions.cancelCurrentRun : undefined}
        onContinueTask={() => void actions.onSend("继续").catch(actions.messageError)}
        onRetryChat={(errorMessageId) => void actions.onRetryChat(errorMessageId)}
        onOpenSettings={() => store.setSettingsOpen(true)}
        onOpenSessions={() => setSessionsOpen(true)}
        onOpenDocx={() => setDocxPickerOpen(true)}
        onClearSelection={clearSelectionEverywhere}
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
        activity={sidecarActivity}
        onActivityChange={(activity) => {
          setSidecarActivity(activity);
          if (activity !== "review") setActiveProposalId(null);
        }}
        proposals={store.proposals}
        comments={store.comments}
        checklists={store.checklists}
        documentDirty={store.documentDirty}
        reviewError={store.reviewError}
        reviewBusy={Boolean(activeDocument && isNativeDocx(activeDocument) && !officeReady)}
        onAccept={actions.onAccept}
        onEdit={actions.onEdit}
        onUndo={actions.onUndo}
        onRewrite={(proposalId, blockId) => void actions.onRewriteProposal(proposalId, blockId).catch(actions.messageError)}
        onActiveProposalChange={setActiveProposalId}
        threads={store.threads}
        activeThreadId={store.activeThreadId}
        onOpenThread={revealThread}
        onChecklistDecision={actions.onChecklistDecision}
        onLocateChecklistItem={(item) => {
          const block = storeRef.current.blocks.find((candidate) => candidate.id === item.blockId);
          const query = item.excerpt.trim() || block?.text.slice(0, 160) || "";
          if (!query) return;
          setFocusRequest({
            key: `checklist:${item.id}:${Date.now()}`,
            query,
            blockId: item.blockId,
          });
        }}
        onHeaderPointerDown={beginFloatDrag}
        themeMode={themeMode}
        onThemeModeChange={setThemeMode}
      />
        {!landing && layoutMode === "float" ? <div className="sidecar-float-resizer" aria-hidden onPointerDown={beginFloatResize} /> : null}
      </div>
      {!landing && layoutMode === "focus" ? (
        <button
          type="button"
          className="sidecar-launcher"
          aria-label={store.proposals.length ? `打开审阅，${store.proposals.length} 处待确认` : "打开对话"}
          title={store.proposals.length ? "打开审阅" : "打开对话"}
          onClick={() => {
            setSidecarActivity(store.proposals.length ? "review" : "chat");
            setLayoutMode("float");
          }}
        >
          <MessageSquare />
          {store.proposals.length ? <span>{store.proposals.length}</span> : null}
        </button>
      ) : null}
      <SettingsHub
        open={store.settingsOpen}
        initialTab="model"
        onClose={() => store.setSettingsOpen(false)}
        onSaved={(settings) => {
          store.setLlm(settings);
          void getSession()
            .then((session) => storeRef.current.setContextUsage(session.context ?? null))
            .catch(() => storeRef.current.setContextUsage(null));
        }}
      />
      <SessionMenu
        open={sessionsOpen}
        busy={store.busy}
        documentDirty={store.documentDirty}
        onClose={() => setSessionsOpen(false)}
        onApplySnapshot={applySessionSnapshot}
      />
      <OpenDocxDialog
        open={docxPickerOpen}
        documentDirty={store.documentDirty}
        documentGeneration={documentStateRef.current.generation}
        expectedDocument={store.doc ? { id: store.doc.id, revision: store.doc.revision } : null}
        onClose={() => setDocxPickerOpen(false)}
        onOpened={(document, blocks, report, requestDocumentGeneration) => {
          if (!canApplyDocumentImportResponse(
            requestDocumentGeneration,
            documentStateRef.current.generation,
          )) return false;
          if (shouldPreserveDirtyDocumentOnImport(
            storeRef.current.doc,
            document,
            storeRef.current.documentDirty,
          )) return true;
          clearChatAfterDirectDocumentOpen(
            storeRef.current.doc?.id,
            document.id,
            storeRef.current.setMessages,
          );
          store.setDocBundle(document, blocks);
          void Promise.all([
            listProposals(document.id),
            listComments(document.id),
            listReviewChecklists(document.id),
          ])
            .then(([proposals, comments, checklists]) => {
              if (storeRef.current.doc?.id !== document.id || storeRef.current.doc.revision !== document.revision) return;
              store.setProposals(proposals.proposals);
              store.setComments(comments.comments ?? []);
              store.setChecklists(checklists.runs);
            })
            .catch(actions.messageError);
          if (report && !report.ok) {
            store.appendMessage({
              id: crypto.randomUUID(),
              role: "assistant",
              text: `已导入 ${document.relativePath}，但结构检查有告警：${(report.flags ?? []).join("、") || "未知"}`,
            });
          }
          return true;
        }}
      />
      <McpApprovalDialog
        approval={actions.pendingMcpApproval}
        onDecision={actions.resolvePendingMcpApproval}
      />
      <RewritePrompt
        open={!!store.rewritePrompt}
        excerpt={store.rewritePrompt?.excerpt}
        busy={store.busy}
        onCancel={() => store.setRewritePrompt(null)}
        onSubmit={(instruction) => {
          const blockId = store.rewritePrompt?.blockId;
          const selectionText = store.rewritePrompt?.selectionText ?? "";
          const selectionStart = store.rewritePrompt?.selectionStart;
          const tableCell = store.rewritePrompt?.tableCell;
          const crossTableCells = store.rewritePrompt?.crossTableCells;
          const selectionRanges = store.rewritePrompt?.selectionRanges;
          store.setRewritePrompt(null);
          if (blockId) {
            actions.dispatchSelection("rewrite_directed", blockId, selectionText, instruction, selectionStart, "rewrite", undefined, tableCell, store.rewritePrompt?.blockIds, crossTableCells, selectionRanges);
          }
        }}
      />
      {store.menu ? (
        <SelectionMenu
          x={store.menu.x}
          y={store.menu.y}
          editDisabled={Boolean(selectionEditUnavailableReason(store.menu))}
          editDisabledReason={selectionEditUnavailableReason(store.menu)}
          translationLabel={translationIntent(store.menu.text).targetLanguage === "en" ? "译为英文" : "译为中文"}
          onClose={() => store.setMenu(null)}
          onRewrite={() => actions.dispatchSelection(
            "rewrite",
            store.menu!.blockId,
            store.menu!.text,
            undefined,
            store.menu!.selectionStart,
            "rewrite",
            undefined,
            store.menu!.tableCell,
            store.menu!.blockIds,
            store.menu!.crossTableCells,
            store.menu!.selectionRanges,
          )}
          onRewriteDirected={() =>
            actions.dispatchSelection("rewrite_directed", store.menu!.blockId, store.menu!.text, undefined, store.menu!.selectionStart, "rewrite", undefined, store.menu!.tableCell, store.menu!.blockIds, store.menu!.crossTableCells, store.menu!.selectionRanges)
          }
          onTranslate={startTranslation}
          onPolish={() =>
            actions.dispatchSelection(
              "rewrite_directed",
              store.menu!.blockId,
              store.menu!.text,
              polishIntent.instruction,
              store.menu!.selectionStart,
              polishIntent.operation,
              undefined,
              store.menu!.tableCell,
              store.menu!.blockIds,
              store.menu!.crossTableCells,
              store.menu!.selectionRanges,
            )
          }
          onDiscuss={() => {
            actions.dispatchSelection("discuss", store.menu!.blockId, store.menu!.text, undefined, undefined, undefined, undefined, store.menu!.tableCell, store.menu!.blockIds, store.menu!.crossTableCells, store.menu!.selectionRanges);
          }}
        />
      ) : null}
      <SelectionBubble
        visible={
          !!store.selection.anchor &&
          !!store.selection.text.trim() &&
          !store.menu &&
          !store.busy &&
          !store.rewritePrompt &&
          !translation &&
          !(popoverOpen && selectionOwnedByOpenThread(activeThread?.anchor, store.selection))
        }
        x={store.selection.anchor?.x ?? 0}
        y={store.selection.anchor?.y ?? 0}
        busy={store.busy}
        minY={activeDocument && isNativeDocx(activeDocument) ? 122 : 12}
        editDisabled={Boolean(selectionEditUnavailableReason(store.selection))}
        editDisabledReason={selectionEditUnavailableReason(store.selection)}
        translationLabel={translationIntent(store.selection.text).targetLanguage === "en" ? "译英" : "译中"}
        onRewrite={() => actions.dispatchSelection(
          "rewrite",
          store.selection.blockId,
          store.selection.text,
          undefined,
          store.selection.selectionStart,
          "rewrite",
          undefined,
          store.selection.tableCell,
          store.selection.blockIds,
          store.selection.crossTableCells,
          store.selection.selectionRanges,
        )}
        onTranslate={startTranslation}
        onDiscuss={() => {
          actions.dispatchSelection("discuss", store.selection.blockId, store.selection.text, undefined, store.selection.selectionStart, undefined, undefined, store.selection.tableCell, store.selection.blockIds, store.selection.crossTableCells, store.selection.selectionRanges);
        }}
        onMore={() => {
          cancelTranslation();
          store.setMenu({
            x: store.selection.anchor?.x ?? window.innerWidth / 2,
            y: (store.selection.anchor?.y ?? 120) + 8,
            blockId: store.selection.blockId,
            blockIds: store.selection.blockIds,
            selectionRanges: store.selection.selectionRanges,
            text: store.selection.text,
            selectionStart: store.selection.selectionStart,
            tableCell: store.selection.tableCell,
            crossTableCells: store.selection.crossTableCells,
          });
        }}
      />
      {translation ? (
        <TranslationPopover
          translation={translation}
          onClose={cancelTranslation}
        />
      ) : null}
      {popoverOpen && activeThread ? (
        <ThreadPopover
          thread={activeThread}
          anchorAlive={threadAnchorAlive}
          proposals={store.proposals.filter((proposal) =>
            proposalMatchesSelection(proposal, activeThread.anchor),
          )}
          comments={store.comments.filter((comment) => comment.blockId === activeThread.anchor.blockId)}
          messages={store.messages.filter((message) => message.threadId === activeThread.id)}
          retryMessageId={threadRetryMessageId}
          busy={store.busy}
          statusLine={store.statusLine}
          dirty={store.documentDirty}
          onSend={(text) =>
            void actions.onSend(text, {
              threadId: activeThread.id,
              selection: {
                blockId: activeThread.anchor.blockId,
                blockIds: activeThread.anchor.blockIds,
                selectionRanges: activeThread.anchor.selectionRanges,
                text: activeThread.anchor.selectionText,
                selectionStart: activeThread.anchor.selectionStart,
                tableCell: activeThread.anchor.tableCell,
                crossTableCells: activeThread.anchor.crossTableCells,
              },
            }).catch(actions.messageError)
          }
          onRetry={(messageId) => void actions.onRetryChat(messageId)}
          onAccept={async (proposalId) => {
            const wasLast = storeRef.current.proposals.filter(
              (proposal) => proposalMatchesSelection(proposal, activeThread.anchor),
            ).length <= 1;
            const result = await actions.onAccept(proposalId);
            if (result !== false && wasLast) storeRef.current.collapseThread(activeThread.id);
            return result;
          }}
          onEdit={async (proposalId, editedText) => {
            const wasLast = storeRef.current.proposals.filter(
              (proposal) => proposalMatchesSelection(proposal, activeThread.anchor),
            ).length <= 1;
            const result = await actions.onEdit(proposalId, editedText);
            if (result !== false && wasLast) storeRef.current.collapseThread(activeThread.id);
            return result;
          }}
          onUndo={async (proposalId) => {
            const wasLast = storeRef.current.proposals.filter(
              (proposal) => proposalMatchesSelection(proposal, activeThread.anchor),
            ).length <= 1;
            const result = await actions.onUndo(proposalId);
            if (result !== false && wasLast) storeRef.current.collapseThread(activeThread.id);
            return result;
          }}
          onRewrite={(proposalId, blockId) => void actions.onRewriteProposal(proposalId, blockId).catch(actions.messageError)}
          onCollapse={() => store.collapseThread(activeThread.id)}
          onClose={() => store.closeThread(activeThread.id)}
        />
      ) : null}
    </div>
  );
}
