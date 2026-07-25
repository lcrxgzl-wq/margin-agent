import { createHash } from "node:crypto";
import JSZip from "jszip";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { type BlockSnapshot, type ProposalOperation, contentHash } from "@margin/domain";

type XmlNode = Record<string, unknown>;

const MAX_DOCUMENT_XML_BYTES = 32 * 1024 * 1024;

// Entities must decode on parse: XMLBuilder escapes text on build, so keeping
// raw entity strings here would add one escape layer on every parse→build pass.
const parser = new XMLParser({
  ignoreAttributes: false,
  preserveOrder: true,
  trimValues: false,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  preserveOrder: true,
  suppressEmptyNode: true,
});

function localName(name: string): string {
  const index = name.indexOf(":");
  return index === -1 ? name : name.slice(index + 1);
}

function childEntries(nodes: unknown): Array<{ name: string; node: XmlNode; children: XmlNode[] }> {
  if (!Array.isArray(nodes)) return [];
  const entries: Array<{ name: string; node: XmlNode; children: XmlNode[] }> = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as XmlNode;
    for (const [name, value] of Object.entries(node)) {
      if (name === ":@" || name === "#text") continue;
      entries.push({ name, node, children: Array.isArray(value) ? value as XmlNode[] : [] });
    }
  }
  return entries;
}

function findChild(
  nodes: unknown,
  wanted: string,
): { name: string; node: XmlNode; children: XmlNode[] } | undefined {
  return childEntries(nodes).find(({ name }) => localName(name) === wanted);
}

function attribute(node: XmlNode, wanted: string): string | undefined {
  const attrs = node[":@"];
  if (!attrs || typeof attrs !== "object") return undefined;
  for (const [name, value] of Object.entries(attrs as Record<string, unknown>)) {
    if (localName(name.replace(/^@_/, "")) === wanted && value != null) return String(value);
  }
  return undefined;
}

function textFromNodes(nodes: unknown): string {
  let text = "";
  for (const { name, children } of childEntries(nodes)) {
    const local = localName(name);
    if (local === "t") {
      for (const child of children) {
        if (typeof child["#text"] === "string" || typeof child["#text"] === "number") {
          text += String(child["#text"]);
        }
      }
      continue;
    }
    if (local === "tab") {
      text += "\t";
      continue;
    }
    if (local === "br" || local === "cr") {
      text += "\n";
      continue;
    }
    if (local === "instrText" || local === "del" || local === "delText") continue;
    text += textFromNodes(children);
  }
  return text;
}

function paragraphKind(children: XmlNode[]): BlockSnapshot["kind"] {
  const pPr = findChild(children, "pPr")?.children;
  const style = findChild(pPr, "pStyle");
  const styleName = style ? attribute(style.node, "val") ?? "" : "";
  const outline = findChild(pPr, "outlineLvl");
  if (/^(heading|title|subtitle|标题|题名)/i.test(styleName) || outline) return "heading";
  if (findChild(pPr, "numPr")) return "list_item";
  return "paragraph";
}

