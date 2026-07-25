import {
  api,
  cancelProposalRun,
  chatStream,
  closeDocumentSession,
  exportDocumentDocx,
  listComments,
  listProposals,
  openDocument,
  resolveProposal,
  saveSessionSources,
  startProposalRun,
  waitRun,
} from "./api";
import { buildSelectionCommand } from "./commands";
import type { TableCellSelection } from "./components/canvasTypes";
import { buildDisclosureText } from "./disclosure";
import {
  polishIntent,
  selectionEditIntent,
  translationIntent,
} from "./selectionEditIntent";
import type {
  ProposalOperationKind,
  ProposalTargetLanguage,
  SelectionCommand,
} from "@margin/domain";
import { useRef, useState } from "react";
import { useMarginStore } from "./store";
import { filterEditableBlockIds, selectionEditUnavailableReason } from "./selectionSafety";

function mid() {
  return crypto.randomUUID();
}

function reviewErrorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (/stale/i.test(value)) return "文稿版本已经变化，这条提案不能直接写入。请重新生成。";
  if (/external_change/i.test(value)) return "工作副本已在外部改变。重新打开文稿后再处理这条提案。";
  if (/unsupported/i.test(value)) return "当前内容结构暂不支持安全写回。";
  return value;
}

function requestsSourceGrounding(instruction?: string): boolean {
  return /资料|材料|访谈|笔记|摘录|文献|证据|引文|引用|根据|结合|对照|source|evidence|interview|citation/i.test(
    instruction ?? "",
  );
}

