import type { IElement } from "@hufe921/canvas-editor";
import type { Block, Proposal } from "../api";
import { proposalChange, type ProposalChange } from "../proposalChange";

/** IElement.extension 上记录提案 id 的键名，注入/还原/剥除共用。 */
export const MARK_EXTENSION_ATTR = "marginMark";

/** 删除标记色（灰）与新增标记色（对齐 styles.css 的 --accent #14563f）。 */
export const MARK_DELETE_COLOR = "#9a9a9a";
export const MARK_INSERT_COLOR = "#14563f";

/** 注入标记时从原文 span 继承的排版属性。 */
export type MarkBaseStyle = Partial<Pick<
  IElement,
  "font" | "size" | "bold" | "italic" | "highlight" | "rowFlex" | "rowMargin" | "letterSpacing"
>>;

export type MarkAnchor = {
  /** beforeFragment 在块文本（proposal.before）中的起始偏移。 */
  offset: number;
  change: ProposalChange;
};

/**
 * 注入/还原共用的定位串：注入后正文在该位置恰好是 del 文本紧接 ins 文本。
 * 纯插入时 key = afterFragment，纯删除时 key = beforeFragment。
 */
export function markKey(beforeFragment: string, afterFragment: string): string {
  return `${beforeFragment}${afterFragment}`;
}

/** 从被替换区域的原文 span 提取可继承的排版属性。 */
export function markBaseStyle(element: IElement | undefined): MarkBaseStyle {
  if (!element) return {};
  const style: MarkBaseStyle = {};
  if (element.font != null) style.font = element.font;
  if (element.size != null) style.size = element.size;
  if (element.bold != null) style.bold = element.bold;
  if (element.italic != null) style.italic = element.italic;
  if (element.highlight != null) style.highlight = element.highlight;
  if (element.rowFlex != null) style.rowFlex = element.rowFlex;
  if (element.rowMargin != null) style.rowMargin = element.rowMargin;
  if (element.letterSpacing != null) style.letterSpacing = element.letterSpacing;
  return style;
}

/**
 * 构造修订标记 spans：del（删除线+灰）在前、ins（下划线+主题色）在后，
 * 均带 extension.marginMark。纯插入只产 ins span，纯删除只产 del span。
 */
export function buildMarkSpans(
  baseStyle: MarkBaseStyle,
  beforeFragment: string,
  afterFragment: string,
  proposalId: string,
): IElement[] {
  const extension = { [MARK_EXTENSION_ATTR]: proposalId };
  const spans: IElement[] = [];
  if (beforeFragment) {
    spans.push({
      ...baseStyle,
      value: beforeFragment,
      strikeout: true,
      color: MARK_DELETE_COLOR,
      extension,
    });
  }
  if (afterFragment) {
    spans.push({
      ...baseStyle,
      value: afterFragment,
      strikeout: false,
      underline: true,
      color: MARK_INSERT_COLOR,
      extension,
    });
  }
  return spans;
}

/** 读取元素上的修订标记提案 id（无标记返回 null）。 */
export function markProposalId(element: IElement): string | null {
  const extension = element.extension as Record<string, unknown> | null | undefined;
  const value = extension?.[MARK_EXTENSION_ATTR];
  return typeof value === "string" && value ? value : null;
}

/**
 * 剥除修订标记：连续的同 id 标记 spans 整体替换为快照原文。快照缺失时保底
 * 去掉标记样式与 extension、保留文本。只处理顶层文本流——标记本轮不会注入
 * 表格/控件内部。
 * 注意：纯函数保留但不接线——纯插入提案的快照含左扩字符（expandLeft），
 * 直接替换标记连续段会把左邻字符重复一次；保存兜底一律走 restoreMark 全量
 * 还原（OfficeCanvas.save），语义由 revisionMarks.test.ts 的回归测试锁定。
 */
export function stripMarks(
  elements: IElement[],
  snapshots: ReadonlyMap<string, IElement[]> | Record<string, IElement[]>,
): IElement[] {
  const lookup = (id: string): IElement[] | undefined =>
    typeof (snapshots as ReadonlyMap<string, IElement[]>).get === "function"
      ? (snapshots as ReadonlyMap<string, IElement[]>).get(id)
      : (snapshots as Record<string, IElement[]>)[id];
  const result: IElement[] = [];
  let index = 0;
  while (index < elements.length) {
    const id = markProposalId(elements[index]!);
    if (!id) {
      result.push(elements[index]!);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < elements.length && markProposalId(elements[end]!) === id) end += 1;
    const snapshot = lookup(id);
    if (snapshot) {
      result.push(...structuredClone(snapshot));
    } else {
      for (const marked of elements.slice(index, end)) {
        const fallback: IElement = { ...marked, strikeout: false, underline: false };
        delete fallback.color;
        delete fallback.extension;
        result.push(fallback);
      }
    }
    index = end;
  }
  return result;
}