function tableText(children: XmlNode[]): string {
  const rows: string[] = [];
  for (const row of childEntries(children).filter(({ name }) => localName(name) === "tr")) {
    const cells: string[] = [];
    for (const cell of childEntries(row.children).filter(({ name }) => localName(name) === "tc")) {
      const paragraphs = childEntries(cell.children)
        .filter(({ name }) => localName(name) === "p")
        .map(({ children: paragraphChildren }) => textFromNodes(paragraphChildren).trim());
      cells.push(paragraphs.join("\n"));
    }
    rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

function bodyChildren(tree: XmlNode[]): Array<{ name: string; node: XmlNode; children: XmlNode[] }> {
  const document = findChild(tree, "document");
  const body = findChild(document?.children, "body");
  if (!body) throw new Error("invalid DOCX: word/document.xml has no body");
  return childEntries(body.children);
}

function uniqueBlockId(
  prefix: "p" | "t",
  bodyIndex: number,
  node: XmlNode,
  text: string,
  used: Set<string>,
): string {
  const paraId = prefix === "p" ? attribute(node, "paraId") : undefined;
  const seed = paraId?.toLowerCase() ?? contentHash(text || `${prefix}-${bodyIndex}`).slice(0, 12);
  const base = `ooxml-${prefix}-${bodyIndex}-${seed}`;
  let id = base;
  let occurrence = 2;
  while (used.has(id)) {
    id = `${base}-${occurrence}`;
    occurrence += 1;
  }
  used.add(id);
  return id;
}

export function extractDocxBlocksFromXml(xml: string): BlockSnapshot[] {
  const tree = parser.parse(xml) as XmlNode[];
  const blocks: BlockSnapshot[] = [];
  const used = new Set<string>();
  for (const [bodyIndex, entry] of bodyChildren(tree).entries()) {
    const local = localName(entry.name);
    if (local === "p") {
      const text = textFromNodes(entry.children).trim();
      if (!text) continue;
      blocks.push({
        id: uniqueBlockId("p", bodyIndex, entry.node, text, used),
        kind: paragraphKind(entry.children),
        text,
        order: blocks.length,
        contentHash: contentHash(text),
      });
    } else if (local === "tbl") {
      const text = tableText(entry.children);
      blocks.push({
        id: uniqueBlockId("t", bodyIndex, entry.node, text, used),
        kind: "table",
        text,
        order: blocks.length,
        contentHash: contentHash(text),
      });
    }
  }
  return blocks;
}

export async function readDocxXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("invalid DOCX: word/document.xml missing");
  const size = Number(
    (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
  );
  if (Number.isFinite(size) && size > MAX_DOCUMENT_XML_BYTES) {
    throw new Error("invalid DOCX: document.xml exceeds 32 MiB expanded");
  }
  return entry.async("string");
}

async function readDocumentXmlEntry(entry: JSZip.JSZipObject | null): Promise<string> {
  if (!entry) throw new Error("invalid DOCX: word/document.xml missing");
  const size = Number(
    (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
  );
  if (Number.isFinite(size) && size > MAX_DOCUMENT_XML_BYTES) {
    throw new Error("invalid DOCX: document.xml exceeds 32 MiB expanded");
  }
  const xml = await entry.async("string");
  if (Buffer.byteLength(xml, "utf8") > MAX_DOCUMENT_XML_BYTES) {
    throw new Error("invalid DOCX: document.xml exceeds 32 MiB expanded");
  }
  return xml;
}

export async function extractDocxBlocks(buffer: Buffer): Promise<BlockSnapshot[]> {
  return extractDocxBlocksFromXml(await readDocxXml(buffer));
}

export function docxContentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

function firstRunProperties(children: XmlNode[]): XmlNode | undefined {
  for (const entry of childEntries(children)) {
    if (localName(entry.name) === "r") {
      const properties = findChild(entry.children, "rPr");
      if (properties) return properties.node;
    }
    const nested = firstRunProperties(entry.children);
    if (nested) return nested;
  }
  return undefined;
}

function replacementRun(text: string, runProperties?: XmlNode): XmlNode {
  const runChildren: XmlNode[] = runProperties ? [runProperties] : [];
  const parts = text.split("\n");
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) runChildren.push({ "w:br": [] });
    runChildren.push({
      "w:t": [{ "#text": parts[index] }],
      ":@": { "@_xml:space": "preserve" },
    });
  }
  return { "w:r": runChildren };
}

function rebuildParagraphChildren(children: XmlNode[], text: string): XmlNode[] {
  const runProperties = firstRunProperties(children);
  const preserved = children.filter((node) => {
    const names = Object.keys(node).filter((name) => name !== ":@" && name !== "#text");
    if (!names.length) return true;
    const local = localName(names[0]);
    return !["r", "hyperlink", "fldSimple", "smartTag", "ins", "del", "sdt"].includes(local);
  });
  const pPrIndex = preserved.findIndex((node) =>
    Object.keys(node).some((name) => localName(name) === "pPr"),
  );
  preserved.splice(pPrIndex >= 0 ? pPrIndex + 1 : 0, 0, replacementRun(text, runProperties));
  return preserved;
}

function visibleTextLeaves(nodes: unknown, leaves: XmlNode[] = []): XmlNode[] {
  for (const { name, children } of childEntries(nodes)) {
    const local = localName(name);
    if (local === "t") {
      const leaf = children.find((child) => "#text" in child);
      if (leaf) leaves.push(leaf);
      continue;
    }
    if (local === "instrText" || local === "del" || local === "delText") continue;
    visibleTextLeaves(children, leaves);
  }
  return leaves;
}

function replaceParagraphChildren(children: XmlNode[], text: string): XmlNode[] {
  const before = textFromNodes(children);
  const leaves = visibleTextLeaves(children);
  if (!leaves.length || /[\n\t]/.test(before) || /[\n\t]/.test(text)) {
    return rebuildParagraphChildren(children, text);
  }

  let offset = 0;
  for (const [index, leaf] of leaves.entries()) {
    const oldLength = String(leaf["#text"] ?? "").length;
    const next = index === leaves.length - 1
      ? text.slice(offset)
      : text.slice(offset, offset + oldLength);
    leaf["#text"] = next;
    offset += next.length;
  }
  return children;
}

/** Patch only the selected visible span so run/hyperlink/field boundaries outside it stay intact. */
function replaceParagraphSelection(
  children: XmlNode[],
  selection: NonNullable<ProposalOperation["selection"]>,
  text: string,
): XmlNode[] {
  const before = textFromNodes(children);
  if (
    selection.end !== selection.start + selection.before.length ||
    before.slice(selection.start, selection.end) !== selection.before ||
    /[\n\t]/.test(selection.before) ||
    /[\n\t]/.test(selection.after)
  ) {
    throw new Error("DOCX selection range is stale or crosses a structural text boundary");
  }
  const prefix = before.slice(0, selection.start);
  const suffix = before.slice(selection.end);
  if (
    !text.startsWith(prefix) ||
    !text.endsWith(suffix) ||
    text.length < prefix.length + suffix.length
  ) {
    throw new Error("DOCX edited selection changed text outside the selected range");
  }
  const replacement = text.slice(prefix.length, text.length - suffix.length);
  const leaves = visibleTextLeaves(children);
  if (!leaves.length) throw new Error("DOCX selection has no editable text leaf");

  let cursor = 0;
  let inserted = false;
  for (const leaf of leaves) {
    const value = String(leaf["#text"] ?? "");
    const leafStart = cursor;
    const leafEnd = leafStart + value.length;
    cursor = leafEnd;
    if (leafEnd <= selection.start || leafStart >= selection.end) continue;
    const localStart = Math.max(0, selection.start - leafStart);
    const localEnd = Math.min(value.length, selection.end - leafStart);
    const prefix = value.slice(0, localStart);
    const suffix = value.slice(localEnd);
    leaf["#text"] = inserted ? `${prefix}${suffix}` : `${prefix}${replacement}${suffix}`;
    inserted = true;
  }
  if (!inserted || textFromNodes(children) !== text) {
    throw new Error("DOCX selection could not be mapped to visible text leaves");
  }
  return children;
}

function blockBodyIndex(blockId: string): number | null {
  const match = /^ooxml-p-(\d+)-/.exec(blockId);
  return match ? Number(match[1]) : null;
}

function tableBlockBodyIndex(blockId: string): number | null {
  const match = /^ooxml-t-(\d+)-/.exec(blockId);
  return match ? Number(match[1]) : null;
}

function tableCellEntry(
  table: { children: XmlNode[] },
  row: number,
  column: number,
): { name: string; node: XmlNode; children: XmlNode[] } | undefined {
  const tableRows = childEntries(table.children).filter(({ name }) => localName(name) === "tr");
  const targetRow = tableRows[row - 1];
  if (!targetRow) return undefined;
  const rowProperties = findChild(targetRow.children, "trPr")?.children;
  const gridBefore = Number(attribute(findChild(rowProperties, "gridBefore")?.node ?? {}, "val") ?? 0);
  let logicalColumn = Number.isFinite(gridBefore) && gridBefore > 0 ? gridBefore + 1 : 1;
  for (const cell of childEntries(targetRow.children).filter(({ name }) => localName(name) === "tc")) {
    const properties = findChild(cell.children, "tcPr")?.children;
    const rawSpan = Number(attribute(findChild(properties, "gridSpan")?.node ?? {}, "val") ?? 1);
    const span = Number.isFinite(rawSpan) && rawSpan > 0 ? Math.floor(rawSpan) : 1;
    if (column >= logicalColumn && column < logicalColumn + span) {
      if (column !== logicalColumn) {
        throw new Error("DOCX merged table cell must use its top-left address");
      }
      const verticalMerge = findChild(properties, "vMerge");
      if (verticalMerge && attribute(verticalMerge.node, "val") !== "restart") {
        throw new Error("DOCX vertically merged continuation cell is unsupported");
      }
      return cell;
    }
    logicalColumn += span;
  }
  return undefined;
}

function tableCellAddress(row: number, column: number): string {
  let value = column;
  let columnAddress = "";
  while (value > 0) {
    value -= 1;
    columnAddress = String.fromCharCode(65 + (value % 26)) + columnAddress;
    value = Math.floor(value / 26);
  }
  return `${columnAddress}${row}`;
}

export async function readDocxTableCell(
  buffer: Buffer,
  blockId: string,
  row: number,
  column: number,
): Promise<{ address: string; text: string } | undefined> {
  const tree = parser.parse(await readDocxXml(buffer)) as XmlNode[];
  const index = tableBlockBodyIndex(blockId);
  const table = index == null ? undefined : bodyChildren(tree)[index];
  if (!table || localName(table.name) !== "tbl") return undefined;
  const cell = tableCellEntry(table, row, column);
  if (!cell) return undefined;
  const paragraphs = childEntries(cell.children).filter(({ name }) => localName(name) === "p");
  const text = paragraphs
    .map(({ children }) => textFromNodes(children).trim())
    .join("\n");
  if (paragraphs.length !== 1) {
    throw new Error("DOCX multi-paragraph table cell edit is unsupported");
  }
  return { address: tableCellAddress(row, column), text };
}

export async function applyDocxTableCellEdit(
  buffer: Buffer,
  blockId: string,
  row: number,
  column: number,
  expectedText: string,
  nextText: string,
): Promise<{ buffer: Buffer; blocks: BlockSnapshot[] }> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("invalid DOCX: word/document.xml missing");
  const tree = parser.parse(await readDocumentXmlEntry(entry)) as XmlNode[];
  const index = tableBlockBodyIndex(blockId);
  const table = index == null ? undefined : bodyChildren(tree)[index];
  if (!table || localName(table.name) !== "tbl") throw new Error("DOCX table locator not found");
  const cell = tableCellEntry(table, row, column);
  if (!cell) throw new Error("DOCX table cell locator not found");
  const paragraphs = childEntries(cell.children).filter(({ name }) => localName(name) === "p");
  const currentText = paragraphs.map(({ children }) => textFromNodes(children).trim()).join("\n");
  if (currentText !== expectedText) throw new Error("DOCX table cell text is stale");
  if (paragraphs.length !== 1) throw new Error("DOCX multi-paragraph table cell edit is unsupported");
  const target = paragraphs[0]!;
  target.node[target.name] = replaceParagraphChildren(target.children, nextText);
  const nextXml = builder.build(tree);
  zip.file("word/document.xml", nextXml);
  const nextBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer: nextBuffer, blocks: extractDocxBlocksFromXml(nextXml) };
}

