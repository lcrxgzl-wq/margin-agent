import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MarginBlockView } from "../components/MarginBlockView";

export type MarginBlockAttrs = {
  blockId: string;
  kind: string;
  pending: boolean;
  proposalId: string | null;
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    marginBlock: {
      setBlocksPending: (proposalIdsByBlock: ReadonlyMap<string, string>) => ReturnType;
    };
  }
}

export const MarginBlock = Node.create({
  name: "marginBlock",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes() {
    return {
      blockId: { default: "" },
      kind: { default: "paragraph" },
      pending: { default: false },
      proposalId: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-block-id]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-id": node.attrs.blockId,
        "data-kind": node.attrs.kind,
        "data-pending": node.attrs.pending ? "1" : "0",
        class: "margin-block",
      }),
      0,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MarginBlockView);
  },
  addCommands() {
    return {
      setBlocksPending:
        (proposalIdsByBlock) =>
        ({ tr, state, dispatch }) => {
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "marginBlock") return;
            const proposalId = proposalIdsByBlock.get(String(node.attrs.blockId)) ?? null;
            const pending = proposalId !== null;
            if (node.attrs.pending === pending && node.attrs.proposalId === proposalId) return;
            changed = true;
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              pending,
              proposalId,
            });
          });
          if (changed && dispatch) dispatch(tr);
          return true;
        },
    };
  },
});
