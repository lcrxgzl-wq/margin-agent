import Editor, {
  EditorMode,
  RowFlex,
  type IElement,
  type IRangeStyle,
} from "@hufe921/canvas-editor";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold as BoldIcon,
  Eye,
  Italic as ItalicIcon,
  Pencil,
  Redo2,
  RotateCcw,
  Save,
  Underline as UnderlineIcon,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MAX_SELECTION_BLOCKS,
  type SelectionBlockRange,
} from "@margin/domain";
import {
  fetchNativeDocx,
  NativeDocxRebuildRequiredError,
  saveNativeDocx,
  type Block,
  type Comment,
  type DocumentMeta,
  type Proposal,
} from "../api";
import {
  buildOfficeSelectionRanges,
  canvasFocusRangeIndexes,
  createOfficeBlockResolver,
  findSelectionStart,
  resolveOfficeBlocksForRange,
  splitOfficeSelectionParagraphs,
} from "../office/blockSelection";
import {
  officeEditorReadOnly,
  withInternalEditorEdit,
  type OfficeEditorMode,
} from "../office/editorMode";
import { importDocxIntoCanvas } from "../office/docxImport";
import {
  buildAnchor,
  buildMarkSpans,
  canInjectMark,
  duplicateBlockOrdinal,
  locateMarkRun,
  buildSaveConfirmMessage,
  countPendingProposals,
  markAnchor,
  markBaseStyle,
  markProposalId,
  planInjectionOrder,
  planMarkRestoreOrder,
  proposalFocusQueries,
  proposalsToReinjectAfterSave,
  selectionContainsMark,
  sliceElements,
} from "../office/revisionMarks";
import { readableMobilePageScale } from "../layoutGeometry";
import type { CanvasFocusRequest, TableCellSelection } from "./canvasTypes";

type SelectionInfo = {
  blockId: string | null;
  blockIds?: string[];
  selectionRanges?: SelectionBlockRange[];
  text: string;
  selectionStart?: number;
  tableCell?: TableCellSelection;
  /** True when the range spans more than one table cell. */
  crossTableCells?: boolean;
  anchor?: { x: number; y: number } | null;
  programmaticThreadId?: string;
};

type Props = {
  document: DocumentMeta;
  blocks: Block[];
  proposals: Proposal[];
  comments: Comment[];
  busy: boolean;
  activeProposalId?: string | null;
  focusRequest?: CanvasFocusRequest | null;
  onAccept: (proposalId: string) => void;
  onEdit: (proposalId: string, editedText: string) => void;
  onUndo: (proposalId: string) => void;
  onRewrite: (proposalId: string, blockId: string) => void;
  onSelectionChange: (info: SelectionInfo) => void;
  onContextMenu: (info: {
    x: number;
    y: number;
    blockId: string | null;
    blockIds?: string[];
    selectionRanges?: SelectionBlockRange[];
    text: string;
    selectionStart?: number;
    tableCell?: TableCellSelection;
    crossTableCells?: boolean;
  }) => void;
  onDirtyChange: (dirty: boolean) => void;
  onDocumentSaved: (document: DocumentMeta, blocks: Block[]) => void;
  onSaveHandlerChange?: (save: (() => Promise<boolean>) | null) => void;
  onReadyChange?: (ready: boolean) => void;
  /** 篡改检测强制还原修订标记后给出提示（App 侧 appendMessage）。 */
  onMarkNotice?: (text: string) => void;
  /** Bumped when the app-level selection is cleared; collapses the editor range. */
  clearSelectionSignal?: number;
};

type ToolButtonProps = {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
};

/** 一条已注入修订标记的记录（Y/N/E 联动、保存兜底与篡改检测见 Task 3）。 */
type MarkRecord = {
  /** 注入前被替换区域的原文快照（选中区原始元素克隆）。 */
  snapshot: IElement[];
  /** 注入后定位标记的锚定 key（上文尾部 + 标记文本头部；del 保留原文故仍逐字命中）。 */
  key: string;
  blockId: string;
  /** key 在 getKeywordRangeList 中的命中序号（注入时按绝对位置记录）。 */
  occurrence: number;
  /** 纯插入注入时向左扩选的字符数（保证快照非空，还原不必走 backspace）。 */
  expandLeft: number;
  /** key 命中区起点到标记文本起点的偏移（上文尾部长度）。 */
  markOffset: number;
  /** 注入后的标记文本（del+ins），还原时换算区间并逐字校验。 */
  markText: string;
};

/**
 * executeSetRange 使用原始元素下标，而 getKeywordRangeList 返回的是搜索流的
 * 字符位置；两种坐标之间隔着空段占位元素（value 为 "" 的 marker），漂移量随
 * 段落深度累积。用一段画布上确定存在的文本做探针求出漂移量 d：
 * 元素下标 = 搜索流位置 + d。探针只做 setRange + 读 selectionText，不改内容。
 */
const STREAM_PROBE_MAX_DRIFT = 150;
function probeStreamDrift(editor: Editor, streamPos: number, expectedText: string): number | null {
  if (!expectedText) return null;
  const previous = editor.command.getRange();
  for (let step = 0; step <= STREAM_PROBE_MAX_DRIFT; step += 1) {
    const candidates = step === 0 ? [0] : [step, -step];
    for (const d of candidates) {
      const start = streamPos + d - 1;
      if (start < 0) continue;
      // 选中区 = 元素 [start+1 .. end]，个数 = end - start，故 end = start + 长度。
      editor.command.executeSetRange(start, start + expectedText.length);
      const context = editor.command.getRangeContext();
      if (context?.selectionText === expectedText) return d;
    }
  }
  if (previous) {
    editor.command.executeSetRange(
      previous.startIndex,
      previous.endIndex,
      previous.tableId,
      previous.startTdIndex,
      previous.endTdIndex,
      previous.startTrIndex,
      previous.endTrIndex,
    );
  }
  return null;
}

function utf16OffsetAtStreamOffset(text: string, query: string, streamOffset: number): number | null {
  let offset = text.indexOf(query);
  while (offset >= 0) {
    if (Array.from(text.slice(0, offset)).length === streamOffset) return offset;
    offset = text.indexOf(query, offset + Math.max(query.length, 1));
  }
  return null;
}

/** Match the live canvas range to one keyword occurrence before restoring it. */
function preciseCanvasSelectionStart(
  editor: Editor,
  blockText: string,
  selectedText: string,
  tableCell: TableCellSelection | undefined,
): number | null {
  if (!selectedText || !blockText) return null;
  const current = editor.command.getRange();
  const sameTableTarget = (candidate: ReturnType<Editor["command"]["getRange"]>) =>
    tableCell
      ? candidate.tableId === current.tableId &&
        candidate.startTrIndex === current.startTrIndex &&
        candidate.startTdIndex === current.startTdIndex
      : !candidate.tableId;
  const candidates = editor.command.getKeywordRangeList(selectedText)
    .filter((candidate) =>
      sameTableTarget(candidate) &&
      Math.abs(candidate.startIndex - (current.startIndex + 1)) <= STREAM_PROBE_MAX_DRIFT + 1,
    );
  let selectedRange: (typeof candidates)[number] | undefined;
  try {
    for (const candidate of candidates) {
      const drift = probeStreamDrift(editor, candidate.startIndex, selectedText);
      if (
        drift != null &&
        current.startIndex === candidate.startIndex + drift - 1 &&
        current.endIndex === candidate.endIndex + drift
      ) {
        selectedRange = candidate;
        break;
      }
    }
  } finally {
    editor.command.executeSetRange(
      current.startIndex,
      current.endIndex,
      current.tableId,
      current.startTdIndex,
      current.endTdIndex,
      current.startTrIndex,
      current.endTrIndex,
    );
  }
  if (!selectedRange) return null;
  const containers = editor.command.getKeywordRangeList(blockText).filter(sameTableTarget);
  const container = containers.find((candidate) =>
    candidate.startIndex <= selectedRange.startIndex && candidate.endIndex >= selectedRange.endIndex,
  );
  if (!container) return null;
  return utf16OffsetAtStreamOffset(
    blockText,
    selectedText,
    selectedRange.startIndex - container.startIndex,
  );
}