function cloneNode<T>(value: T): T {
  return structuredClone(value);
}

function nodeLocalName(node: XmlNode): string | undefined {
  const name = Object.keys(node).find((key) => key !== ":@" && key !== "#text");
  return name ? localName(name) : undefined;
}

function mergePropertyChildren(
  originalChildren: XmlNode[],
  exportedChildren: XmlNode[],
  editable: ReadonlySet<string>,
): XmlNode[] {
  const replacements = new Map<string, XmlNode>();
  for (const node of exportedChildren) {
    const name = nodeLocalName(node);
    if (name && editable.has(name)) replacements.set(name, cloneNode(node));
  }
  const next: XmlNode[] = [];
  const emitted = new Set<string>();
  for (const node of originalChildren) {
    const name = nodeLocalName(node);
    if (name && editable.has(name)) {
      const replacement = replacements.get(name);
      if (replacement && !emitted.has(name)) next.push(replacement);
      emitted.add(name);
    } else {
      next.push(node);
    }
  }
  for (const node of exportedChildren) {
    const name = nodeLocalName(node);
    if (name && editable.has(name) && !emitted.has(name)) {
      next.push(cloneNode(node));
      emitted.add(name);
    }
  }
  return next;
}

const EDITABLE_PARAGRAPH_PROPERTIES = new Set(["jc", "spacing", "ind"]);
const EDITABLE_RUN_PROPERTIES = new Set([
  "rFonts", "sz", "szCs", "b", "bCs", "i", "iCs", "u", "strike",
  "color", "highlight", "shd", "vertAlign",
]);