/**
 * 本轮是否可注入标记：table_cell 提案、表格块、含换行（跨块/多段）的提案跳过，
 * 保持 pending-rail 卡片展示；数据不一致（proposalChange 抛错）同样跳过。
 */
export function canInjectMark(proposal: Proposal, blocks: Block[]): boolean {
  if (proposal.tableCell) return false;
  const block = blocks.find((candidate) => candidate.id === proposal.blockId);
  if (!block || block.kind === "table") return false;
  // 提案必须仍对应当前块文本，否则关键词可能命中同文本的其他段落而误注入。
  if (block.text.replace(/\s+/g, "").trim() !== proposal.before.replace(/\s+/g, "").trim()) {
    return false;
  }
  if (/\r|\n/.test(proposal.before) || /\r|\n/.test(proposal.after)) return false;
  try {
    const change = proposalChange(proposal);
    if (change.scope === "table_cell") return false;
    return Boolean(change.beforeFragment || change.afterFragment);
  } catch {
    return false;
  }
}

function commonPrefixLength(before: string, after: string): number {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  return start;
}

/** 计算变更片段在块文本中的偏移（selection 用 selection.start，block 用公共前缀）。 */
export function markAnchor(proposal: Proposal): MarkAnchor | null {
  if (proposal.tableCell) return null;
  try {
    const change = proposalChange(proposal);
    if (change.scope === "table_cell") return null;
    const offset = change.scope === "selection"
      ? proposal.operation?.selection?.start ?? null
      : commonPrefixLength(proposal.before, proposal.after);
    if (offset == null || offset < 0) return null;
    return { offset, change };
  } catch {
    return null;
  }
}

/** 锚定 key 的上下文半径：片段前后各取至多 20 字符参与定位。 */
export const ANCHOR_CONTEXT = 20;

/**
 * 片段级锚定（Task 3）的定位结果。editor 侧只做坐标映射：
 * 注入前用 key 搜索，命中区起点 + (replaceStart - keyStart) 即被替换片段起点；
 * 注入后用 markedKey 搜索，命中区起点 + markedOffset 即标记文本起点。
 */
export type FragmentAnchor = {
  /** 注入前定位 key：上下文 + 片段（片段过长只取头部，长段落/整段改写也能命中）。 */
  key: string;
  /** key 起点在块文本中的偏移。 */
  keyStart: number;
  /** 被替换区间 [replaceStart, replaceEnd)（纯插入时为同一插入点）。 */
  replaceStart: number;
  replaceEnd: number;
  /** key 在块文本内 keyStart 之前的出现次数（块内第 N 次出现，供多命中消歧）。 */
  occurrence: number;
  /** key 在块文本内的总出现次数（配合块级 ordinal 换算全文命中序号）。 */
  occurrences: number;
  /**
   * 注入后定位 key：上文尾部 + 标记文本（del+ins）头部。注入后正文是
   * 上下文 + del + ins + 后上下文，含后上下文的 key 会被 ins 截断而失效，
   * 故还原/篡改检测用 markedKey（del 保留原文，markedKey 仍逐字命中）。
   */
  markedKey: string;
  /** markedKey 命中区起点到标记文本起点的偏移（上文尾部长度）。 */
  markedOffset: number;
  /** 注入后的标记文本（beforeFragment+afterFragment），还原时换算区间并逐字校验。 */
  markText: string;
};

/**
 * 以变更片段 + 前后各 ANCHOR_CONTEXT 字符上下文构造定位 key（取代整段
 * proposal.before 做 key——长段落搜索 rangeCount=0 的缺口）。片段距段首/段尾
 * 不足 20 字符时取实际可用上下文；片段本身过长（如整段改写）时 key 只含片段
 * 头部，replaceEnd 落在 key 之外；纯插入（beforeFragment 为空）用锚点前后文本
 * 定位插入点。blockText 在锚点处与 beforeFragment 逐字不一致（stale base 的
 * 片段级等价校验）或 key 为空（空块纯插入）时返回 null。
 */
export function buildAnchor(blockText: string, anchor: MarkAnchor): FragmentAnchor | null {
  const { offset, change } = anchor;
  if (offset < 0 || offset > blockText.length) return null;
  const fragmentLength = change.beforeFragment.length;
  if (blockText.slice(offset, offset + fragmentLength) !== change.beforeFragment) return null;
  const keyStart = Math.max(0, offset - ANCHOR_CONTEXT);
  let keyEnd: number;
  if (fragmentLength === 0) {
    keyEnd = Math.min(blockText.length, offset + ANCHOR_CONTEXT);
  } else if (fragmentLength <= ANCHOR_CONTEXT) {
    keyEnd = Math.min(blockText.length, offset + fragmentLength + ANCHOR_CONTEXT);
  } else {
    keyEnd = offset + ANCHOR_CONTEXT;
  }
  const key = blockText.slice(keyStart, keyEnd);
  if (!key) return null;
  let occurrence = 0;
  let occurrences = 0;
  let index = blockText.indexOf(key);
  while (index >= 0) {
    if (index < keyStart) occurrence += 1;
    occurrences += 1;
    index = blockText.indexOf(key, index + 1);
  }
  const contextBefore = blockText.slice(keyStart, offset);
  const markText = markKey(change.beforeFragment, change.afterFragment);
  return {
    key,
    keyStart,
    replaceStart: offset,
    replaceEnd: offset + fragmentLength,
    occurrence,
    occurrences,
    markedKey: `${contextBefore}${markText.slice(0, ANCHOR_CONTEXT)}`,
    markedOffset: contextBefore.length,
    markText,
  };
}