export function useWorkspaceActions(options?: {
  onSelectionRunStart?: (anchor: {
    blockId: string;
    selectionText: string;
    selectionStart?: number;
    tableCell?: TableCellSelection;
  }) => void;
}) {
  const store = useMarginStore();
  const storeRef = useRef(store);
  const proposalsRequestRef = useRef(0);
  const commentsRequestRef = useRef(0);
  const activeChatAbortRef = useRef<AbortController | null>(null);
  const activeProposalRunRef = useRef<{ runId: string; controller: AbortController } | null>(null);
  const [canCancel, setCanCancel] = useState(false);
  storeRef.current = store;
  const assertDocumentClean = () => {
    if (store.documentDirty) {
      throw new Error("当前文稿有未保存修改，请先保存或撤销后再执行此操作。");
    }
  };
  const messageError = (error: unknown) =>
    store.appendMessage({
      id: mid(),
      role: "assistant",
      text: error instanceof Error ? error.message : String(error),
    });
  const refreshProposals = async (
    documentId: string,
    expectedRevision = storeRef.current.doc?.revision,
    allowPreviousRevision = false,
  ) => {
    const requestId = ++proposalsRequestRef.current;
    const data = await listProposals(documentId);
    const current = storeRef.current.doc;
    if (requestId !== proposalsRequestRef.current) return;
    if (current?.id !== documentId || (expectedRevision != null &&
      current.revision !== expectedRevision &&
      (!allowPreviousRevision || current.revision !== expectedRevision - 1))) return;
    store.setProposals(data.proposals);
  };
  const refreshComments = async (
    documentId: string,
    expectedRevision = storeRef.current.doc?.revision,
    allowPreviousRevision = false,
  ) => {
    const requestId = ++commentsRequestRef.current;
    const data = await listComments(documentId);
    const current = storeRef.current.doc;
    if (requestId !== commentsRequestRef.current) return;
    if (current?.id !== documentId || (expectedRevision != null &&
      current.revision !== expectedRevision &&
      (!allowPreviousRevision || current.revision !== expectedRevision - 1))) return;
    store.setComments(data.comments ?? []);
  };
  const refreshDocument = async (relativePath: string) => {
    const reopened = await openDocument(relativePath);
    store.setDocBundle(reopened.document, reopened.blocks);
    await refreshProposals(reopened.document.id, reopened.document.revision, true);
    await refreshComments(reopened.document.id, reopened.document.revision, true);
  };
  const runRewrite = async (
    blockIds: string[],
    note?: string,
    instruction?: string,
    selectionText?: string,
    selectionStart?: number,
    operation?: ProposalOperationKind,
    targetLanguage?: ProposalTargetLanguage,
    tableCell?: TableCellSelection,
  ) => {
    if (!store.doc) throw new Error("请先打开文章");
    if (!blockIds.length) throw new Error("请先选中一段文字");
    assertDocumentClean();
    const { editableIds, skippedTables } = filterEditableBlockIds(blockIds, store.blocks, tableCell);
    if (!editableIds.length) {
      throw new Error("请在表格的单个单元格内选择文字后再生成提案。");
    }
    const document = store.doc;
    if (selectionText && editableIds[0]) {
      options?.onSelectionRunStart?.({
        blockId: editableIds[0],
        selectionText,
        selectionStart,
        tableCell,
      });
    }
    const generation = store.beginBusy(
      instruction
        ? `正在按指令生成修订（${editableIds.length} 段）…`
        : `正在生成修订（${editableIds.length} 段）…`,
    );
    try {
      const { runId } = await startProposalRun(document.id, editableIds.slice(0, 8), {
        harnessId: store.llm?.harnessId,
        instruction,
        selectionText,
        selectionStart,
        operation,
        targetLanguage,
        tableCell,
        sourcePaths: requestsSourceGrounding(instruction) ? store.sourcePaths : [],
        preferSimple: true,
      });
      const controller = new AbortController();
      activeProposalRunRef.current = { runId, controller };
      setCanCancel(true);
      store.setStatusLine(instruction ? "正在按指令生成修订…" : "正在生成修订…");
      const run = await waitRun(runId, 90_000, ({ status, phase }) => {
        if (status === "running") {
          store.setStatusLine(phase || "正在生成修订");
        }
      }, controller.signal);
      await refreshProposals(document.id);
      await refreshComments(document.id);
      const count = run.proposalIds?.length ?? 0;
      if (!selectionText) {
        const skipped = skippedTables ? `（已跳过 ${skippedTables} 个表格块）` : "";
        store.appendMessage({
          id: mid(),
          role: "assistant",
          text: `${note || (count ? `已提出 ${count} 处修订` : "已完成扫描")}${skipped}，请到审阅中确认。`,
        });
      } else if (skippedTables) {
        store.appendMessage({
          id: mid(),
          role: "assistant",
          text: `已跳过 ${skippedTables} 个表格块（表格请在单元格内选择）。`,
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        store.appendMessage({ id: mid(), role: "assistant", text: "已停止生成这版提案。当前选区仍保留。" });
        return;
      }
      const activeRun = activeProposalRunRef.current;
      if (activeRun) await cancelProposalRun(activeRun.runId).catch(() => undefined);
      throw error;
    } finally {
      activeProposalRunRef.current = null;
      setCanCancel(Boolean(activeChatAbortRef.current));
      store.endBusy(generation);
    }
  };
  const dispatchSelectionCommand = (command: SelectionCommand) => {
    store.setMenu(null);
    const commandBlockIds = command.blockIds?.length ? command.blockIds : [command.blockId];
    switch (command.kind) {
      case "rewrite":
        void runRewrite(
          commandBlockIds,
          "已为选区生成修订",
          "重写所选文本；保持事实、引文和未选中文字不变。",
          command.selectionText,
          command.selectionStart,
          command.operation ?? "rewrite",
          command.targetLanguage,
          command.tableCell,
        ).catch(messageError);
        return;
      case "rewrite_directed":
        if (command.instruction) {
          void runRewrite(
            commandBlockIds,
            "已按指令生成修订",
            command.instruction,
            command.selectionText,
            command.selectionStart,
            command.operation ?? "rewrite",
            command.targetLanguage,
            command.tableCell,
          ).catch(messageError);
          return;
        }
        store.setRewritePrompt({
          blockId: command.blockId,
          blockIds: command.blockIds,
          excerpt: command.selectionText?.trim().slice(0, 160) ?? "",
          selectionText: command.selectionText ?? "",
          selectionStart: command.selectionStart,
          tableCell: command.tableCell,
          crossTableCells: storeRef.current.selection.crossTableCells,
        });
        return;
      case "discuss":
        store.openThread({
          id: mid(),
          anchor: {
            blockId: command.blockId,
            selectionText: command.selectionText ?? "",
            selectionStart: command.selectionStart,
            tableCell: command.tableCell,
            crossTableCells: storeRef.current.selection.crossTableCells,
          },
          pos: storeRef.current.selection.anchor,
          collapsed: false,
          createdAt: new Date().toISOString(),
        });
        return;
    }
  };
  const dispatchSelection = (
    kind: SelectionCommand["kind"],
    blockId: string | null,
    selectionText: string,
    instruction?: string,
    selectionStart?: number,
    operation?: ProposalOperationKind,
    targetLanguage?: ProposalTargetLanguage,
    tableCell?: TableCellSelection,
    blockIds?: string[],
    crossTableCells?: boolean,
  ) => {
    const unavailable = selectionEditUnavailableReason({
      blockId,
      blockIds,
      text: selectionText,
      tableCell,
      crossTableCells,
    });
    if (kind !== "discuss" && unavailable) {
      store.appendMessage({ id: mid(), role: "assistant", text: unavailable });
      return;
    }
    if (kind === "discuss" && selectionText.trim()) {
      if (!blockId) {
        store.appendMessage({ id: mid(), role: "assistant", text: "请先选中一段正文。" });
        return;
      }
      store.openThread({
        id: mid(),
        anchor: {
          blockId,
          selectionText,
          selectionStart,
          tableCell,
          crossTableCells,
        },
        pos: storeRef.current.selection.anchor,
        collapsed: false,
        createdAt: new Date().toISOString(),
      });
      return;
    }
    if (!blockId) {
      store.appendMessage({ id: mid(), role: "assistant", text: "请先选中一段正文。" });
      return;
    }
    dispatchSelectionCommand(buildSelectionCommand(kind, blockId, selectionText, instruction, {
      selectionStart,
      operation,
      targetLanguage,
      tableCell,
      blockIds,
    }));
  };
  const onAccept = async (proposalId: string) => {
    if (!store.doc) return;
    const document = store.doc;
    const generation = store.beginBusy("正在写入 Accept…");
    try {
      store.setReviewError(null);
      assertDocumentClean();
      const result = await resolveProposal(document, proposalId, "Y");
      if (!result.ok) throw new Error(result.reason || "apply failed");
      if (result.document && result.blocks) store.setDocBundle(result.document, result.blocks);
      else await refreshDocument(result.document?.relativePath ?? document.relativePath);
      await Promise.all([
        refreshProposals(document.id, result.document?.revision, true),
        refreshComments(document.id, result.document?.revision, true),
      ]);
      store.appendMessage({ id: mid(), role: "assistant", text: "已 Accept 并写回文章。" });
    } catch (error) {
      store.setReviewError(reviewErrorText(error));
      messageError(error);
      return false;
    } finally {
      store.endBusy(generation);
    }
    return true;
  };
  const onEdit = async (proposalId: string, editedText: string) => {
    if (!store.doc) return;
    const document = store.doc;
    const generation = store.beginBusy("正在写入 Edit…");
    try {
      store.setReviewError(null);
      assertDocumentClean();
      const result = await resolveProposal(document, proposalId, "E", editedText);
      if (!result.ok) throw new Error(result.reason || "apply failed");
      if (result.document && result.blocks) store.setDocBundle(result.document, result.blocks);
      else await refreshDocument(result.document?.relativePath ?? document.relativePath);
      await Promise.all([
        refreshProposals(document.id, result.document?.revision, true),
        refreshComments(document.id, result.document?.revision, true),
      ]);
      store.appendMessage({ id: mid(), role: "assistant", text: "已 Edit 并写回文章。" });
    } catch (error) {
      store.setReviewError(reviewErrorText(error));
      messageError(error);
      return false;
    } finally {
      store.endBusy(generation);
    }
    return true;
  };
  const onUndo = async (proposalId: string) => {
    if (!store.doc) return;
    const document = store.doc;
    const generation = store.beginBusy("正在撤回…");
    try {
      store.setReviewError(null);
      assertDocumentClean();
      await resolveProposal(document, proposalId, "N");
      await refreshProposals(document.id);
      store.clearSelection();
      store.appendMessage({
        id: mid(),
        role: "assistant",
        text: "已 Undo，该改动不会写入正文。",
      });
    } catch (error) {
      store.setReviewError(reviewErrorText(error));
      messageError(error);
      return false;
    } finally {
      store.endBusy(generation);
    }
    return true;
  };
  const acceptAll = async () => {
    if (!store.doc) throw new Error("请先打开文章");
    assertDocumentClean();
    if (!store.proposals.length) throw new Error("没有待确认改动");
    let document = store.doc;
    const count = store.proposals.length;
    const generation = store.beginBusy(`正在接受全部（${count}）…`);
    try {
      let latestBlocks = store.blocks;
      for (const proposal of store.proposals) {
        const result = await resolveProposal(document, proposal.id, "Y");
        if (!result.ok || !result.document || !result.blocks) {
          throw new Error(result.reason || "apply failed");
        }
        document = result.document;
        latestBlocks = result.blocks;
        store.setDocBundle(document, latestBlocks);
      }
      store.setDocBundle(document, latestBlocks);
      await Promise.all([
        refreshProposals(document.id, document.revision, true),
        refreshComments(document.id, document.revision, true),
      ]);
      store.appendMessage({
        id: mid(),
        role: "assistant",
        text: `已接受并写回 ${count} 处改动。`,
      });
    } catch (error) {
      await refreshDocument(document.relativePath).catch(() => undefined);
      throw error;
    } finally {
      store.endBusy(generation);
    }
  };
  const undoAll = async () => {
    if (!store.doc) throw new Error("请先打开文章");
    assertDocumentClean();
    if (!store.proposals.length) throw new Error("没有待确认改动");
    const document = store.doc;
    const count = store.proposals.length;
    const generation = store.beginBusy(`正在撤回全部（${count}）…`);
    try {
      for (const proposal of store.proposals) {
        await resolveProposal(document, proposal.id, "N");
      }
      await refreshProposals(document.id);
      store.appendMessage({
        id: mid(),
        role: "assistant",
        text: `已撤回 ${count} 处待确认改动。`,
      });
    } finally {
      store.endBusy(generation);
    }
  };
  const exportPacket = async () => {
    if (!store.doc) throw new Error("请先打开文章");
    const generation = store.beginBusy("正在导出 revision packet…");
    try {
      const packet = await api(`/api/v1/documents/${store.doc.id}/exports`);
      const blob = new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" });
      const anchor = document.createElement("a");
      const objectUrl = URL.createObjectURL(blob);
      anchor.href = objectUrl;
      anchor.download = "revision-packet.json";
      try {
        anchor.click();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      store.appendMessage({
        id: mid(),
        role: "assistant",
        text: "已下载 revision-packet.json（审阅记录，不是 Word）。",
      });
      return packet;
    } finally {
      store.endBusy(generation);
    }
  };
  const exportDisclosure = async () => {
    if (!store.doc) throw new Error("请先打开文章");
    const generation = store.beginBusy("正在生成 AI 披露草稿…");
    try {
      const packet = await api(`/api/v1/documents/${store.doc.id}/exports`);
      const text = buildDisclosureText(packet);
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const anchor = document.createElement("a");
      const objectUrl = URL.createObjectURL(blob);
      anchor.href = objectUrl;
      anchor.download = "ai-disclosure.txt";
      try {
        anchor.click();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      store.appendMessage({
        id: mid(),
        role: "assistant",
        text: "已下载 ai-disclosure.txt（给导师/审稿人看的披露草稿，请按需改写）。",
      });
    } finally {
      store.endBusy(generation);
    }
  };
  const exportWord = async () => {
    if (!store.doc) throw new Error("请先打开文章");
    assertDocumentClean();
    const generation = store.beginBusy("正在导出 Word…");
    try {
      const result = await exportDocumentDocx(store.doc.id);
      const ratios = result.report?.ratios
        ? ` · 往返保留字数 ${Math.round((result.report.ratios.chars || 0) * 100)}%`
        : "";
      const warn = result.report?.ok === false ? ` · 告警 ${(result.report.flags || []).join(",")}` : "";
      store.appendMessage({
        id: mid(),
        role: "assistant",
        text: `已导出 Word 到工作区：${result.relativePath}${ratios}${warn}`,
      });
    } finally {
      store.endBusy(generation);
    }
  };
  const closeDocument = async () => {
    if (!store.doc) return false;
    if (
      store.documentDirty &&
      !window.confirm("当前文稿有未保存的修改。关闭后这些修改会丢失，仍要关闭吗？")
    ) {
      return false;
    }
    const title = store.doc.relativePath.replace(/^.*[\\/]/, "");
    const generation = store.beginBusy("正在关闭文稿…");
    try {
      await closeDocumentSession();
      store.clearDocument();
      store.appendMessage({
        id: mid(),
        role: "assistant",
        text: `已关闭《${title}》。`,
      });
      return true;
    } finally {
      store.endBusy(generation);
    }
  };
  const onSend = async (text: string, opts?: {
    cascadeBlockIds?: string[];
    threadId?: string;
    selection?: {
      blockId: string | null;
      blockIds?: string[];
      text: string;
      selectionStart?: number;
      tableCell?: TableCellSelection;
      crossTableCells?: boolean;
    };
  }) => {
    const selectionContext = opts?.selection ?? store.selection;
    let chatMode = store.chatMode;
    if (/苏格拉底|追问模式|先别改/.test(text)) {
      chatMode = "socratic";
      store.setChatMode("socratic");
    } else if (/直接改|退出追问/.test(text) && chatMode === "socratic") {
      chatMode = "direct";
      store.setChatMode("direct");
    }
    store.appendMessage({ id: mid(), role: "user", text, threadId: opts?.threadId });
    try {
      const selectedIntent = selectionContext.text.trim()
        ? selectionEditIntent(text, selectionContext.text)
        : null;
      if (selectedIntent) {
        const unavailable = selectionEditUnavailableReason(selectionContext);
        if (unavailable) {
          store.appendMessage({ id: mid(), role: "assistant", text: unavailable, threadId: opts?.threadId });
          return;
        }
      }
      if (selectedIntent && selectionContext.blockId) {
        await runRewrite(
          selectionContext.blockIds?.length ? selectionContext.blockIds : [selectionContext.blockId],
          /翻|translate/i.test(text) ? "已为选区生成翻译提案" : "已为选区生成修订",
          selectedIntent.instruction,
          selectionContext.text,
          selectionContext.selectionStart,
          selectedIntent.operation,
          selectedIntent.targetLanguage,
          selectionContext.tableCell,
        );
        return;
      }
      if (/^(?:请)?(?:退出|关闭|关掉|收起)(?:这个|当前|这篇)?\s*(?:word|docx|文档|文稿|文章)(?:吧|。|！|!)?$/i.test(text.trim())) {
        const closed = await closeDocument();
        if (!closed && store.doc) {
          store.appendMessage({ id: mid(), role: "assistant", text: "已取消关闭。" });
        }
        return;
      }
      if (store.documentDirty) {
        store.appendMessage({
          id: mid(),
          role: "assistant",
          text: "当前文稿有未保存修改，请先保存或撤销；我不会基于后端旧版本继续操作。",
        });
        return;
      }
      if (/接受全部|全部接受|accept\s*all/i.test(text)) return await acceptAll();
      if (/撤回全部|全部撤回|undo\s*all|拒绝全部/i.test(text)) return await undoAll();
      if (/导出\s*(word|docx|Word|WORD)|导出为?\s*word|word\s*导出/i.test(text)) {
        return await exportWord();
      }
      if (/导出记录|导出\s*packet|revision\s*packet|download\s*packet/i.test(text)) {
        return await exportPacket();
      }
      if (/披露|ai\s*disclosure|使用说明草稿/i.test(text)) {
        return await exportDisclosure();
      }
      if (/^导出$/i.test(text.trim())) return await exportWord();
      if (/^(清空对话|清除对话|新会话|reset\s*chat)(?:。|！|!)?$/i.test(text.trim())) {
        const generation = store.beginBusy("清空短记忆…");
        try {
          await api("/api/v1/chat/clear", { method: "POST", body: "{}" });
          store.setMessages([
            { id: mid(), role: "assistant", text: "对话已清空，当前文稿保持打开。" },
          ]);
          store.setClarificationRounds(0);
          store.setCascadeOffer(null);
        } finally {
          store.endBusy(generation);
        }
        return;
      }

      const generation = store.beginBusy("正在处理…");
      try {
        const assistantId = mid();
        let bubbled = false;
        let pendingDelta = "";
        let deltaFrame: number | null = null;
        const ensureBubble = () => {
          if (!bubbled) {
            bubbled = true;
            store.appendMessage({ id: assistantId, role: "assistant", text: "", threadId: opts?.threadId });
          }
        };
        const flushDelta = () => {
          deltaFrame = null;
          if (!pendingDelta) return;
          ensureBubble();
          const text = pendingDelta;
          pendingDelta = "";
          store.patchMessage(assistantId, (message) => ({
            text: (message.text || "") + text,
          }));
        };
        const queueDelta = (text: string) => {
          pendingDelta += text;
          if (deltaFrame === null) deltaFrame = window.requestAnimationFrame(flushDelta);
        };
        const controller = new AbortController();
        activeChatAbortRef.current = controller;
        setCanCancel(true);
        let done: Awaited<ReturnType<typeof chatStream>>;
        try {
          done = await chatStream(
            {
              message: text,
              harnessId: store.llm?.harnessId,
              documentId: store.doc?.id,
              selectionBlockIds: selectionContext.blockIds?.length
                ? selectionContext.blockIds
                : selectionContext.blockId
                  ? [selectionContext.blockId]
                  : [],
              selectionText: selectionContext.text,
              selectionStart: selectionContext.selectionStart,
              chatMode,
              cascadeBlockIds: opts?.cascadeBlockIds,
              sourcePaths: store.doc ? store.sourcePaths : undefined,
              threadId: opts?.threadId,
            },
            (event) => {
              if (event.type === "status") store.setStatusLine(event.text);
              if (event.type === "delta" && event.text) queueDelta(event.text);
            },
            controller.signal,
          );
        } finally {
          if (activeChatAbortRef.current === controller) {
            activeChatAbortRef.current = null;
            setCanCancel(false);
          }
          if (deltaFrame !== null) window.cancelAnimationFrame(deltaFrame);
          flushDelta();
        }
        const switchedDocument =
          !!store.doc && !!done.opened && store.doc.id !== done.opened.document.id;
        if (done.opened) {
          store.setDocBundle(done.opened.document, done.opened.blocks);
          store.clearSelection();
        }
        if (done.closed) {
          store.clearDocument();
          ensureBubble();
          store.patchMessage(assistantId, { text: done.reply });
          return;
        }
        if (done.sourcePaths && !switchedDocument) {
          store.setSourcePaths(done.sourcePaths);
        }
        ensureBubble();
        store.patchMessage(assistantId, { text: done.reply, task: done.task });
        if (typeof done.clarificationRounds === "number") {
          store.setClarificationRounds(done.clarificationRounds);
        }
        if (done.cascadeOffer?.length) {
          store.setCascadeOffer(done.cascadeOffer);
        } else {
          store.setCascadeOffer(null);
        }
        const activeId = done.opened?.document.id ?? store.doc?.id;
        if (activeId) {
          await Promise.all([refreshProposals(activeId), refreshComments(activeId)]);
        }
      } finally {
        store.endBusy(generation);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
          store.appendMessage({
            id: mid(),
            role: "assistant",
            text: "已停止本轮生成。",
            threadId: opts?.threadId,
            task: {
              objective: text,
              status: "interrupted",
              sourcePaths: [...store.sourcePaths],
              sourceRefs: [],
              proposalCount: 0,
              inspectedDocument: false,
              consistencyChecked: false,
              selection: selectionContext.blockId
                ? {
                    blockIds: selectionContext.blockIds?.length ? selectionContext.blockIds : [selectionContext.blockId],
                    text: selectionContext.text,
                    start: selectionContext.selectionStart,
                  }
                : undefined,
              updatedAt: new Date().toISOString(),
            },
          });
      } else {
        messageError(error);
      }
    }
  };
  const onCascadeLocalOnly = () => {
    store.setCascadeOffer(null);
    store.appendMessage({
      id: mid(),
      role: "assistant",
      text: "好，仅保留选区修订。相关段有需要时再说。",
    });
  };

  const onCascadeConfirm = (blockIds: string[]) => {
    const ids = blockIds.filter(Boolean).slice(0, 3);
    store.setCascadeOffer(null);
    void onSend(`一并改这些相关段：${ids.join(", ")}`, { cascadeBlockIds: ids }).catch(
      messageError,
    );
  };

  const onToggleSourcePath = async (relativePath: string) => {
    const key = relativePath.replace(/\\/g, "/");
    const attached = store.sourcePaths.some((path) => path.replace(/\\/g, "/") === key);
    const next = attached
      ? store.sourcePaths.filter((path) => path.replace(/\\/g, "/") !== key)
      : [...store.sourcePaths, relativePath];
    try {
      const saved = await saveSessionSources(next);
      store.setSourcePaths(saved.sourcePaths);
    } catch (error) {
      messageError(error);
    }
  };

  return {
    canCancel,
    cancelCurrentRun: () => {
      activeChatAbortRef.current?.abort();
      const proposalRun = activeProposalRunRef.current;
      if (proposalRun) {
        proposalRun.controller.abort();
        void cancelProposalRun(proposalRun.runId).catch(() => undefined);
      }
    },
    dispatchSelection,
    dispatchSelectionCommand: (command: SelectionCommand) => dispatchSelectionCommand(command),
    messageError,
    onAccept,
    onEdit,
    onUndo,
    onRewriteProposal: async (proposalId: string, blockId: string) => {
      const proposal = store.proposals.find((candidate) => candidate.id === proposalId);
      if (proposal?.tableCell) {
        return runRewrite(
          [blockId],
          `已重新生成单元格 ${proposal.tableCell.address} 提案`,
          "为这个单元格生成另一版修订；只处理当前单元格，保持表格结构与事实边界不变。",
          proposal.tableCell.before,
          0,
          "rewrite",
          undefined,
          proposal.tableCell,
        );
      }
      const operation = proposal?.operation;
      const selection = operation?.scope === "selection"
        ? operation.selection
        : undefined;
      if (selection && operation) {
        const intent = operation.kind === "translate"
          ? translationIntent(selection.before, operation.targetLanguage)
          : operation.kind === "polish"
            ? polishIntent
            : {
                operation: "rewrite" as const,
                instruction: "重新生成另一版改写；只处理所选文本，保持事实、引文和未选中文字不变。",
              };
        return runRewrite(
          [blockId],
          "已重新生成选区提案",
          intent.instruction,
          selection.before,
          selection.start,
          intent.operation,
          "targetLanguage" in intent ? intent.targetLanguage : undefined,
        );
      }
      return runRewrite(
        [blockId],
        "已按同段重新生成提案",
        "为这一整段生成另一版修订，保持事实、引文和证据边界不变。",
        undefined,
        undefined,
        "rewrite",
      );
    },
    onSend,
    onToggleSourcePath,
    onCascadeLocalOnly,
    onCascadeConfirm,
    acceptAll,
    exportWord,
    exportDisclosure,
    closeDocument,
  };
}