function paragraphPropertiesWithOriginalSection(
  originalChildren: XmlNode[],
  exportedChildren: XmlNode[],
): XmlNode | undefined {
  const original = findChild(originalChildren, "pPr");
  const exported = findChild(exportedChildren, "pPr");
  if (!original && !exported) return undefined;
  if (!original) return cloneNode(exported!.node);
  if (!exported) return cloneNode(original.node);
  const next = cloneNode(original.node);
  const nextEntry = findChild([next], "pPr")!;
  nextEntry.node[nextEntry.name] = mergePropertyChildren(
    nextEntry.children,
    exported.children,
    EDITABLE_PARAGRAPH_PROPERTIES,
  );
  return next;
}

function withParagraphProperties(
  children: XmlNode[],
  properties: XmlNode | undefined,
): XmlNode[] {
  const next = children.filter((node) => nodeLocalName(node) !== "pPr");
  if (properties) next.unshift(properties);
  return next;
}

const PROTECTED_PARAGRAPH_NODES = new Set([
  "fldChar",
  "instrText",
  "hyperlink",
  "commentRangeStart",
  "commentRangeEnd",
  "commentReference",
  "bookmarkStart",
  "bookmarkEnd",
  "drawing",
  "pict",
  "object",
  "footnoteReference",
  "endnoteReference",
  "sdt",
  "smartTag",
  "ins",
  "del",
  "moveFrom",
  "moveTo",
]);