/**
 * ordinal 消歧（沿用 OfficeCanvas.tsx 既有模式）：在文本相同的非表格块中
 * 找 proposal.blockId 的序号，用于 getKeywordRangeList 多命中时取第几段。
 */
export function duplicateBlockOrdinal(
  blocks: Block[],
  blockId: string,
  normalizedText: string,
): number {
  if (!normalizedText) return 0;
  const duplicates = blocks.filter(
    (block) => block.kind !== "table" && block.text.replace(/\s+/g, "").trim() === normalizedText,
  );
  const ordinal = duplicates.findIndex((block) => block.id === blockId);
  return Math.max(0, ordinal);
}

/**
 * 多 pending 注入顺序：按文档位置倒序（块序降序，同块偏移降序），
 * 避免前面注入变长影响后续定位。只保留可注入的提案。
 */
export function planInjectionOrder(proposals: Proposal[], blocks: Block[]): Proposal[] {
  const orderOf = new Map(blocks.map((block, index) => [block.id, index]));
  return proposals
    .filter((proposal) => canInjectMark(proposal, blocks))
    .map((proposal) => ({ proposal, anchor: markAnchor(proposal)! }))
    .sort((a, b) =>
      (orderOf.get(b.proposal.blockId) ?? -1) - (orderOf.get(a.proposal.blockId) ?? -1) ||
      b.anchor.offset - a.anchor.offset,
    )
    .map((entry) => entry.proposal);
}

/**
 * 保存前确认（Task 2）的待审提案计数：status 为 proposed/pending 即视为待审，
 * 含已注入修订标记与仅 rail 展示的提案。手动保存会 supersede 全部待审提案。
 */
export function countPendingProposals(proposals: Proposal[]): number {
  return proposals.filter(
    (proposal) => proposal.status === "proposed" || proposal.status === "pending",
  ).length;
}

/** 保存前确认的文案（window.confirm，确认=保存并关闭提案，取消=中止保存）。 */
export function buildSaveConfirmMessage(pendingCount: number): string {
  return `保存将关闭 ${pendingCount} 条待审提案，修订标记会一并消失。保存并关闭提案？`;
}

/**
 * 保存兜底的全量还原顺序：按块文档序倒序（文档后部的标记先还原）。
 * restoreMark 每次按 key 重新定位，倒序可避免前面还原改变文本长度后
 * 影响后面标记的命中序号；同块保持插入序（注入时同块已是偏移降序）。
 */
export function planMarkRestoreOrder(
  marks: ReadonlyMap<string, { blockId: string }>,
  blocks: Block[],
): string[] {
  const orderOf = new Map(blocks.map((block, index) => [block.id, index]));
  return [...marks.entries()]
    .sort((a, b) => (orderOf.get(b[1].blockId) ?? -1) - (orderOf.get(a[1].blockId) ?? -1))
    .map(([id]) => id);
}

/**
 * 在元素流中定位指定提案的全部标记 spans 覆盖的字符区间 [start, end)。
 * 用户在标记内编辑可能把标记 spans 切开，这里取首末标记之间的整段（含缝隙），
 * 供篡改检测的强制还原使用。计数口径与 sliceElements 一致（只算顶层 value）。
 */
export function locateMarkRun(elements: IElement[], proposalId: string): { start: number; end: number } | null {
  let position = 0;
  let start = -1;
  let end = -1;
  for (const element of elements) {
    const length = (element.value ?? "").length;
    if (markProposalId(element) === proposalId) {
      if (start < 0) start = position;
      end = position + length;
    }
    position += length;
  }
  return start < 0 ? null : { start, end };
}

/**
 * 从元素流中按字符区间 [start, end) 切出快照片段；部分重叠的元素按字符切分。
 * 用于 injectMark 捕获被替换区域的原文（OfficeCanvas 侧再 structuredClone）。
 */
export function sliceElements(elements: IElement[], start: number, end: number): IElement[] {
  const result: IElement[] = [];
  if (end <= start) return result;
  let position = 0;
  for (const element of elements) {
    const value = element.value ?? "";
    const next = position + value.length;
    if (value && next > start && position < end) {
      const clone: IElement = {
        ...element,
        value: value.slice(Math.max(0, start - position), Math.min(value.length, end - position)),
      };
      delete clone.id;
      result.push(clone);
    }
    position = next;
    if (position >= end) break;
  }
  return result;
}
