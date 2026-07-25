import type { BlockSnapshot } from "@margin/domain";

export type OutlineNode = {
  blockId: string;
  level: number;
  title: string;
  order: number;
};

export function buildOutline(blocks: BlockSnapshot[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const b of [...blocks].sort((a, c) => a.order - c.order)) {
    if (b.kind !== "heading") continue;
    const m = /^(#{1,6})\s+(.*)$/s.exec(b.text);
    const level = m?.[1].length ?? 1;
    const title = (m?.[2] ?? b.text.replace(/^#+\s*/, "")).trim();
    out.push({ blockId: b.id, level, title, order: b.order });
  }
  return out;
}

export type SearchHit = {
  blockId: string;
  kind: BlockSnapshot["kind"];
  order: number;
  matchCount: number;
  preview: string;
};

/** Case-sensitive substring search; stable order by block.order; capped. */
export function searchBlocks(
  blocks: BlockSnapshot[],
  query: string,
  limit = 20,
): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const cap = Math.min(Math.max(limit, 1), 50);
  const hits: SearchHit[] = [];
  for (const b of [...blocks].sort((a, c) => a.order - c.order)) {
    let matchCount = 0;
    let idx = 0;
    while (true) {
      const found = b.text.indexOf(q, idx);
      if (found < 0) break;
      matchCount += 1;
      idx = found + q.length;
    }
    if (matchCount === 0) continue;
    hits.push({
      blockId: b.id,
      kind: b.kind,
      order: b.order,
      matchCount,
      preview: b.text.slice(0, 160),
    });
    if (hits.length >= cap) break;
  }
  return hits;
}