function containsProtectedParagraphStructure(nodes: unknown): boolean {
  for (const { name, children } of childEntries(nodes)) {
    if (PROTECTED_PARAGRAPH_NODES.has(localName(name))) return true;
    if (containsProtectedParagraphStructure(children)) return true;
  }
  return false;
}

type XmlEntry = ReturnType<typeof childEntries>[number];

function visibleRuns(nodes: unknown, output: XmlEntry[] = []): XmlEntry[] {
  for (const entry of childEntries(nodes)) {
    if (localName(entry.name) === "r") {
      if (visibleTextLeaves(entry.children).length) output.push(entry);
      continue;
    }
    if (localName(entry.name) === "instrText" || localName(entry.name) === "del") continue;
    visibleRuns(entry.children, output);
  }
  return output;
}

function mergedRunProperties(original: XmlEntry, exported: XmlEntry): XmlNode | undefined {
  const originalProperties = findChild(original.children, "rPr");
  const exportedProperties = findChild(exported.children, "rPr");
  if (!originalProperties && !exportedProperties) return undefined;
  const propertyNode = originalProperties
    ? cloneNode(originalProperties.node)
    : { "w:rPr": [] } as XmlNode;
  const propertyEntry = findChild([propertyNode], "rPr")!;
  propertyEntry.node[propertyEntry.name] = mergePropertyChildren(
    propertyEntry.children,
    exportedProperties?.children ?? [],
    EDITABLE_RUN_PROPERTIES,
  );
  return (propertyEntry.node[propertyEntry.name] as XmlNode[]).length
    ? propertyNode
    : undefined;
}

function replaceRunProperties(original: XmlEntry, exported: XmlEntry): void {
  const next = original.children.filter((node) => nodeLocalName(node) !== "rPr");
  const properties = mergedRunProperties(original, exported);
  if (properties) next.unshift(properties);
  original.node[original.name] = next;
  original.children = next;
}

function transplantProtectedParagraph(
  originalChildren: XmlNode[],
  exportedChildren: XmlNode[],
): XmlNode[] | null {
  const originalRuns = visibleRuns(originalChildren);
  const exportedRuns = visibleRuns(exportedChildren);
  if (originalRuns.length !== exportedRuns.length) return null;

  for (let index = 0; index < originalRuns.length; index += 1) {
    const originalRun = originalRuns[index]!;
    const exportedRun = exportedRuns[index]!;
    const originalLeaves = visibleTextLeaves(originalRun.children);
    const exportedLeaves = visibleTextLeaves(exportedRun.children);
    if (originalLeaves.length !== exportedLeaves.length) return null;
    replaceRunProperties(originalRun, exportedRun);
    for (let leafIndex = 0; leafIndex < originalLeaves.length; leafIndex += 1) {
      originalLeaves[leafIndex]!["#text"] = String(exportedLeaves[leafIndex]!["#text"] ?? "");
    }
  }

  const properties = paragraphPropertiesWithOriginalSection(originalChildren, exportedChildren);
  return withParagraphProperties(originalChildren, properties);
}

