import { Node } from "@tiptap/pm/model";
import type { Block } from "./api";
import { displayText } from "./api";

export function blocksToDocJson(blocks: Block[]) {
  const content = [...blocks]
    .sort((a, b) => a.order - b.order)
    .map((b) => ({
      type: "marginBlock",
      attrs: {
        blockId: b.id,
        kind: b.kind,
        pending: false,
        proposalId: null,
      },
      content: displayText(b)
        ? [{ type: "text", text: displayText(b) }]
        : [],
    }));
  return {
    type: "doc",
    content: content.length
      ? content
      : [
          {
            type: "marginBlock",
            attrs: { blockId: "empty", kind: "paragraph", pending: false, proposalId: null },
            content: [{ type: "text", text: "（空文档）" }],
          },
        ],
  };
}

export function findBlockIdNearSelection(
  doc: Node,
  from: number,
  to: number,
): string | null {
  let found: string | null = null;
  doc.nodesBetween(from, to, (node) => {
    if (node.type.name === "marginBlock" && node.attrs.blockId) {
      found = String(node.attrs.blockId);
      return false;
    }
    return true;
  });
  if (found) return found;
  // caret in empty selection: resolve parent
  try {
    const $from = doc.resolve(from);
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if (n.type.name === "marginBlock") return String(n.attrs.blockId);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Every marginBlock the selection touches, in document order. */
export function findBlockIdsInSelection(
  doc: Node,
  from: number,
  to: number,
): string[] {
  const ids: string[] = [];
  doc.nodesBetween(from, to, (node) => {
    if (node.type.name === "marginBlock" && node.attrs.blockId) {
      const id = String(node.attrs.blockId);
      if (!ids.includes(id)) ids.push(id);
      return false;
    }
    return true;
  });
  return ids;
}
