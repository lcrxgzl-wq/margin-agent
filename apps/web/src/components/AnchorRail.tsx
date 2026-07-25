import { MessageSquareText, PenLine } from "lucide-react";
import type { Block, Comment, Proposal } from "../api";
import type { ReviewThread, ThreadAnchor } from "../store";

type RailItem = {
  key: string;
  blockId: string;
  kind: "pending" | "note";
  excerpt: string;
  thread?: ReviewThread;
  anchorY?: number;
  active: boolean;
};

type Props = {
  blocks: Block[];
  threads: ReviewThread[];
  proposals: Proposal[];
  comments: Comment[];
  activeThreadId: string | null;
  onOpenThread: (thread: ReviewThread) => void;
  onOpenAnchor: (anchor: ThreadAnchor) => void;
};

function proposalExcerpt(proposal: Proposal): string {
  return (
    proposal.operation?.selection?.before ??
    proposal.tableCell?.before ??
    proposal.before
  ).slice(0, 120);
}

/** Narrow rail beside the page: one dot per anchored thread / pending proposal / margin note. */
export function AnchorRail({
  blocks,
  threads,
  proposals,
  comments,
  activeThreadId,
  onOpenThread,
  onOpenAnchor,
}: Props) {
  if (!blocks.length) return null;
  const orderById = new Map(blocks.map((block, index) => [block.id, index]));
  const items: RailItem[] = [];
  const threadedBlocks = new Set(threads.map((thread) => thread.anchor.blockId));
  const proposedBlocks = new Set(proposals.map((proposal) => proposal.blockId));

  for (const thread of threads) {
    items.push({
      key: `thread-${thread.id}`,
      blockId: thread.anchor.blockId,
      kind: proposedBlocks.has(thread.anchor.blockId) ? "pending" : "note",
      excerpt: thread.anchor.selectionText.slice(0, 60),
      thread,
      anchorY: thread.pos?.y,
      active: thread.id === activeThreadId,
    });
  }
  for (const blockId of proposedBlocks) {
    if (threadedBlocks.has(blockId)) continue;
    const proposal = proposals.find((candidate) => candidate.blockId === blockId);
    if (!proposal) continue;
    items.push({
      key: `proposal-${blockId}`,
      blockId,
      kind: "pending",
      excerpt: proposalExcerpt(proposal).slice(0, 60),
      active: false,
    });
  }
  const notedBlocks = new Set(comments.map((comment) => comment.blockId));
  for (const blockId of notedBlocks) {
    if (threadedBlocks.has(blockId) || proposedBlocks.has(blockId)) continue;
    const block = blocks.find((candidate) => candidate.id === blockId);
    items.push({
      key: `comment-${blockId}`,
      blockId,
      kind: "note",
      excerpt: (block?.text ?? "").slice(0, 60),
      active: false,
    });
  }
  if (!items.length) return null;

  return (
    <aside className="anchor-rail" aria-label="文稿锚点">
      {items.map((item) => {
        const index = orderById.get(item.blockId) ?? 0;
        const fallbackTop = ((index + 0.5) / blocks.length) * 100;
        const top = item.anchorY == null
          ? `${Math.min(98, Math.max(1, fallbackTop))}%`
          : `${Math.max(56, Math.min(window.innerHeight - 16, item.anchorY))}px`;
        return (
          <button
            key={item.key}
            type="button"
            className={`anchor-dot ${item.kind}${item.active ? " active" : ""}`}
            style={{ top }}
            title={item.excerpt}
            aria-label={item.kind === "pending" ? `待确认改动：${item.excerpt}` : `讨论锚点：${item.excerpt}`}
            onClick={() => {
              if (item.thread) {
                onOpenThread(item.thread);
              } else {
                onOpenAnchor({ blockId: item.blockId, selectionText: item.excerpt });
              }
            }}
          >
            {item.kind === "pending" ? <PenLine size={11} /> : <MessageSquareText size={11} />}
          </button>
        );
      })}
    </aside>
  );
}