function transplantParagraph(
  originalChildren: XmlNode[],
  exportedChildren: XmlNode[],
): XmlNode[] | null {
  if (containsProtectedParagraphStructure(originalChildren)) {
    return transplantProtectedParagraph(originalChildren, exportedChildren);
  }
  if (containsProtectedParagraphStructure(exportedChildren)) return null;
  const properties = paragraphPropertiesWithOriginalSection(originalChildren, exportedChildren);
  const next = withParagraphProperties(cloneNode(exportedChildren), properties);
  const originalRuns = visibleRuns(originalChildren);
  const nextRuns = visibleRuns(next);
  if (originalRuns.length === nextRuns.length) {
    for (let index = 0; index < originalRuns.length; index += 1) {
      const nextRun = nextRuns[index]!;
      const children = nextRun.children.filter((node) => nodeLocalName(node) !== "rPr");
      const runProperties = mergedRunProperties(originalRuns[index]!, nextRun);
      if (runProperties) children.unshift(runProperties);
      nextRun.node[nextRun.name] = children;
      nextRun.children = children;
    }
  }
  return next;
}

function editableBodyEntries(tree: XmlNode[]): XmlEntry[] {
  return bodyChildren(tree).filter((entry) => {
    const name = localName(entry.name);
    return name === "tbl" || (name === "p" && textFromNodes(entry.children).trim().length > 0);
  });
}

function cellStructure(cell: XmlEntry): string {
  const properties = findChild(cell.children, "tcPr");
  const span = findChild(properties?.children, "gridSpan");
  const merge = findChild(properties?.children, "vMerge");
  return JSON.stringify({
    colspan: Number(span ? attribute(span.node, "val") : 1),
    verticalMerge: merge ? attribute(merge.node, "val") || "continue" : null,
  });
}

function transplantTable(original: XmlEntry, exported: XmlEntry): boolean {
  const originalGrid = childEntries(findChild(original.children, "tblGrid")?.children)
    .filter(({ name }) => localName(name) === "gridCol");
  const exportedGrid = childEntries(findChild(exported.children, "tblGrid")?.children)
    .filter(({ name }) => localName(name) === "gridCol");
  if (originalGrid.length !== exportedGrid.length) return false;

  const originalRows = childEntries(original.children).filter(({ name }) => localName(name) === "tr");
  const exportedRows = childEntries(exported.children).filter(({ name }) => localName(name) === "tr");
  if (originalRows.length !== exportedRows.length) return false;

  for (let rowIndex = 0; rowIndex < originalRows.length; rowIndex += 1) {
    const originalCells = childEntries(originalRows[rowIndex]!.children)
      .filter(({ name }) => localName(name) === "tc");
    const exportedCells = childEntries(exportedRows[rowIndex]!.children)
      .filter(({ name }) => localName(name) === "tc");
    if (originalCells.length !== exportedCells.length) return false;

    for (let cellIndex = 0; cellIndex < originalCells.length; cellIndex += 1) {
      const originalCell = originalCells[cellIndex]!;
      const exportedCell = exportedCells[cellIndex]!;
      if (cellStructure(originalCell) !== cellStructure(exportedCell)) return false;
      const originalParagraphs = childEntries(originalCell.children)
        .filter(({ name }) => localName(name) === "p");
      const exportedParagraphs = childEntries(exportedCell.children)
        .filter(({ name }) => localName(name) === "p");
      if (originalParagraphs.length !== exportedParagraphs.length) return false;
      for (let paragraphIndex = 0; paragraphIndex < originalParagraphs.length; paragraphIndex += 1) {
        const target = originalParagraphs[paragraphIndex]!;
        const next = transplantParagraph(target.children, exportedParagraphs[paragraphIndex]!.children);
        if (!next) return false;
        target.node[target.name] = next;
        target.children = next;
      }
    }
  }
  return true;
}

/**
 * Move compatible human text/format edits into the original OOXML package.
 * Package parts and protected paragraph structures remain owned by the original.
 */
