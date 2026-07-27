import { createContext, useContext, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { Block, Comment, DocumentMeta, LlmSettingsPublic, Proposal } from "./api";
import type { ChatMessage } from "./components/Chat";
import type { TableCellSelection } from "./components/canvasTypes";

const MAX_VISIBLE_MESSAGES = 120;

export type Selection = {
  blockId: string | null;
  /** Every block covered by the range when the selection crosses blocks. */
  blockIds?: string[];
  text: string;
  selectionStart?: number;
  tableCell?: TableCellSelection;
  /** True when the range spans more than one table cell. */
  crossTableCells?: boolean;
  anchor: { x: number; y: number } | null;
};

export type SelectionInput = Omit<Selection, "anchor"> & {
  anchor?: { x: number; y: number } | null;
};

export type ContextMenu = {
  x: number;
  y: number;
  blockId: string | null;
  blockIds?: string[];
  text: string;
  selectionStart?: number;
  tableCell?: TableCellSelection;
  /** True when the range spans more than one table cell. */
  crossTableCells?: boolean;
};

export type RewritePromptState = {
  blockId: string;
  blockIds?: string[];
  excerpt: string;
  selectionText: string;
  selectionStart?: number;
  tableCell?: TableCellSelection;
  crossTableCells?: boolean;
};

export type ThreadAnchor = {
  blockId: string;
  blockIds?: string[];
  selectionText: string;
  selectionStart?: number;
  tableCell?: TableCellSelection;
  /** True when the range spans more than one table cell. */
  crossTableCells?: boolean;
};

export type ReviewThread = {
  id: string;
  anchor: ThreadAnchor;
  pos: { x: number; y: number } | null;
  collapsed: boolean;
  createdAt: string;
};

export type CascadeCandidate = {
  blockId: string;
  reason: string;
  query?: string;
};

function workspacePathKey(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

export type MarginState = {
  doc: DocumentMeta | null;
  blocks: Block[];
  proposals: Proposal[];
  comments: Comment[];
  llm: LlmSettingsPublic | null;
  selection: Selection;
  menu: ContextMenu | null;
  rewritePrompt: RewritePromptState | null;
  composerPrefill: string | null;
  settingsOpen: boolean;
  threads: ReviewThread[];
  activeThreadId: string | null;
  busy: boolean;
  statusLine: string;
  busyGen: number;
  messages: ChatMessage[];
  bootError: string | null;
  chatMode: "direct" | "socratic";
  clarificationRounds: number;
  cascadeOffer: CascadeCandidate[] | null;
  sourcePaths: string[];
  documentDirty: boolean;
  reviewError: string | null;
};

type Action =
  | { type: "setDocBundle"; doc: DocumentMeta; blocks: Block[] }
  | { type: "clearDocument" }
  | { type: "setProposals"; proposals: Proposal[] }
  | { type: "setComments"; comments: Comment[] }
  | { type: "appendMessage"; message: ChatMessage }
  | {
      type: "patchMessage";
      id: string;
      patch: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>);
    }
  | { type: "setMessages"; messages: ChatMessage[] }
  | { type: "beginBusy"; generation: number; label: string }
  | { type: "endBusy"; generation: number }
  | { type: "setSelection"; selection: Selection }
  | { type: "clearSelection" }
  | { type: "setMenu"; menu: ContextMenu | null }
  | { type: "setRewritePrompt"; rewritePrompt: RewritePromptState | null }
  | { type: "setComposerPrefill"; composerPrefill: string | null }
  | { type: "setSettingsOpen"; settingsOpen: boolean }
  | { type: "openThread"; thread: ReviewThread }
  | { type: "setThreads"; threads: ReviewThread[] }
  | { type: "focusThread"; threadId: string }
  | { type: "updateThreadPosition"; threadId: string; pos: { x: number; y: number } }
  | { type: "collapseThread"; threadId: string }
  | { type: "closeThread"; threadId: string }
  | { type: "setLlm"; llm: LlmSettingsPublic | null }
  | { type: "setBootError"; bootError: string | null }
  | { type: "setStatusLine"; statusLine: string }
  | { type: "setChatMode"; chatMode: "direct" | "socratic" }
  | { type: "setClarificationRounds"; clarificationRounds: number }
  | { type: "setCascadeOffer"; cascadeOffer: CascadeCandidate[] | null }
  | { type: "setSourcePaths"; sourcePaths: string[] }
  | { type: "toggleSourcePath"; relativePath: string }
  | { type: "clearSourcePaths" }
  | { type: "setDocumentDirty"; documentDirty: boolean }
  | { type: "setReviewError"; reviewError: string | null };

export const initialMarginState: MarginState = {
  doc: null,
  blocks: [],
  proposals: [],
  comments: [],
  llm: null,
  selection: { blockId: null, text: "", anchor: null },
  menu: null,
  rewritePrompt: null,
  composerPrefill: null,
  settingsOpen: false,
  threads: [],
  activeThreadId: null,
  busy: false,
  statusLine: "",
  busyGen: 0,
  messages: [
    {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "在。打开一篇稿，或先聊问题意识。",
    },
  ],
  bootError: null,
  chatMode: "direct",
  clarificationRounds: 0,
  cascadeOffer: null,
  sourcePaths: [],
  documentDirty: false,
  reviewError: null,
};

export function marginReducer(state: MarginState, action: Action): MarginState {
  switch (action.type) {
    case "setDocBundle": {
      const documentChanged = !state.doc ||
        state.doc.id !== action.doc.id ||
        workspacePathKey(state.doc.relativePath) !== workspacePathKey(action.doc.relativePath);
      const revisionChanged = documentChanged || state.doc?.revision !== action.doc.revision;
      return {
        ...state,
        doc: action.doc,
        blocks: action.blocks,
        proposals: documentChanged ? [] : state.proposals,
        comments: documentChanged ? [] : state.comments,
        threads: documentChanged ? [] : state.threads,
        activeThreadId: documentChanged ? null : state.activeThreadId,
        selection: revisionChanged ? initialMarginState.selection : state.selection,
        menu: revisionChanged ? null : state.menu,
        rewritePrompt: revisionChanged ? null : state.rewritePrompt,
        documentDirty: false,
        reviewError: null,
        sourcePaths:
          state.doc &&
          (state.doc.id !== action.doc.id ||
            workspacePathKey(state.doc.relativePath) !==
              workspacePathKey(action.doc.relativePath))
            ? []
            : state.sourcePaths.filter(
                (relativePath) =>
                  workspacePathKey(relativePath) !== workspacePathKey(action.doc.relativePath),
              ),
      };
    }
    case "clearDocument":
      return {
        ...state,
        doc: null,
        blocks: [],
        proposals: [],
        comments: [],
        selection: initialMarginState.selection,
        menu: null,
        rewritePrompt: null,
        composerPrefill: null,
        threads: [],
        activeThreadId: null,
        clarificationRounds: 0,
        cascadeOffer: null,
        sourcePaths: [],
        documentDirty: false,
        reviewError: null,
      };
    case "setProposals":
      return { ...state, proposals: action.proposals };
    case "setComments":
      return { ...state, comments: action.comments };
    case "appendMessage":
      return {
        ...state,
        messages: [...state.messages, action.message].slice(-MAX_VISIBLE_MESSAGES),
      };
    case "patchMessage":
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === action.id
            ? {
                ...message,
                ...(typeof action.patch === "function" ? action.patch(message) : action.patch),
              }
            : message,
        ),
      };
    case "setMessages":
      return { ...state, messages: action.messages.slice(-MAX_VISIBLE_MESSAGES) };
    case "beginBusy":
      return {
        ...state,
        busy: true,
        statusLine: action.label,
        busyGen: Math.max(state.busyGen, action.generation),
      };
    case "endBusy":
      return action.generation === state.busyGen
        ? { ...state, busy: false, statusLine: "" }
        : state;
    case "setSelection":
      return { ...state, selection: action.selection };
    case "clearSelection":
      return { ...state, selection: initialMarginState.selection, menu: null };
    case "setMenu":
      return { ...state, menu: action.menu };
    case "setRewritePrompt":
      return { ...state, rewritePrompt: action.rewritePrompt };
    case "setComposerPrefill":
      return { ...state, composerPrefill: action.composerPrefill };
    case "setSettingsOpen":
      return { ...state, settingsOpen: action.settingsOpen };
    case "openThread": {
      const existing = state.threads.find((thread) =>
        thread.anchor.blockId === action.thread.anchor.blockId &&
        thread.anchor.selectionText === action.thread.anchor.selectionText,
      );
      if (existing) {
        return {
          ...state,
          activeThreadId: existing.id,
          threads: state.threads.map((thread) =>
            thread.id === existing.id
              ? { ...thread, collapsed: false, pos: action.thread.pos ?? thread.pos }
              : thread,
          ),
        };
      }
      return {
        ...state,
        activeThreadId: action.thread.id,
        threads: [...state.threads, action.thread].slice(-24),
      };
    }
    case "setThreads":
      return {
        ...state,
        threads: action.threads.slice(-24),
        activeThreadId: null,
      };
    case "focusThread":
      return {
        ...state,
        activeThreadId: action.threadId,
        threads: state.threads.map((thread) =>
          thread.id === action.threadId ? { ...thread, collapsed: false } : thread,
        ),
      };
    case "updateThreadPosition": {
      const thread = state.threads.find((candidate) => candidate.id === action.threadId);
      if (!thread || (thread.pos?.x === action.pos.x && thread.pos.y === action.pos.y)) return state;
      return {
        ...state,
        threads: state.threads.map((candidate) =>
          candidate.id === action.threadId ? { ...candidate, pos: action.pos } : candidate,
        ),
      };
    }
    case "collapseThread":
      return {
        ...state,
        activeThreadId: state.activeThreadId === action.threadId ? null : state.activeThreadId,
        threads: state.threads.map((thread) =>
          thread.id === action.threadId ? { ...thread, collapsed: true } : thread,
        ),
      };
    case "closeThread":
      return {
        ...state,
        activeThreadId: state.activeThreadId === action.threadId ? null : state.activeThreadId,
        threads: state.threads.filter((thread) => thread.id !== action.threadId),
      };
    case "setLlm":
      return { ...state, llm: action.llm };
    case "setBootError":
      return { ...state, bootError: action.bootError };
    case "setStatusLine":
      return { ...state, statusLine: action.statusLine };
    case "setChatMode":
      return { ...state, chatMode: action.chatMode };
    case "setClarificationRounds":
      return { ...state, clarificationRounds: action.clarificationRounds };
    case "setCascadeOffer":
      return { ...state, cascadeOffer: action.cascadeOffer };
    case "setSourcePaths": {
      const documentKey = state.doc ? workspacePathKey(state.doc.relativePath) : "";
      const seen = new Set<string>();
      return {
        ...state,
        sourcePaths: action.sourcePaths.filter((relativePath) => {
          const key = workspacePathKey(relativePath);
          if (!key || key === documentKey || seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    }
    case "toggleSourcePath": {
      if (
        state.doc &&
        workspacePathKey(state.doc.relativePath) === workspacePathKey(action.relativePath)
      ) {
        return state;
      }
      const key = workspacePathKey(action.relativePath);
      const attached = state.sourcePaths.some(
        (relativePath) => workspacePathKey(relativePath) === key,
      );
      return {
        ...state,
        sourcePaths: attached
          ? state.sourcePaths.filter(
              (relativePath) => workspacePathKey(relativePath) !== key,
            )
          : [...state.sourcePaths, action.relativePath],
      };
    }
    case "clearSourcePaths":
      return state.sourcePaths.length ? { ...state, sourcePaths: [] } : state;
    case "setDocumentDirty":
      return state.documentDirty === action.documentDirty
        ? state
        : { ...state, documentDirty: action.documentDirty };
    case "setReviewError":
      return { ...state, reviewError: action.reviewError };
  }
}

type MarginStore = MarginState & {
  setDocBundle: (doc: DocumentMeta, blocks: Block[]) => void;
  clearDocument: () => void;
  setProposals: (proposals: Proposal[]) => void;
  setComments: (comments: Comment[]) => void;
  appendMessage: (message: ChatMessage) => void;
  patchMessage: (
    id: string,
    patch: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>),
  ) => void;
  setMessages: (messages: ChatMessage[]) => void;
  beginBusy: (label: string) => number;
  endBusy: (generation: number) => void;
  setSelection: (selection: SelectionInput) => void;
  clearSelection: () => void;
  setMenu: (menu: ContextMenu | null) => void;
  setRewritePrompt: (rewritePrompt: RewritePromptState | null) => void;
  setComposerPrefill: (composerPrefill: string | null) => void;
  setSettingsOpen: (settingsOpen: boolean) => void;
  openThread: (thread: ReviewThread) => void;
  setThreads: (threads: ReviewThread[]) => void;
  focusThread: (threadId: string) => void;
  updateThreadPosition: (threadId: string, pos: { x: number; y: number }) => void;
  collapseThread: (threadId: string) => void;
  closeThread: (threadId: string) => void;
  setLlm: (llm: LlmSettingsPublic | null) => void;
  setBootError: (bootError: string | null) => void;
  setStatusLine: (statusLine: string) => void;
  setChatMode: (chatMode: "direct" | "socratic") => void;
  setClarificationRounds: (clarificationRounds: number) => void;
  setCascadeOffer: (cascadeOffer: CascadeCandidate[] | null) => void;
  setSourcePaths: (sourcePaths: string[]) => void;
  toggleSourcePath: (relativePath: string) => void;
  clearSourcePaths: () => void;
  setDocumentDirty: (documentDirty: boolean) => void;
  setReviewError: (reviewError: string | null) => void;
};

type MarginActions = Omit<MarginStore, keyof MarginState>;

const MarginStoreContext = createContext<MarginStore | null>(null);

export function MarginStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(marginReducer, initialMarginState);
  const generation = useRef(0);
  const actions = useMemo<MarginActions>(
    () => ({
      setDocBundle: (doc, blocks) => dispatch({ type: "setDocBundle", doc, blocks }),
      clearDocument: () => dispatch({ type: "clearDocument" }),
      setProposals: (proposals) => dispatch({ type: "setProposals", proposals }),
      setComments: (comments) => dispatch({ type: "setComments", comments }),
      appendMessage: (message) => dispatch({ type: "appendMessage", message }),
      patchMessage: (id, patch) => dispatch({ type: "patchMessage", id, patch }),
      setMessages: (messages) => dispatch({ type: "setMessages", messages }),
      beginBusy: (label) => {
        const next = ++generation.current;
        dispatch({ type: "beginBusy", generation: next, label });
        return next;
      },
      endBusy: (generation) => dispatch({ type: "endBusy", generation }),
      setSelection: (selection) =>
        dispatch({ type: "setSelection", selection: { ...selection, anchor: selection.anchor ?? null } }),
      clearSelection: () => dispatch({ type: "clearSelection" }),
      setMenu: (menu) => dispatch({ type: "setMenu", menu }),
      setRewritePrompt: (rewritePrompt) => dispatch({ type: "setRewritePrompt", rewritePrompt }),
      setComposerPrefill: (composerPrefill) =>
        dispatch({ type: "setComposerPrefill", composerPrefill }),
      setSettingsOpen: (settingsOpen) => dispatch({ type: "setSettingsOpen", settingsOpen }),
      openThread: (thread) => dispatch({ type: "openThread", thread }),
      setThreads: (threads) => dispatch({ type: "setThreads", threads }),
      focusThread: (threadId) => dispatch({ type: "focusThread", threadId }),
      updateThreadPosition: (threadId, pos) => dispatch({ type: "updateThreadPosition", threadId, pos }),
      collapseThread: (threadId) => dispatch({ type: "collapseThread", threadId }),
      closeThread: (threadId) => dispatch({ type: "closeThread", threadId }),
      setLlm: (llm) => dispatch({ type: "setLlm", llm }),
      setBootError: (bootError) => dispatch({ type: "setBootError", bootError }),
      setStatusLine: (statusLine) => dispatch({ type: "setStatusLine", statusLine }),
      setChatMode: (chatMode) => dispatch({ type: "setChatMode", chatMode }),
      setClarificationRounds: (clarificationRounds) =>
        dispatch({ type: "setClarificationRounds", clarificationRounds }),
      setCascadeOffer: (cascadeOffer) => dispatch({ type: "setCascadeOffer", cascadeOffer }),
      setSourcePaths: (sourcePaths) => dispatch({ type: "setSourcePaths", sourcePaths }),
      toggleSourcePath: (relativePath) => dispatch({ type: "toggleSourcePath", relativePath }),
      clearSourcePaths: () => dispatch({ type: "clearSourcePaths" }),
      setDocumentDirty: (documentDirty) =>
        dispatch({ type: "setDocumentDirty", documentDirty }),
      setReviewError: (reviewError) => dispatch({ type: "setReviewError", reviewError }),
    }),
    [],
  );
  const store = useMemo<MarginStore>(() => ({ ...state, ...actions }), [state, actions]);
  return <MarginStoreContext.Provider value={store}>{children}</MarginStoreContext.Provider>;
}

export function useMarginStore() {
  const store = useContext(MarginStoreContext);
  if (!store) throw new Error("useMarginStore must be used within MarginStoreProvider");
  return store;
}
