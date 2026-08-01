import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { memo, useEffect, useMemo } from "react";
import type { Block, Comment, Proposal } from "../api";
import { MarginBlock } from "../extensions/MarginBlock";
import { blocksToDocJson, findBlockIdNearSelection, findBlockIdsInSelection } from "../doc";
import { PendingContext } from "../pendingContext";
import type { CanvasProps } from "./canvasTypes";

function MarkdownCanvasView({
  blocks,
  proposals,
  comments,
  busy,
  statusLine,
  onAccept,
  onEdit,
  onUndo,
  onRewrite,
  onSelectionChange,
  onContextMenu,
  onDirtyChange,
  onSaveHandlerChange,
}: CanvasProps) {
  const byBlock = useMemo(() => {
    const m = new Map<string, Proposal[]>();
    for (const p of proposals) {
      const list = m.get(p.blockId) ?? [];
      list.push(p);
      m.set(p.blockId, list);
    }
    return m;
  }, [proposals]);

  const commentsByBlock = useMemo(() => {
    const m = new Map<string, Comment[]>();
    for (const c of comments) {
      const list = m.get(c.blockId) ?? [];
      list.push(c);
      m.set(c.blockId, list);
    }
    return m;
  }, [comments]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        paragraph: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
      }),
      MarginBlock,
    ],
    content: blocksToDocJson(blocks),
    editable: false,
    editorProps: {
      attributes: { class: "prose-canvas" },
      handleDOMEvents: {
        contextmenu: (view, event) => {
          event.preventDefault();
          const { from, to } = view.state.selection;
          const text = view.state.doc.textBetween(from, to, "\n");
          const blockId = findBlockIdNearSelection(view.state.doc, from, to);
          const ids = findBlockIdsInSelection(view.state.doc, from, to);
          onContextMenu({
            x: event.clientX,
            y: event.clientY,
            blockId,
            blockIds: ids.length > 1 ? ids : undefined,
            text: text || "",
          });
          return true;
        },
      },
    },
    onSelectionUpdate: ({ editor: ed }) => {
      const { from, to, empty } = ed.state.selection;
      const text = empty ? "" : ed.state.doc.textBetween(from, to, "\n");
      const blockId = findBlockIdNearSelection(ed.state.doc, from, to);
      const ids = empty ? [] : findBlockIdsInSelection(ed.state.doc, from, to);
      let anchor: { x: number; y: number } | null = null;
      if (!empty && text.trim()) {
        try {
          const start = ed.view.coordsAtPos(from);
          const end = ed.view.coordsAtPos(to);
          const x = (start.left + end.right) / 2;
          const y = Math.min(start.top, end.top);
          anchor = {
            x: Math.min(Math.max(12, x), window.innerWidth - 12),
            y: Math.max(12, y),
          };
        } catch {
          anchor = null;
        }
      }
      onSelectionChange({
        blockId,
        blockIds: ids.length > 1 ? ids : undefined,
        text,
        rawText: text,
        anchor,
      });
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(blocksToDocJson(blocks));
  }, [editor, blocks]);

  useEffect(() => {
    onDirtyChange(false);
  }, [onDirtyChange]);

  useEffect(() => {
    onSaveHandlerChange?.(async () => true);
    return () => onSaveHandlerChange?.(null);
  }, [onSaveHandlerChange]);

  useEffect(() => {
    if (!editor) return;
    const proposalIdsByBlock = new Map<string, string>();
    for (const [blockId, list] of byBlock) {
      const proposalId = list[0]?.id;
      if (proposalId) proposalIdsByBlock.set(blockId, proposalId);
    }
    editor.commands.setBlocksPending(proposalIdsByBlock);
  }, [editor, byBlock]);

  if (!blocks.length) {
    return (
      <div className="paper">
        <p className="empty-paper">
          还没有打开文稿。在右侧对话里说「打开样章」，或「有哪些文章」。
        </p>
      </div>
    );
  }

  return (
    <PendingContext.Provider
      value={{ byBlock, commentsByBlock, onAccept, onEdit, onUndo, onRewrite, busy }}
    >
      <div className="paper">
        {statusLine ? <div className="canvas-status">{statusLine}</div> : null}
        <EditorContent editor={editor} />
        {proposals.length > 1 ? (
          <div className="batch-bar" contentEditable={false}>
            <span className="hint">共 {proposals.length} 处待确认</span>
          </div>
        ) : null}
      </div>
    </PendingContext.Provider>
  );
}

// Default shallow memo only. A custom data-only comparator cache-hit left Accept/Edit
// callbacks stale after host actions changed (e.g. dirty save-and-continue).
export const MarkdownCanvas = memo(MarkdownCanvasView);