export async function applyDocxPreservingEdits(
  originalBuffer: Buffer,
  exportedBuffer: Buffer,
  changedBlockIds?: ReadonlySet<string>,
  onReject?: (reason: string) => void,
): Promise<{ buffer: Buffer; blocks: BlockSnapshot[] } | null> {
  const reject = (reason: string): null => {
    onReject?.(reason);
    return null;
  };
  const [originalZip, exportedZip] = await Promise.all([
    JSZip.loadAsync(originalBuffer),
    JSZip.loadAsync(exportedBuffer),
  ]);
  const originalEntry = originalZip.file("word/document.xml");
  const exportedEntry = exportedZip.file("word/document.xml");
  if (!originalEntry || !exportedEntry) throw new Error("invalid DOCX: word/document.xml missing");
  const [originalXml, exportedXml] = await Promise.all([
    readDocumentXmlEntry(originalEntry),
    readDocumentXmlEntry(exportedEntry),
  ]);
  const originalTree = parser.parse(originalXml) as XmlNode[];
  const exportedTree = parser.parse(exportedXml) as XmlNode[];
  const originalBlocks = editableBodyEntries(originalTree);
  const exportedBlocks = editableBodyEntries(exportedTree);
  if (originalBlocks.length !== exportedBlocks.length) {
    return reject(`body block count changed (${originalBlocks.length} -> ${exportedBlocks.length})`);
  }
  const originalSnapshots = extractDocxBlocksFromXml(originalXml);
  const changedBodyIndexes = changedBlockIds?.size
    ? new Set([...changedBlockIds].map((blockId) => {
        const paragraph = blockBodyIndex(blockId);
        if (paragraph != null) return paragraph;
        return tableBlockBodyIndex(blockId);
      }).filter((index): index is number => index != null))
    : undefined;
  if (changedBlockIds?.size && changedBodyIndexes?.size !== changedBlockIds.size) {
    return reject("one or more changed block locators are invalid");
  }

  for (let index = 0; index < originalBlocks.length; index += 1) {
    const original = originalBlocks[index]!;
    const exported = exportedBlocks[index]!;
    const originalName = localName(original.name);
    if (originalName !== localName(exported.name)) {
      return reject(`body block ${index} changed kind (${originalName} -> ${localName(exported.name)})`);
    }
    const snapshot = originalSnapshots[index];
    const bodyIndex = snapshot?.kind === "table"
      ? tableBlockBodyIndex(snapshot.id)
      : snapshot
        ? blockBodyIndex(snapshot.id)
        : null;
    if (changedBodyIndexes && (bodyIndex == null || !changedBodyIndexes.has(bodyIndex))) continue;
    if (originalName === "p") {
      const next = transplantParagraph(original.children, exported.children);
      if (!next) return reject(`paragraph body index ${bodyIndex ?? "unknown"} has incompatible protected structure`);
      original.node[original.name] = next;
      original.children = next;
    } else if (originalName === "tbl" && !transplantTable(original, exported)) {
      return reject(`table body index ${bodyIndex ?? "unknown"} changed structure`);
    }
  }

  const nextXml = builder.build(originalTree);
  originalZip.file("word/document.xml", nextXml);
  const buffer = await originalZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, blocks: extractDocxBlocksFromXml(nextXml) };
}

export async function applyDocxParagraphEdits(
  buffer: Buffer,
  edits: ReadonlyMap<string, string>,
  operations?: ReadonlyMap<string, ProposalOperation | undefined>,
): Promise<{ buffer: Buffer; blocks: BlockSnapshot[] }> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("invalid DOCX: word/document.xml missing");
  const xml = await entry.async("string");
  const tree = parser.parse(xml) as XmlNode[];
  const entries = bodyChildren(tree);

  for (const [blockId, text] of edits) {
    const index = blockBodyIndex(blockId);
    const target = index == null ? undefined : entries[index];
    if (!target || localName(target.name) !== "p") {
      throw new Error(`DOCX paragraph locator not found: ${blockId}`);
    }
    const operation = operations?.get(blockId);
    target.node[target.name] = operation?.scope === "selection" && operation.selection
      ? replaceParagraphSelection(target.children, operation.selection, text)
      : replaceParagraphChildren(target.children, text);
  }

  const nextXml = builder.build(tree);
  zip.file("word/document.xml", nextXml);
  const nextBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer: nextBuffer, blocks: extractDocxBlocksFromXml(nextXml) };
}