function canvasRangeKey(range: ReturnType<Editor["command"]["getRange"]>): string {
  return JSON.stringify([
    range.startIndex,
    range.endIndex,
    range.tableId ?? null,
    range.startTdIndex ?? null,
    range.endTdIndex ?? null,
    range.startTrIndex ?? null,
    range.endTrIndex ?? null,
  ]);
}

function ToolButton({ label, active, disabled, onClick, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`office-tool${active ? " active" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function elementText(elements: IElement[] | null): string {
  if (!elements) return "";
  return elements
    .flatMap((element) => {
      if (element.valueList?.length) return elementText(element.valueList);
      if (element.trList?.length) {
        return element.trList.flatMap((row) =>
          row.tdList.map((cell) => elementText(cell.value)).join("\t"),
        );
      }
      return element.value ?? "";
    })
    .join("");
}

/**
 * Split range paragraph elements into per-paragraph texts (best effort).
 * Does not recurse into valueList, so the count may be lower than the actual
 * range paragraph count; mismatched paragraphs score zero and are dropped.
 */
function splitRangeParagraphTexts(elements: IElement[] | null): string[] {
  if (!elements?.length) return [];
  const texts: string[] = [];
  let current = "";
  for (const element of elements) {
    if (element.trList?.length) {
      if (current) { texts.push(current); current = ""; }
      texts.push(elementText([element]));
      continue;
    }
    const value = element.value ?? "";
    if (/\r?\n/.test(value)) {
      const parts = value.split(/\r?\n/);
      parts.forEach((part, index) => {
        current += part;
        if (index < parts.length - 1) { texts.push(current); current = ""; }
      });
    } else {
      current += value;
    }
  }
  if (current) texts.push(current);
  return texts;
}

function smallestTableFontSize(elements: IElement[]): number | null {
  let smallest = Number.POSITIVE_INFINITY;
  const visit = (items: IElement[]) => {
    for (const element of items) {
      if (element.trList?.length) {
        for (const row of element.trList) {
          for (const cell of row.tdList) visit(cell.value);
        }
      }
      if (element.valueList?.length) visit(element.valueList);
      if (element.value?.trim() && typeof element.size === "number" && element.size > 0) {
        smallest = Math.min(smallest, element.size);
      }
    }
  };
  visit(elements);
  return Number.isFinite(smallest) ? smallest : null;
}

function tableColumnAddress(column: number): string {
  let value = column;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function currentTableCell(context: ReturnType<Editor["command"]["getRangeContext"]>): TableCellSelection | undefined {
  if (!context?.isTable || context.trIndex == null || context.tdIndex == null || !context.tableElement?.trList) {
    return undefined;
  }
  const row = context.trIndex + 1;
  const cells = context.tableElement.trList[context.trIndex]?.tdList;
  const cell = cells?.[context.tdIndex];
  if (!cell) return undefined;
  let column = typeof cell.colIndex === "number" ? cell.colIndex + 1 : 1;
  if (typeof cell.colIndex !== "number") {
    for (let index = 0; index < context.tdIndex; index += 1) {
      column += Math.max(1, cells?.[index]?.colspan ?? 1);
    }
  }
  return {
    row,
    column,
    address: `${tableColumnAddress(column)}${row}`,
    before: elementText(cell.value).trim(),
  };
}

const EMPTY_STYLE: Pick<IRangeStyle, "font" | "size" | "bold" | "italic" | "underline" | "rowFlex" | "undo" | "redo"> = {
  font: "Times New Roman",
  size: 16,
  bold: false,
  italic: false,
  underline: false,
  rowFlex: null,
  undo: false,
  redo: false,
};

function installMinimumCanvasPixelRatio(minimum = 2): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  const initial = window.devicePixelRatio || 1;
  const readNative = original?.get ? original.get.bind(window) : () => initial;
  try {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      enumerable: original?.enumerable ?? true,
      get: () => Math.max(minimum, readNative()),
    });
  } catch {
    return () => undefined;
  }
  return () => {
    if (original) Object.defineProperty(window, "devicePixelRatio", original);
    else Reflect.deleteProperty(window, "devicePixelRatio");
  };
}

export function OfficeCanvas(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const initializedRef = useRef(false);
  const loadedRevisionRef = useRef<number | null>(null);
  const onSelectionChangeRef = useRef(props.onSelectionChange);
  const onDirtyChangeRef = useRef(props.onDirtyChange);
  const onDocumentSavedRef = useRef(props.onDocumentSaved);
  const onSaveHandlerChangeRef = useRef(props.onSaveHandlerChange);
  const onContextMenuRef = useRef(props.onContextMenu);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const manualSaveWarningAcceptedRef = useRef(false);
  const pageScaleRef = useRef(1);
  const mobileAutoFitRef = useRef(false);
  const lastSaveModeRef = useRef<"ooxml_patch" | "rebuilt" | null>(null);
  const changedBlockIdsRef = useRef(new Set<string>());
  const marksRef = useRef(new Map<string, MarkRecord>());
  const loadGenerationRef = useRef(0);
  const programmaticRevealRef = useRef(false);
  const programmaticRevealGenerationRef = useRef(0);
  const editorShouldReadOnlyRef = useRef(false);
  const suppressDirtyRef = useRef(false);
  const observedDocumentRevisionRef = useRef(props.document.revision);
  const pendingProgrammaticContentChangesRef = useRef(0);
  const dirtyRef = useRef(false);
  const contentChangeCountRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<OfficeEditorMode>("edit");
  const [zoom, setZoom] = useState(100);
  const [style, setStyle] = useState(EMPTY_STYLE);
  const blockResolver = useMemo(() => createOfficeBlockResolver(props.blocks), [props.blocks]);
  const blockResolverRef = useRef(blockResolver);
  const blocksRef = useRef(props.blocks);
  const proposalsRef = useRef(props.proposals);
  const onMarkNoticeRef = useRef(props.onMarkNotice);

  if (observedDocumentRevisionRef.current !== props.document.revision) {
    observedDocumentRevisionRef.current = props.document.revision;
    // 仅外部 revision 变化（accept 等服务端写回）需要重置并整体重载；
    // 手动保存已预同步 loadedRevisionRef（见 save()），画布内容为准，
    // 不能清 initialized/marksRef——否则保存兜底重新注入的标记会丢记录。
    if (loadedRevisionRef.current !== props.document.revision) {
      initializedRef.current = false;
      suppressDirtyRef.current = true;
      marksRef.current.clear();
    }
  }

  blockResolverRef.current = blockResolver;
  blocksRef.current = props.blocks;
  proposalsRef.current = props.proposals;
  onMarkNoticeRef.current = props.onMarkNotice;
  onSelectionChangeRef.current = props.onSelectionChange;
  onDirtyChangeRef.current = props.onDirtyChange;
  onDocumentSavedRef.current = props.onDocumentSaved;
  onSaveHandlerChangeRef.current = props.onSaveHandlerChange;
  onContextMenuRef.current = props.onContextMenu;
  editorShouldReadOnlyRef.current = officeEditorReadOnly(mode, props.busy, saving);

  const setCanvasDirty = useCallback((nextDirty: boolean) => {
    dirtyRef.current = nextDirty;
    setDirty(nextDirty);
    onDirtyChangeRef.current(nextDirty);
  }, []);

  const fitPageForViewport = useCallback((editor: Editor) => {
    const canvas = hostRef.current?.querySelector<HTMLCanvasElement>('canvas[data-index="0"]');
    const scroll = scrollRef.current;
    if (!canvas || !scroll) return;
    if (window.innerWidth > 960) {
      if (mobileAutoFitRef.current) {
        mobileAutoFitRef.current = false;
        editor.command.executePageScaleRecovery();
      }
      return;
    }
    const currentScale = pageScaleRef.current || 1;
    const baseWidth = canvas.getBoundingClientRect().width / currentScale;
    if (!baseWidth) return;
    const scale = readableMobilePageScale(baseWidth, scroll.clientWidth - 20);
    mobileAutoFitRef.current = true;
    editor.command.executePageScale(scale);
  }, []);

  const emitSelection = useCallback((programmaticThreadId?: string) => {
    if (programmaticRevealRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    const context = editor.command.getRangeContext();
    if (!context) {
      onSelectionChangeRef.current({ blockId: null, text: "", anchor: null });
      return;
    }
    const text = context.selectionText ?? editor.command.getRangeText() ?? "";
    const paragraphElements = editor.command.getRangeParagraph();
    const paragraphText = elementText(paragraphElements);
    const paragraphCount = context.endParagraphNo - context.startParagraphNo + 1;
    const paragraphSelections = text
      ? splitOfficeSelectionParagraphs(context.selectionElementList, paragraphCount)
      : null;
    const { blockId, blockIds } = resolveOfficeBlocksForRange(
      blockResolverRef.current,
      context,
      text,
      paragraphText,
      paragraphSelections ?? splitRangeParagraphTexts(paragraphElements),
    );
    const block = blocksRef.current.find((candidate) => candidate.id === blockId);
    const startElementIndex = paragraphElements?.indexOf(context.startElement) ?? -1;
    const preferredStart = startElementIndex >= 0 && paragraphElements
      ? elementText(paragraphElements.slice(0, startElementIndex)).length
      : undefined;
    const tableCell = currentTableCell(context);
    const range = editor.command.getRange();
    const stableRangeKey = canvasRangeKey(range);
    const crossTableCells = Boolean(
      context.isTable &&
        (range.isCrossRowCol ||
          (range.startTdIndex != null &&
            range.endTdIndex != null &&
            (range.startTdIndex !== range.endTdIndex || range.startTrIndex !== range.endTrIndex))),
    );
    let preciseSelectionStart: number | null = null;
    if (text && (tableCell || block) && (!blockIds || blockIds.length === 1)) {
      const revealGeneration = ++programmaticRevealGenerationRef.current;
      programmaticRevealRef.current = true;
      try {
        preciseSelectionStart = preciseCanvasSelectionStart(
          editor,
          tableCell?.before ?? block!.text,
          text,
          tableCell,
        );
      } finally {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (programmaticRevealGenerationRef.current !== revealGeneration) return;
          programmaticRevealRef.current = false;
          if (editorRef.current !== editor) return;
          if (canvasRangeKey(editor.command.getRange()) !== stableRangeKey) emitSelection(programmaticThreadId);
        }));
      }
    }
    const selectionStart = text
      ? tableCell
        ? preciseSelectionStart ?? findSelectionStart(tableCell.before, text, preferredStart)
        : block
          ? preciseSelectionStart ?? findSelectionStart(block.text, text, preferredStart)
          : null
      : null;
    const resolvedBlockIds = blockIds?.length ? blockIds : blockId ? [blockId] : [];
    const selectionRanges = !tableCell && resolvedBlockIds.length <= MAX_SELECTION_BLOCKS
      ? buildOfficeSelectionRanges(
          blocksRef.current,
          resolvedBlockIds,
          text,
          paragraphSelections,
          selectionStart ?? undefined,
        ) ?? undefined
      : undefined;
    const canonicalSelectionText = selectionRanges?.map((range) => range.before).join("") ?? text;
    const canonicalSelectionStart = selectionRanges?.[0]?.start ?? selectionStart ?? undefined;
    const rangeRect = context.rangeRects.at(-1);
    const hostRect = hostRef.current?.getBoundingClientRect();
    const rangeAnchor = rangeRect && hostRect
      ? {
          x: Math.min(window.innerWidth - 12, Math.max(12, hostRect.left + rangeRect.x + rangeRect.width / 2)),
          y: Math.max(12, hostRect.top + rangeRect.y),
        }
      : null;
    onSelectionChangeRef.current({
      blockId,
      blockIds,
      selectionRanges,
      text: canonicalSelectionText,
      selectionStart: canonicalSelectionStart,
      tableCell,
      crossTableCells,
      anchor: text.trim() ? rangeAnchor ?? lastPointerRef.current : null,
      programmaticThreadId,
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    const loadGeneration = ++loadGenerationRef.current;
    const loadAbort = new AbortController();
    const host = hostRef.current;
    if (!host) return;

    setLoading(true);
    props.onReadyChange?.(false);
    setError(null);
    setCanvasDirty(false);
    changedBlockIdsRef.current.clear();
    marksRef.current.clear();
    programmaticRevealGenerationRef.current += 1;
    programmaticRevealRef.current = false;
    suppressDirtyRef.current = true;
    initializedRef.current = false;
    loadedRevisionRef.current = props.document.revision;
    host.replaceChildren();
    const restorePixelRatio = installMinimumCanvasPixelRatio(2);
    const editor = new Editor(host, { main: [{ value: "" }] }, {
      mode: EditorMode.EDIT,
      locale: "zhCN",
      defaultFont: "Times New Roman",
      defaultSize: 16,
      pageGap: 18,
      scale: 1,
      scrollContainerSelector: `#${scrollRef.current?.id}`,
      table: { tdPadding: [6, 8, 6, 8] },
    });
    Reflect.set(host, "__marginOfficeDiagnostics", () => {
      const main = editor.command.getValue().data.main;
      const smallestTableSize = smallestTableFontSize(main);
      return {
        elements: main.length,
        text: editor.command.getText().main.length,
        range: editor.command.getRange(),
        cursor: editor.command.getCursorPosition(),
        context: editor.command.getRangeContext(),
        backingRatios: [...host.querySelectorAll("canvas")].map((canvas) => {
          const cssWidth = canvas.getBoundingClientRect().width;
          return cssWidth > 0 ? canvas.width / cssWidth : 0;
        }),
        pageScale: pageScaleRef.current,
        smallestTableFontPixels: smallestTableSize == null
          ? null
          : Number((smallestTableSize * pageScaleRef.current).toFixed(2)),
        lastSaveMode: lastSaveModeRef.current,
        changedBlockIds: [...changedBlockIdsRef.current],
        dirty: dirtyRef.current,
        contentChanges: contentChangeCountRef.current,
        suppressDirty: suppressDirtyRef.current,
        initialized: initializedRef.current,
      };
    });
    Reflect.set(host, "__marginOfficeTestSelect", (query: string, occurrence = 0) => {
      const ranges = editor.command.getKeywordRangeList(query);
      const range = ranges[occurrence];
      if (!range) return null;
      // 搜索流位置 → 元素下标漂移校正（与 injectMark 同源）。
      const drift = probeStreamDrift(editor, range.startIndex, query) ?? 0;
      suppressDirtyRef.current = true;
      pendingProgrammaticContentChangesRef.current += 1;
      editor.command.executeSetRange(
        Math.max(0, range.startIndex + drift - 1),
        range.endIndex + drift,
        range.tableId,
        range.startTdIndex,
        range.endTdIndex,
        range.startTrIndex,
        range.endTrIndex,
      );
      queueMicrotask(() => emitSelection());
      requestAnimationFrame(() => requestAnimationFrame(() => {
        suppressDirtyRef.current = false;
      }));
      return {
        ...range,
        startIndex: range.startIndex + drift,
        endIndex: range.endIndex + drift,
      };
    });
    Reflect.set(host, "__marginOfficeTestCursorAfter", (query: string, occurrence = 0) => {
      const ranges = editor.command.getKeywordRangeList(query);
      const range = ranges[occurrence];
      if (!range) return null;
      const drift = probeStreamDrift(editor, range.startIndex, query) ?? 0;
      suppressDirtyRef.current = true;
      pendingProgrammaticContentChangesRef.current += 1;
      editor.command.executeSetRange(
        range.endIndex + drift,
        range.endIndex + drift,
        range.tableId,
        range.endTdIndex,
        range.endTdIndex,
        range.endTrIndex,
        range.endTrIndex,
      );
      queueMicrotask(() => emitSelection());
      requestAnimationFrame(() => requestAnimationFrame(() => {
        suppressDirtyRef.current = false;
      }));
      return range;
    });
    Reflect.set(host, "__marginOfficeTestRange", (startIndex: number, endIndex: number) => {
      suppressDirtyRef.current = true;
      pendingProgrammaticContentChangesRef.current += 1;
      editor.command.executeSetRange(startIndex, endIndex);
      queueMicrotask(() => emitSelection());
      requestAnimationFrame(() => requestAnimationFrame(() => {
        suppressDirtyRef.current = false;
      }));
      return editor.command.getRangeText();
    });
    // 走查/门禁用只读探针：读出画布内全部修订标记 spans（含样式）与正文纯文本。
    Reflect.set(host, "__marginOfficeGetMarks", () => {
      const main = editor.command.getValue({ extraPickAttrs: ["extension"] }).data.main;
      const marks: Array<{
        proposalId: string;
        text: string;
        strikeout: boolean;
        underline: boolean;
        color: string | null;
      }> = [];
      for (const element of main) {
        const proposalId = markProposalId(element);
        if (!proposalId) continue;
        marks.push({
          proposalId,
          text: element.value ?? "",
          strikeout: element.strikeout === true,
          underline: element.underline === true,
          color: element.color ?? null,
        });
      }
      return { marks, text: editor.command.getText().main };
    });
    editorRef.current = editor;
    editor.listener.contentChange = () => {
      contentChangeCountRef.current += 1;
      if (pendingProgrammaticContentChangesRef.current > 0) {
        pendingProgrammaticContentChangesRef.current -= 1;
        return;
      }
      if (initializedRef.current && !suppressDirtyRef.current) {
        const context = editor.command.getRangeContext();
        if (context) {
          const blockId = blockResolverRef.current({
            paragraphNo: context.startParagraphNo,
            isTable: context.isTable,
          });
          if (blockId) changedBlockIdsRef.current.add(blockId);
        }
        setCanvasDirty(true);
        // 篡改检测（Task 3）：用户编辑破坏了标记定位 key → 强制还原快照并提示。
        // inject/restore 走 isSubmitHistory:false 不触发本监听，不会误伤。
        if (marksRef.current.size) {
          let restored = false;
          let lost = false;
          for (const [id, record] of [...marksRef.current]) {
            const hits = editor.command.getKeywordRangeList(record.key).length;
            if (hits > record.occurrence) continue;
            if (forceRestoreMark(id)) restored = true;
            else lost = true;
          }
          if (restored) onMarkNoticeRef.current?.("修订标记已被手动改动，已还原");
          else if (lost) onMarkNoticeRef.current?.("修订标记已被手动删除，可在审阅面板继续处理该提案");
        }
      }
    };
    editor.listener.rangeStyleChange = (nextStyle) => {
      setStyle({
        font: nextStyle.font,
        size: nextStyle.size,
        bold: nextStyle.bold,
        italic: nextStyle.italic,
        underline: nextStyle.underline,
        rowFlex: nextStyle.rowFlex,
        undo: nextStyle.undo,
        redo: nextStyle.redo,
      });
      // preciseCanvasSelectionStart probes temporary ranges. Scheduling a new
      // selection pass for those probes creates a self-sustaining feedback loop.
      if (!programmaticRevealRef.current) queueMicrotask(emitSelection);
    };
    editor.listener.pageScaleChange = (scale) => {
      pageScaleRef.current = scale;
      setZoom(Math.round(scale * 100));
    };

    void fetchNativeDocx(props.document.id, loadAbort.signal)
      .then((buffer) => importDocxIntoCanvas(
        editor.command,
        buffer,
        () => !disposed && loadGenerationRef.current === loadGeneration && editorRef.current === editor,
      ))
      .then(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        if (disposed) return;
        fitPageForViewport(editor);
        setLoading(false);
        props.onReadyChange?.(true);
        setCanvasDirty(false);
        initializedRef.current = true;
        suppressDirtyRef.current = false;
      })
      .catch((reason) => {
        if (disposed || loadAbort.signal.aborted) return;
        suppressDirtyRef.current = false;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      disposed = true;
      loadAbort.abort();
      loadGenerationRef.current += 1;
      initializedRef.current = false;
      editor.listener.contentChange = null;
      editor.listener.rangeStyleChange = null;
      editor.listener.pageScaleChange = null;
      editor.destroy();
      restorePixelRatio();
      onDirtyChangeRef.current(false);
      Reflect.deleteProperty(host, "__marginOfficeDiagnostics");
      Reflect.deleteProperty(host, "__marginOfficeTestSelect");
      Reflect.deleteProperty(host, "__marginOfficeTestCursorAfter");
      Reflect.deleteProperty(host, "__marginOfficeTestRange");
      Reflect.deleteProperty(host, "__marginOfficeGetMarks");
      if (editorRef.current === editor) editorRef.current = null;
    };
  }, [props.document.id, emitSelection, fitPageForViewport, setCanvasDirty]);

  const locateProposalFocusRange = useCallback((editor: Editor, proposal: Proposal) => {
    const record = marksRef.current.get(proposal.id);
    if (record) {
      const markedRange = editor.command.getKeywordRangeList(record.key)[record.occurrence];
      if (markedRange) return { range: markedRange, query: record.key };
    }

    for (const query of proposalFocusQueries(proposal)) {
      const ranges = editor.command.getKeywordRangeList(query);
      if (!ranges.length) continue;
      let range = ranges[0];
      if (proposal.tableCell) {
        const tableOrdinal = blocksRef.current
          .filter((block) => block.kind === "table")
          .findIndex((block) => block.id === proposal.blockId);
        const cellRanges = ranges.filter((candidate) =>
          candidate.startTrIndex === proposal.tableCell!.row - 1
          && candidate.startTdIndex === proposal.tableCell!.column - 1,
        );
        range = cellRanges[Math.max(0, tableOrdinal)] ?? cellRanges[0] ?? range;
      } else {
        const normalizedBefore = proposal.before.replace(/\s+/g, "").trim();
        const duplicateOrdinal = blocksRef.current
          .filter((block) =>
            block.kind !== "table" && block.text.replace(/\s+/g, "").trim() === normalizedBefore,
          )
          .findIndex((block) => block.id === proposal.blockId);
        if (duplicateOrdinal >= 0) range = ranges[duplicateOrdinal] ?? range;
      }
      if (range) return { range, query };
    }
    return null;
  }, []);

  // App-level "清除" only resets store state; also collapse the canvas-editor
  // range so its painted highlight does not linger (and re-emit on next click).
  const clearSelectionSignalRef = useRef(props.clearSelectionSignal);
  useEffect(() => {
    if (clearSelectionSignalRef.current === props.clearSelectionSignal) return;
    clearSelectionSignalRef.current = props.clearSelectionSignal;
    const editor = editorRef.current;
    if (!editor || !initializedRef.current) return;
    const start = editor.command.getRange()?.startIndex ?? 0;
    editor.command.executeSetRange(start, start);
  }, [props.clearSelectionSignal]);

  useEffect(() => {
    if (loading || !props.activeProposalId) return;
    const editor = editorRef.current;
    const proposal = props.proposals.find((candidate) => candidate.id === props.activeProposalId);
    if (!editor || !proposal) return;
    const target = locateProposalFocusRange(editor, proposal);
    if (!target) return;
    const { range, query } = target;
    const revealGeneration = ++programmaticRevealGenerationRef.current;
    programmaticRevealRef.current = true;
    suppressDirtyRef.current = true;
    const streamDrift = range.tableId
      ? 0
      : probeStreamDrift(editor, range.startIndex, query);
    if (streamDrift == null) {
      programmaticRevealRef.current = false;
      suppressDirtyRef.current = false;
      return;
    }
    pendingProgrammaticContentChangesRef.current += 1;
    const focusRange = canvasFocusRangeIndexes(range, streamDrift);
    editor.command.executeSetRange(
      focusRange.startIndex,
      focusRange.endIndex,
      range.tableId,
      range.startTdIndex,
      range.endTdIndex,
      range.startTrIndex,
      range.endTrIndex,
    );
    requestAnimationFrame(() => {
      if (
        programmaticRevealGenerationRef.current !== revealGeneration ||
        editorRef.current !== editor
      ) return;
      const context = editor.command.getRangeContext();
      const rect = context?.rangeRects[0];
      const scroll = scrollRef.current;
      if (rect && scroll) {
        scroll.scrollTo({
          top: Math.max(0, rect.y - scroll.clientHeight * 0.22),
          behavior: "auto",
        });
      }
      requestAnimationFrame(() => {
        if (
          programmaticRevealGenerationRef.current !== revealGeneration ||
          editorRef.current !== editor
        ) return;
        programmaticRevealRef.current = false;
        suppressDirtyRef.current = false;
        emitSelection();
      });
    });
  }, [loading, props.activeProposalId, props.proposals, locateProposalFocusRange]);

  useEffect(() => {
    if (loading || !props.focusRequest) return;
    const editor = editorRef.current;
    if (!editor) return;
    const request = props.focusRequest;
    const proposal = request.proposalId
      ? props.proposals.find((candidate) => candidate.id === request.proposalId)
      : undefined;
    const proposalTarget = proposal ? locateProposalFocusRange(editor, proposal) : null;
    const query = request.tableCell?.before || request.query;
    if (!query.trim()) return;
    const ranges = editor.command.getKeywordRangeList(query);
    const normalizedQuery = query.replace(/\s+/g, "").trim();
    let range = proposalTarget?.range ?? ranges[0];
    if (!proposalTarget && request.tableCell) {
      const tableOrdinal = props.blocks
        .filter((block) => block.kind === "table")
        .findIndex((block) => block.id === request.blockId);
      const cellRanges = ranges.filter((candidate) =>
        candidate.startTrIndex === request.tableCell!.row - 1 &&
        candidate.startTdIndex === request.tableCell!.column - 1,
      );
      range = cellRanges[Math.max(0, tableOrdinal)] ?? cellRanges[0] ?? range;
    } else if (!proposalTarget && request.blockId) {
      const matching = props.blocks.filter((block) =>
        block.kind !== "table" && normalizedQuery && block.text.replace(/\s+/g, "").includes(normalizedQuery),
      );
      const ordinal = matching.findIndex((block) => block.id === request.blockId);
      if (ordinal >= 0) range = ranges[ordinal] ?? range;
    }
    if (!range) return;
    const focusQuery = proposalTarget?.query ?? query;
    const revealGeneration = ++programmaticRevealGenerationRef.current;
    programmaticRevealRef.current = true;
    suppressDirtyRef.current = true;
    const streamDrift = range.tableId
      ? 0
      : probeStreamDrift(editor, range.startIndex, focusQuery);
    if (streamDrift == null) {
      programmaticRevealRef.current = false;
      suppressDirtyRef.current = false;
      return;
    }
    pendingProgrammaticContentChangesRef.current += 1;
    const focusRange = canvasFocusRangeIndexes(range, streamDrift);
    editor.command.executeSetRange(
      focusRange.startIndex,
      focusRange.endIndex,
      range.tableId,
      range.startTdIndex,
      range.endTdIndex,
      range.startTrIndex,
      range.endTrIndex,
    );
    requestAnimationFrame(() => {
      if (
        programmaticRevealGenerationRef.current !== revealGeneration ||
        editorRef.current !== editor
      ) return;
      const context = editor.command.getRangeContext();
      const rect = context?.rangeRects[0];
      const scroll = scrollRef.current;
      if (rect && scroll) {
        scroll.scrollTo({
          top: Math.max(0, rect.y - scroll.clientHeight * 0.22),
          behavior: "auto",
        });
      }
      requestAnimationFrame(() => {
        if (
          programmaticRevealGenerationRef.current !== revealGeneration ||
          editorRef.current !== editor
        ) return;
        programmaticRevealRef.current = false;
        suppressDirtyRef.current = false;
        emitSelection(request.threadId);
      });
    });
  }, [loading, props.focusRequest, props.blocks, props.proposals, locateProposalFocusRange]);

  // —— 修订标记（Task 2）：pending 提案以 Word 修订样式注入画布 ——
  // 定位失败或 editor 未就绪时返回 false，提案保持 pending-rail 卡片展示，
  // 下一次 proposals/loading 变化会按 diff 重试。
  const injectMark = useCallback((proposal: Proposal): boolean => {
    const editor = editorRef.current;
    if (!editor || !initializedRef.current) return false;
    const blocks = blocksRef.current;
    if (!canInjectMark(proposal, blocks)) return false;
    const anchor = markAnchor(proposal);
    if (!anchor || !proposal.before.trim()) return false;
    const { change } = anchor;
    // 片段级锚定（Task 3）：整段 proposal.before 做 key 时长段落搜索不到
    // （rangeCount=0），改为片段 + 前后少量上下文定位，命中后换算替换区间。
    const fragment = buildAnchor(proposal.before, anchor);
    if (!fragment) return false;
    return withInternalEditorEdit(
      editor.command,
      editorShouldReadOnlyRef.current,
      () => {
        const ranges = editor.command.getKeywordRangeList(fragment.key);
        if (!ranges.length) return false;
        // ordinal 消歧沿用上方 activeProposal 定位的既有模式（块级）；
        // 全文命中序号 = 块级 ordinal × 块内 key 总数 + 块内第 N 次出现。
        const ordinal = duplicateBlockOrdinal(
          blocks,
          proposal.blockId,
          proposal.before.replace(/\s+/g, "").trim(),
        );
        const range = ranges[ordinal * fragment.occurrences + fragment.occurrence];
        if (!range || range.tableId) return false;
        // 搜索流位置 → 元素下标的漂移校正（空段占位元素所致，随段落深度累积）。
        // 探针文本用定位 key 本身——搜索在该位置逐字命中过，与服务端/画布空白差异无关。
        const drift = probeStreamDrift(editor, range.startIndex, fragment.key);
        if (drift == null) return false;
        // key 命中序号用搜索流坐标记录（与 restoreMark 的 getKeywordRangeList 同源）。
        const markOffset = fragment.replaceStart - fragment.keyStart;
        const streamFragmentStart = range.startIndex + markOffset;
        const fragmentStart = streamFragmentStart + drift;
        const fragmentLength = change.beforeFragment.length;
        // 纯插入向左扩选 1 字符，使快照非空——还原才能走 executeInsertElementList
        // （executeBackspace 会提交历史、污染 undo 栈）。
        const expandLeft = fragmentLength === 0 ? 1 : 0;
        // executeSetRange 拒绝负 start（选中被替换区需 regionStart-1），
        // 文档开头处的变更本轮不注入，降级为 rail 卡片。
        if (fragmentStart - expandLeft < 1) return false;
        editor.command.executeSetRange(fragmentStart - expandLeft - 1, fragmentStart + fragmentLength - 1);
        // 快照直接取选中区的原始元素（含样式），绕开 zip 视图与搜索流的坐标差；
        // 同时校验选中区确实是目标片段（stale-base 的片段级等价），不是再继续（防误替换）。
        const context = editor.command.getRangeContext();
        const expected = proposal.before.slice(fragment.replaceStart - expandLeft, fragment.replaceEnd);
        if (!context || context.selectionText !== expected) return false;
        const snapshot = (context.selectionElementList ?? []).map((element) => {
          const clone = { ...element };
          delete clone.id;
          return clone;
        });
        if (!snapshot.length) return false;
        const spans = [
          ...(expandLeft ? structuredClone(snapshot) : []),
          ...buildMarkSpans(
            markBaseStyle(snapshot[0]),
            change.beforeFragment,
            change.afterFragment,
            proposal.id,
          ),
        ];
        suppressDirtyRef.current = true;
        editor.command.executeInsertElementList(spans, { isSubmitHistory: false });
        const markedMain = editor.command.getValue({ extraPickAttrs: ["extension"] }).data.main;
        if (!locateMarkRun(markedMain, proposal.id)) {
          suppressDirtyRef.current = false;
          return false;
        }
        // 收回光标到标记前（参照 __marginOfficeTestCursorAfter 模式），避免光标留在标记内。
        editor.command.executeSetRange(fragmentStart - 1, fragmentStart - 1);
        // 注入后定位用 markedKey（上文尾部 + 标记文本头部）：含后上下文的 key
        // 会被插入的 ins 文本截断而失效。markedKey 命中起点与注入前 key 相同。
        const keyRanges = editor.command.getKeywordRangeList(fragment.markedKey);
        const occurrence = Math.max(
          0,
          keyRanges.findIndex((candidate) => candidate.startIndex === range.startIndex),
        );
        marksRef.current.set(proposal.id, {
          snapshot,
          key: fragment.markedKey,
          blockId: proposal.blockId,
          occurrence,
          expandLeft,
          markOffset: fragment.markedOffset,
          markText: fragment.markText,
        });
        requestAnimationFrame(() => {
          suppressDirtyRef.current = false;
        });
        return true;
      },
    );
  }, []);

  // 用快照原文替换标记片段。定位失败时保留记录，交给 Task 3 篡改检测/保存兜底。
  const restoreMark = useCallback((proposalId: string): boolean => {
    const record = marksRef.current.get(proposalId);
    if (!record) return false;
    const editor = editorRef.current;
    if (!editor || !initializedRef.current) return false;
    return withInternalEditorEdit(
      editor.command,
      editorShouldReadOnlyRef.current,
      () => {
        const ranges = editor.command.getKeywordRangeList(record.key);
        // 严格取记录的命中序号；对不上说明 key 已被编辑破坏，交给
        // forceRestoreMark 的 extension 扫描兜底，不做 ?? ranges[0] 静默回退。
        const range = ranges[record.occurrence];
        if (!range) return false;
        // 同 injectMark：搜索流位置 → 元素下标的漂移校正（探针文本用 key 本身）。
        const drift = probeStreamDrift(editor, range.startIndex, record.key);
        if (drift == null) return false;
        // 标记文本起点 = key 命中区起点 + 上文尾部偏移；还原区间 = （左扩字符 +）标记文本。
        const markStart = range.startIndex + drift + record.markOffset;
        const regionStart = Math.max(1, markStart - record.expandLeft);
        const regionEnd = markStart + record.markText.length - 1;
        editor.command.executeSetRange(
          regionStart - 1,
          regionEnd,
          range.tableId,
          range.startTdIndex,
          range.endTdIndex,
          range.startTrIndex,
          range.endTrIndex,
        );
        // 选中区必须是（左扩字符 +）标记文本原文，否则保留记录交给扫描兜底。
        const snapshotText = record.snapshot.map((element) => element.value).join("");
        const expected = snapshotText.slice(0, record.expandLeft) + record.markText;
        const context = editor.command.getRangeContext();
        if (
          !context
          || context.selectionText !== expected
          || !selectionContainsMark(context.selectionElementList ?? [], proposalId)
        ) return false;
        suppressDirtyRef.current = true;
        editor.command.executeInsertElementList(structuredClone(record.snapshot), { isSubmitHistory: false });
        const restoredMain = editor.command.getValue({ extraPickAttrs: ["extension"] }).data.main;
        if (locateMarkRun(restoredMain, proposalId)) {
          suppressDirtyRef.current = false;
          return false;
        }
        editor.command.executeSetRange(regionStart - 1, regionStart - 1);
        marksRef.current.delete(proposalId);
        requestAnimationFrame(() => {
          suppressDirtyRef.current = false;
        });
        return true;
      },
    );
  }, []);

  // key 失效（用户在标记内编辑把 key 改坏）时的兜底还原：按 extension
  // 扫描定位该提案残留的标记 spans，用快照替换整段（含左扩字符）。
  const restoreMarkByScan = useCallback((proposalId: string): boolean => {
    const record = marksRef.current.get(proposalId);
    const editor = editorRef.current;
    if (!record || !editor || !initializedRef.current) return false;
    return withInternalEditorEdit(
      editor.command,
      editorShouldReadOnlyRef.current,
      () => {
        const main = editor.command.getValue({ extraPickAttrs: ["extension"] }).data.main;
        const run = locateMarkRun(main, proposalId);
        if (!run) return false;
        const runText = sliceElements(main, run.start, run.end)
          .map((element) => element.value)
          .join("");
        if (!runText) return false;
        // run.start 是 zip 视图坐标；重新按文本搜索并对齐到元素下标。
        const snapshotText = record.snapshot.map((element) => element.value).join("");
        const expected = snapshotText.slice(0, record.expandLeft) + runText;
        let regionStart: number | null = null;
        for (const hit of editor.command.getKeywordRangeList(runText)) {
          const drift = probeStreamDrift(editor, hit.startIndex, runText);
          if (drift == null) continue;
          const candidateStart = Math.max(1, hit.startIndex + drift - record.expandLeft);
          const candidateEnd = hit.startIndex + drift + runText.length - 1;
          editor.command.executeSetRange(
            candidateStart - 1,
            candidateEnd,
            hit.tableId,
            hit.startTdIndex,
            hit.endTdIndex,
            hit.startTrIndex,
            hit.endTrIndex,
          );
          const context = editor.command.getRangeContext();
          if (
            context?.selectionText === expected
            && selectionContainsMark(context.selectionElementList ?? [], proposalId)
          ) {
            regionStart = candidateStart;
            break;
          }
        }
        if (regionStart == null) return false;
        suppressDirtyRef.current = true;
        editor.command.executeInsertElementList(structuredClone(record.snapshot), { isSubmitHistory: false });
        const restoredMain = editor.command.getValue({ extraPickAttrs: ["extension"] }).data.main;
        if (locateMarkRun(restoredMain, proposalId)) {
          suppressDirtyRef.current = false;
          return false;
        }
        editor.command.executeSetRange(regionStart - 1, regionStart - 1);
        marksRef.current.delete(proposalId);
        requestAnimationFrame(() => {
          suppressDirtyRef.current = false;
        });
        return true;
      },
    );
  }, []);

  // 篡改检测/保存兜底共用：先走 key 定位，失败退回 extension 扫描；
  // 两者都失败说明标记 spans 已不存在（无样式可泄漏），丢弃记录即可。
  const forceRestoreMark = useCallback((proposalId: string): boolean => {
    if (restoreMark(proposalId)) return true;
    if (restoreMarkByScan(proposalId)) return true;
    marksRef.current.delete(proposalId);
    return false;
  }, [restoreMark, restoreMarkByScan]);

  // proposals prop diff：新增 pending → 按文档倒序注入（避免注入变长影响后续
  // ordinal）；消失 → 尽力还原快照并清理记录（N/undo 无 revision 变化时靠这里
  // 还原；Y/E 由 revision 变化触发整体重载，无需逐条还原）。
  useEffect(() => {
    if (loading) return;
    const editor = editorRef.current;
    if (!editor || !initializedRef.current) return;
    const pending = props.proposals.filter((proposal) => proposal.status === "proposed");
    const pendingIds = new Set(pending.map((proposal) => proposal.id));
    for (const id of [...marksRef.current.keys()]) {
      if (pendingIds.has(id)) continue;
      // 消失提案的还原走 forceRestoreMark（key 定位 → extension 扫描兜底），
      // 尽力清掉画布上的标记样式；forceRestoreMark 内部已负责清理记录。
      forceRestoreMark(id);
    }
    const fresh = pending.filter((proposal) => !marksRef.current.has(proposal.id));
    if (!fresh.length) return;
    for (const proposal of planInjectionOrder(fresh, blocksRef.current)) {
      injectMark(proposal);
    }
  }, [loading, props.proposals, injectMark, forceRestoreMark]);

  useEffect(() => {
    const fit = () => {
      const editor = editorRef.current;
      if (editor) requestAnimationFrame(() => fitPageForViewport(editor));
    };
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fitPageForViewport]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || loadedRevisionRef.current === props.document.revision) return;
    let cancelled = false;
    const loadGeneration = ++loadGenerationRef.current;
    const loadAbort = new AbortController();
    initializedRef.current = false;
    marksRef.current.clear();
    setLoading(true);
    props.onReadyChange?.(false);
    setError(null);
    void fetchNativeDocx(props.document.id, loadAbort.signal)
      .then((buffer) => importDocxIntoCanvas(
        editor.command,
        buffer,
        () => !cancelled && loadGenerationRef.current === loadGeneration && editorRef.current === editor,
      ))
      .then(() => {
        if (cancelled) return;
        loadedRevisionRef.current = props.document.revision;
        initializedRef.current = true;
        changedBlockIdsRef.current.clear();
        setCanvasDirty(false);
        setLoading(false);
        props.onReadyChange?.(true);
        suppressDirtyRef.current = false;
      })
      .catch((reason) => {
        if (cancelled || loadAbort.signal.aborted) return;
        suppressDirtyRef.current = false;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      loadAbort.abort();
    };
  }, [props.document.id, props.document.revision, setCanvasDirty]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || loading) return;
    editor.command.executeMode(
      officeEditorReadOnly(mode, props.busy, saving) ? EditorMode.READONLY : EditorMode.EDIT,
    );
  }, [loading, mode, props.busy, saving]);

  const command = (run: (editor: Editor) => void) => {
    const editor = editorRef.current;
    if (!editor || loading) return;
    run(editor);
  };

  const changeMode = (next: OfficeEditorMode) => {
    if (props.busy || saving) return;
    setMode(next);
    command((editor) => editor.command.executeMode(next === "edit" ? EditorMode.EDIT : EditorMode.READONLY));
  };

  const save = async (): Promise<boolean> => {
    const editor = editorRef.current;
    if (!editor || loading || saving || props.busy) return false;
    if (!dirty) return true;
    // 保存前确认（Task 2）：手动保存会 supersede 全部待审提案。确认必须
    // 发生在下面"还原→导出→重注入"兜底之前，取消时标记与提案保持原样。
    const pendingCount = countPendingProposals(proposalsRef.current);
    if (pendingCount > 0 && !window.confirm(buildSaveConfirmMessage(pendingCount))) return false;
    setSaving(true);
    editorShouldReadOnlyRef.current = true;
    editor.command.executeMode(EditorMode.READONLY);
    setError(null);
    // 保存兜底（Task 3）：修订标记的 strikeout/下划线样式绝不进 docx。
    // 一律先全量还原标记再导出，结束后重新注入仍 pending 的标记。
    // （stripMarks 对纯插入的 expandLeft 快照语义不一致，保留为纯函数不接线。）
    if (marksRef.current.size) {
      for (const id of planMarkRestoreOrder(marksRef.current, blocksRef.current)) {
        forceRestoreMark(id);
      }
    }
    let saveSucceeded = false;
    try {
      const value = editor.command.getValue();
      if (!value.data.main.length) {
        throw new Error("编辑器正文为空，已拒绝覆盖原 DOCX");
      }
      const { exportCanvasToDocx } = await import("../office/docxExport");
      const blob = await exportCanvasToDocx(value.data);
      const content = await blob.arrayBuffer();
      const confirmRebuild = (detail?: string) => {
        if (manualSaveWarningAcceptedRef.current) return true;
        const accepted = window.confirm(
          `${detail ? `${detail}\n\n` : ""}这次修改需要重建工作副本。复杂分节、批注或修订可能简化；原始文件不会修改。继续？`,
        );
        if (accepted) manualSaveWarningAcceptedRef.current = true;
        return accepted;
      };
      let result;
      try {
        result = await saveNativeDocx(
          props.document,
          content,
          "preserve",
          [...changedBlockIdsRef.current],
        );
      } catch (reason) {
        if (!(reason instanceof NativeDocxRebuildRequiredError)) throw reason;
        if (!confirmRebuild(reason.message)) return false;
        result = await saveNativeDocx(props.document, content, "rebuild", [...changedBlockIdsRef.current]);
      }
      loadedRevisionRef.current = result.document.revision;
      lastSaveModeRef.current = result.saveMode;
      changedBlockIdsRef.current.clear();
      setCanvasDirty(false);
      saveSucceeded = true;
      onDocumentSavedRef.current(result.document, result.blocks);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      // Only a failed/cancelled save keeps proposals pending. A successful save
      // supersedes them server-side, so reusing the stale prop list would revive
      // closed cards and marks until the follow-up refresh succeeds.
      const pending = proposalsToReinjectAfterSave(
        proposalsRef.current,
        new Set(marksRef.current.keys()),
        saveSucceeded,
      );
      for (const proposal of planInjectionOrder(pending, blocksRef.current)) {
        injectMark(proposal);
      }
      editorShouldReadOnlyRef.current = officeEditorReadOnly(mode, props.busy, false);
      editor.command.executeMode(
        editorShouldReadOnlyRef.current ? EditorMode.READONLY : EditorMode.EDIT,
      );
      setSaving(false);
    }
    return saveSucceeded;
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  // Register once; read handlers via refs so Canvas memo cache hits cannot drop save-and-continue.
  useEffect(() => {
    const handler = () => saveRef.current();
    onSaveHandlerChangeRef.current?.(handler);
    return () => onSaveHandlerChangeRef.current?.(null);
  }, []);

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    // Do not steal the reveal generation while a proposal/thread focus is
    // waiting for its second animation frame; that owner also guards dirty state.
    if (!editor || programmaticRevealRef.current) return;
    const text = editor.command.getRangeText();
    if (!text.trim()) return;
    const context = editor.command.getRangeContext();
    const paragraphElements = editor.command.getRangeParagraph();
    const paragraphText = elementText(paragraphElements);
    const paragraphSelections = context
      ? splitOfficeSelectionParagraphs(
          context.selectionElementList,
          context.endParagraphNo - context.startParagraphNo + 1,
        )
      : null;
    const { blockId, blockIds } = context
      ? resolveOfficeBlocksForRange(
          blockResolverRef.current,
          context,
          text,
          paragraphText,
          paragraphSelections ?? splitRangeParagraphTexts(paragraphElements),
        )
      : { blockId: null };
    const block = props.blocks.find((candidate) => candidate.id === blockId);
    const startElementIndex = context && paragraphElements
      ? paragraphElements.indexOf(context.startElement)
      : -1;
    const preferredStart = startElementIndex >= 0 && paragraphElements
      ? elementText(paragraphElements.slice(0, startElementIndex)).length
      : undefined;
    const tableCell = context ? currentTableCell(context) : undefined;
    const range = editor.command.getRange();
    const crossTableCells = Boolean(
      context?.isTable &&
        (range.isCrossRowCol ||
          (range.startTdIndex != null &&
            range.endTdIndex != null &&
            (range.startTdIndex !== range.endTdIndex || range.startTrIndex !== range.endTrIndex))),
    );
    let preciseSelectionStart: number | null = null;
    if (blockIds?.length ? blockIds.length === 1 : !!blockId) {
      const revealGeneration = ++programmaticRevealGenerationRef.current;
      programmaticRevealRef.current = true;
      try {
        preciseSelectionStart = preciseCanvasSelectionStart(
          editor,
          tableCell?.before ?? block?.text ?? "",
          text,
          tableCell,
        );
      } finally {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (programmaticRevealGenerationRef.current !== revealGeneration) return;
          programmaticRevealRef.current = false;
        }));
      }
    }
    const selectionStart = tableCell
      ? preciseSelectionStart ?? findSelectionStart(tableCell.before, text, preferredStart) ?? undefined
      : block
        ? preciseSelectionStart ?? findSelectionStart(block.text, text, preferredStart) ?? undefined
        : undefined;
    const resolvedBlockIds = blockIds?.length ? blockIds : blockId ? [blockId] : [];
    const selectionRanges = !tableCell && resolvedBlockIds.length <= MAX_SELECTION_BLOCKS
      ? buildOfficeSelectionRanges(
          props.blocks,
          resolvedBlockIds,
          text,
          paragraphSelections,
          selectionStart,
        ) ?? undefined
      : undefined;
    const canonicalSelectionText = selectionRanges?.map((range) => range.before).join("") ?? text;
    const canonicalSelectionStart = selectionRanges?.[0]?.start ?? selectionStart;
    event.preventDefault();
    onContextMenuRef.current({
      x: event.clientX,
      y: event.clientY,
      blockId,
      blockIds,
      selectionRanges,
      text: canonicalSelectionText,
      selectionStart: canonicalSelectionStart,
      tableCell,
      crossTableCells,
    });
  };

  const disabled = loading || !!error;
  const editDisabled = disabled || props.busy || saving || mode === "read";
  return (
    <div className="office-workspace">
      <div className="office-toolbar" role="toolbar" aria-label="Word 编辑工具">
        <div className="office-tool-group office-history-tools">
          <ToolButton label="撤销" disabled={editDisabled || !style.undo} onClick={() => command((e) => e.command.executeUndo())}><Undo2 /></ToolButton>
          <ToolButton label="重做" disabled={editDisabled || !style.redo} onClick={() => command((e) => e.command.executeRedo())}><Redo2 /></ToolButton>
        </div>
        <div className="office-tool-group">
          <select
            className="office-select office-font"
            aria-label="字体"
            title="字体"
            value={style.font || "Times New Roman"}
            disabled={editDisabled}
            onChange={(event) => command((e) => e.command.executeFont(event.target.value))}
          >
            {!(["Times New Roman", "Arial", "宋体", "黑体", "Calibri", "Cambria"] as Array<string | null>).includes(style.font) && style.font ? (
              <option value={style.font}>{style.font}</option>
            ) : null}
            <option value="Times New Roman">Times New Roman</option>
            <option value="Arial">Arial</option>
            <option value="Calibri">Calibri</option>
            <option value="Cambria">Cambria</option>
            <option value="宋体">宋体</option>
            <option value="黑体">黑体</option>
          </select>
          <select
            className="office-select office-size"
            aria-label="字号"
            title="字号"
            value={String(Math.round(style.size || 16))}
            disabled={editDisabled}
            onChange={(event) => command((e) => e.command.executeSize(Number(event.target.value)))}
          >
            {![12, 14, 16, 19, 21].includes(Math.round(style.size || 16)) ? (
              <option value={String(Math.round(style.size || 16))}>{Math.round((style.size || 16) * 0.75 * 10) / 10}</option>
            ) : null}
            <option value="12">9</option>
            <option value="14">10.5</option>
            <option value="16">12</option>
            <option value="19">14</option>
            <option value="21">16</option>
          </select>
        </div>
        <div className="office-tool-group">
          <ToolButton label="加粗" active={style.bold} disabled={editDisabled} onClick={() => command((e) => e.command.executeBold())}><BoldIcon /></ToolButton>
          <ToolButton label="斜体" active={style.italic} disabled={editDisabled} onClick={() => command((e) => e.command.executeItalic())}><ItalicIcon /></ToolButton>
          <ToolButton label="下划线" active={style.underline} disabled={editDisabled} onClick={() => command((e) => e.command.executeUnderline())}><UnderlineIcon /></ToolButton>
        </div>
        <div className="office-tool-group office-align-tools">
          <ToolButton label="左对齐" active={style.rowFlex === RowFlex.LEFT} disabled={editDisabled} onClick={() => command((e) => e.command.executeRowFlex(RowFlex.LEFT))}><AlignLeft /></ToolButton>
          <ToolButton label="居中" active={style.rowFlex === RowFlex.CENTER} disabled={editDisabled} onClick={() => command((e) => e.command.executeRowFlex(RowFlex.CENTER))}><AlignCenter /></ToolButton>
          <ToolButton label="右对齐" active={style.rowFlex === RowFlex.RIGHT} disabled={editDisabled} onClick={() => command((e) => e.command.executeRowFlex(RowFlex.RIGHT))}><AlignRight /></ToolButton>
          <ToolButton label="两端对齐" active={style.rowFlex === RowFlex.ALIGNMENT} disabled={editDisabled} onClick={() => command((e) => e.command.executeRowFlex(RowFlex.ALIGNMENT))}><AlignJustify /></ToolButton>
        </div>
        <div className="office-tool-group office-zoom-tools">
          <ToolButton label="缩小" disabled={disabled} onClick={() => { mobileAutoFitRef.current = false; command((e) => e.command.executePageScaleMinus()); }}><ZoomOut /></ToolButton>
          <button
            className="office-zoom"
            type="button"
            title={mobileAutoFitRef.current ? "切换到 100%" : window.innerWidth <= 960 ? "恢复移动端阅读缩放" : "恢复 100%"}
            aria-label={mobileAutoFitRef.current ? "切换到 100%" : window.innerWidth <= 960 ? "恢复移动端阅读缩放" : "恢复 100%"}
            onClick={() => command((editor) => {
              if (window.innerWidth <= 960 && !mobileAutoFitRef.current) {
                fitPageForViewport(editor);
                return;
              }
              mobileAutoFitRef.current = false;
              editor.command.executePageScaleRecovery();
            })}
          >{zoom}%</button>
          <ToolButton label="放大" disabled={disabled} onClick={() => { mobileAutoFitRef.current = false; command((e) => e.command.executePageScaleAdd()); }}><ZoomIn /></ToolButton>
        </div>
        <div className="office-toolbar-spacer" />
        <div className="office-mode" aria-label="编辑模式">
          <button type="button" className={mode === "read" ? "active" : ""} disabled={props.busy || saving} onClick={() => changeMode("read")}><Eye />阅读</button>
          <button type="button" className={mode === "edit" ? "active" : ""} disabled={props.busy || saving} onClick={() => changeMode("edit")}><Pencil />编辑</button>
        </div>
        <button className="office-save" type="button" disabled={disabled || saving || props.busy || !dirty} onClick={() => void save()}>
          {saving ? <RotateCcw className="spin" /> : <Save />}
          {saving ? "保存中" : dirty ? "保存" : "已保存"}
        </button>
      </div>
      {error ? <div className="office-error" role="alert">无法打开或保存 DOCX：{error}</div> : null}
      <div className="office-body">
        <div
          id={`office-scroll-${props.document.id.replace(/[^a-z0-9_-]/gi, "-")}`}
          ref={scrollRef}
          className="office-canvas-scroll"
          onPointerUp={(event) => {
            lastPointerRef.current = { x: event.clientX, y: event.clientY };
            window.setTimeout(emitSelection, 0);
          }}
          onKeyUp={() => window.setTimeout(emitSelection, 0)}
          onScroll={() => window.requestAnimationFrame(() => emitSelection())}
          onContextMenu={handleContextMenu}
        >
          {loading ? <div className="office-loading">正在解析 DOCX 与分页…</div> : null}
          <div ref={hostRef} className="office-editor" aria-label="DOCX 正文编辑器" />
        </div>
      </div>
    </div>
  );
}
