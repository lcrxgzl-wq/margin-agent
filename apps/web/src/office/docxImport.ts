/*
 * DOCX is the canonical document source. Mammoth remains a guarded fallback
 * for malformed or unsupported packages; normal documents are read directly
 * from OOXML so layout-critical properties do not disappear through HTML.
 */
import {
  ElementType,
  RowFlex,
  TableBorder,
  TdBorder,
  VerticalAlign,
  type Command,
  type IElement,
} from "@hufe921/canvas-editor";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

type XmlNode = Record<string, unknown>;

type FontSet = {
  latin?: string;
  eastAsia?: string;
};

type RunFormat = FontSet & {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeout?: boolean;
  color?: string;
  highlight?: string;
  vertical?: "superscript" | "subscript";
  hidden?: boolean;
};

type ParagraphFormat = {
  rowFlex?: RowFlex;
  rowMargin?: number;
};

type StyleDefinition = {
  id: string;
  type: string;
  name?: string;
  basedOn?: string;
  isDefault: boolean;
  run: RunFormat;
  paragraph: ParagraphFormat;
  tableBorders?: BorderFormat;
};

type BorderFormat = {
  type: TableBorder;
  color?: string;
  width?: number;
  cellSides?: TdBorder[];
};

export type OoxmlPageSettings = {
  width: number;
  height: number;
  margins: [number, number, number, number];
};

export type OoxmlPresentation = {
  main: IElement[];
  page?: OoxmlPageSettings;
  defaultFont?: string;
  defaultSize?: number;
};

type ParseContext = {
  themes: Map<string, FontSet>;
  styles: Map<string, StyleDefinition>;
  defaultParagraphStyle?: string;
  defaultRun: RunFormat;
  defaultParagraph: ParagraphFormat;
  imageByRelationship: Map<string, { dataUrl: string; width?: number; height?: number }>;
  hyperlinkByRelationship: Map<string, string>;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

function asNodes(value: unknown): XmlNode[] {
  return Array.isArray(value) ? value as XmlNode[] : [];
}

function nodeName(node: XmlNode): string | undefined {
  return Object.keys(node).find((key) => key !== ":@");
}

function nodeChildren(node: XmlNode): XmlNode[] {
  const name = nodeName(node);
  return name ? asNodes(node[name]) : [];
}

function nodeAttributes(node?: XmlNode): Record<string, string> {
  if (!node || typeof node[":@"] !== "object" || node[":@"] === null) return {};
  return node[":@"] as Record<string, string>;
}

function directChildren(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return [];
  return nodeChildren(node).filter((child) => nodeName(child) === name);
}

function firstChild(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return directChildren(node, name)[0];
}

function descendants(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return [];
  const result: XmlNode[] = [];
  const visit = (current: XmlNode) => {
    if (nodeName(current) === name) result.push(current);
    nodeChildren(current).forEach(visit);
  };
  visit(node);
  return result;
}

function rootNode(document: XmlNode[], name: string): XmlNode | undefined {
  for (const node of document) {
    if (nodeName(node) === name) return node;
    const nested = descendants(node, name)[0];
    if (nested) return nested;
  }
  return undefined;
}

function nodeText(node: XmlNode | undefined): string {
  if (!node) return "";
  if (nodeName(node) === "#text") return String(node["#text"] ?? "");
  return nodeChildren(node).map(nodeText).join("");
}

function attribute(node: XmlNode | undefined, name: string): string | undefined {
  return nodeAttributes(node)[name];
}

function numberAttribute(node: XmlNode | undefined, name: string): number | undefined {
  const value = Number(attribute(node, name));
  return Number.isFinite(value) ? value : undefined;
}

function parseXml(xml?: string): XmlNode[] {
  if (!xml?.trim()) return [];
  return parser.parse(xml) as XmlNode[];
}

function mergeRun(...formats: Array<RunFormat | undefined>): RunFormat {
  const result: RunFormat = {};
  for (const format of formats) {
    if (!format) continue;
    for (const [key, value] of Object.entries(format)) {
      if (value !== undefined) Object.assign(result, { [key]: value });
    }
  }
  return result;
}

function mergeParagraph(...formats: Array<ParagraphFormat | undefined>): ParagraphFormat {
  const result: ParagraphFormat = {};
  for (const format of formats) {
    if (!format) continue;
    for (const [key, value] of Object.entries(format)) {
      if (value !== undefined) Object.assign(result, { [key]: value });
    }
  }
  return result;
}

function normalizedColor(value?: string): string | undefined {
  if (!value || value === "auto" || value === "none") return undefined;
  return /^#/.test(value) ? value : `#${value}`;
}

const HIGHLIGHT_COLORS: Record<string, string> = {
  black: "#000000",
  blue: "#0000ff",
  cyan: "#00ffff",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGray: "#808080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  green: "#00ff00",
  lightGray: "#c0c0c0",
  magenta: "#ff00ff",
  red: "#ff0000",
  white: "#ffffff",
  yellow: "#ffff00",
};

function onOffValue(node?: XmlNode): boolean | undefined {
  if (!node) return undefined;
  const value = attribute(node, "val");
  return value === "0" || value === "false" || value === "off" ? false : true;
}

function themeFonts(themeXml?: string): Map<string, FontSet> {
  const theme = parseXml(themeXml);
  const scheme = rootNode(theme, "fontScheme");
  const result = new Map<string, FontSet>();
  for (const family of ["majorFont", "minorFont"] as const) {
    const familyNode = firstChild(scheme, family);
    if (!familyNode) continue;
    const latin = attribute(firstChild(familyNode, "latin"), "typeface") || undefined;
    const eastAsiaNode = firstChild(familyNode, "ea");
    const scriptFont = directChildren(familyNode, "font")
      .find((node) => ["Hans", "Hant", "Jpan", "Hang"].includes(attribute(node, "script") ?? ""));
    const eastAsia = attribute(eastAsiaNode, "typeface")
      || attribute(scriptFont, "typeface")
      || undefined;
    const prefix = family === "majorFont" ? "major" : "minor";
    result.set(`${prefix}HAnsi`, { latin, eastAsia });
    result.set(`${prefix}EastAsia`, { latin, eastAsia });
    result.set(`${prefix}Bidi`, { latin, eastAsia });
  }
  return result;
}

function parseFonts(node: XmlNode | undefined, themes: Map<string, FontSet>): FontSet {
  if (!node) return {};
  const attrs = nodeAttributes(node);
  const latinTheme = themes.get(attrs.asciiTheme || attrs.hAnsiTheme || "");
  const eastTheme = themes.get(attrs.eastAsiaTheme || "");
  return {
    latin: attrs.ascii || attrs.hAnsi || latinTheme?.latin,
    eastAsia: attrs.eastAsia || eastTheme?.eastAsia || latinTheme?.eastAsia,
  };
}

function runProperties(node: XmlNode | undefined, themes: Map<string, FontSet>): RunFormat {
  if (!node) return {};
  const fonts = parseFonts(firstChild(node, "rFonts"), themes);
  const size = numberAttribute(firstChild(node, "sz"), "val");
  const color = normalizedColor(attribute(firstChild(node, "color"), "val"));
  const highlightName = attribute(firstChild(node, "highlight"), "val");
  const vertical = attribute(firstChild(node, "vertAlign"), "val");
  return {
    ...fonts,
    size: size === undefined ? undefined : size / 1.5,
    bold: onOffValue(firstChild(node, "b")),
    italic: onOffValue(firstChild(node, "i")),
    underline: firstChild(node, "u")
      ? attribute(firstChild(node, "u"), "val") !== "none"
      : undefined,
    strikeout: onOffValue(firstChild(node, "strike")),
    color,
    highlight: highlightName ? HIGHLIGHT_COLORS[highlightName] : undefined,
    vertical: vertical === "superscript" || vertical === "subscript" ? vertical : undefined,
    hidden: onOffValue(firstChild(node, "vanish")),
  };
}

function paragraphProperties(node: XmlNode | undefined): ParagraphFormat {
  if (!node) return {};
  const justification = attribute(firstChild(node, "jc"), "val");
  const rowFlex = justification === "center"
    ? RowFlex.CENTER
    : justification === "right" || justification === "end"
      ? RowFlex.RIGHT
      : justification === "both" || justification === "distribute"
        ? RowFlex.ALIGNMENT
        : justification === "left" || justification === "start"
          ? RowFlex.LEFT
          : undefined;
  const spacing = firstChild(node, "spacing");
  const line = numberAttribute(spacing, "line");
  const rowMargin = attribute(spacing, "lineRule") === "auto" && line
    ? Math.max(0.5, line / 240)
    : undefined;
  return { rowFlex, rowMargin };
}

function borderNodeFormat(node: XmlNode | undefined): { visible: boolean; color?: string; width?: number; dashed: boolean } {
  const value = attribute(node, "val");
  const visible = !!node && value !== "nil" && value !== "none";
  return {
    visible,
    color: normalizedColor(attribute(node, "color")),
    width: visible && numberAttribute(node, "sz") !== undefined
      ? (numberAttribute(node, "sz") ?? 0) / 6
      : undefined,
    dashed: value === "dashed" || value === "dashSmallGap" || value === "dotDash",
  };
}

function borderProperties(node: XmlNode | undefined): BorderFormat | undefined {
  if (!node) return undefined;
  const top = borderNodeFormat(firstChild(node, "top"));
  const right = borderNodeFormat(firstChild(node, "right"));
  const bottom = borderNodeFormat(firstChild(node, "bottom"));
  const left = borderNodeFormat(firstChild(node, "left"));
  const insideH = borderNodeFormat(firstChild(node, "insideH"));
  const insideV = borderNodeFormat(firstChild(node, "insideV"));
  const outer = [top, right, bottom, left];
  const inner = [insideH, insideV];
  const all = [...outer, ...inner];
  const visibleOuter = outer.every((border) => border.visible);
  const visibleInner = inner.every((border) => border.visible);
  const visible = all.filter((border) => border.visible);
  const type = visible.some((border) => border.dashed)
    ? TableBorder.DASH
    : visibleOuter && visibleInner
      ? TableBorder.ALL
      : visibleOuter
        ? TableBorder.EXTERNAL
        : visibleInner
          ? TableBorder.INTERNAL
          : TableBorder.EMPTY;
  const cellSides = [
    top.visible ? TdBorder.TOP : undefined,
    right.visible ? TdBorder.RIGHT : undefined,
    bottom.visible ? TdBorder.BOTTOM : undefined,
    left.visible ? TdBorder.LEFT : undefined,
  ].filter((side): side is TdBorder => side !== undefined);
  return {
    type,
    color: visible.find((border) => border.color)?.color,
    width: visible.find((border) => border.width !== undefined)?.width,
    cellSides,
  };
}

function parseStyles(stylesXml: string | undefined, themes: Map<string, FontSet>): {
  styles: Map<string, StyleDefinition>;
  defaultParagraphStyle?: string;
  defaultRun: RunFormat;
  defaultParagraph: ParagraphFormat;
} {
  const document = parseXml(stylesXml);
  const root = rootNode(document, "styles");
  const defaults = firstChild(root, "docDefaults");
  const defaultRunNode = firstChild(firstChild(defaults, "rPrDefault"), "rPr");
  const defaultParagraphNode = firstChild(firstChild(defaults, "pPrDefault"), "pPr");
  const definitions = new Map<string, StyleDefinition>();
  for (const styleNode of directChildren(root, "style")) {
    const attrs = nodeAttributes(styleNode);
    const id = attrs.styleId;
    if (!id) continue;
    const tableProperties = firstChild(styleNode, "tblPr");
    definitions.set(id, {
      id,
      type: attrs.type || "paragraph",
      name: attribute(firstChild(styleNode, "name"), "val"),
      basedOn: attribute(firstChild(styleNode, "basedOn"), "val"),
      isDefault: attrs.default === "1" || attrs.default === "true",
      run: runProperties(firstChild(styleNode, "rPr"), themes),
      paragraph: paragraphProperties(firstChild(styleNode, "pPr")),
      tableBorders: borderProperties(firstChild(tableProperties, "tblBorders")),
    });
  }

  const resolved = new Map<string, StyleDefinition>();
  const resolving = new Set<string>();
  const resolve = (id: string): StyleDefinition | undefined => {
    if (resolved.has(id)) return resolved.get(id);
    const own = definitions.get(id);
    if (!own || resolving.has(id)) return own;
    resolving.add(id);
    const base = own.basedOn ? resolve(own.basedOn) : undefined;
    const value: StyleDefinition = {
      ...own,
      run: mergeRun(base?.run, own.run),
      paragraph: mergeParagraph(base?.paragraph, own.paragraph),
      tableBorders: own.tableBorders ?? base?.tableBorders,
    };
    resolving.delete(id);
    resolved.set(id, value);
    return value;
  };
  definitions.forEach((_, id) => resolve(id));

  const defaultParagraphStyle = [...resolved.values()]
    .find((style) => style.type === "paragraph" && style.isDefault)?.id;
  return {
    styles: resolved,
    defaultParagraphStyle,
    defaultRun: runProperties(defaultRunNode, themes),
    defaultParagraph: paragraphProperties(defaultParagraphNode),
  };
}

function isEastAsianText(value: string): boolean {
  return /[\u2e80-\u9fff\uf900-\ufaff]/u.test(value);
}

function elementFromText(value: string, format: RunFormat, paragraph: ParagraphFormat): IElement {
  const font = isEastAsianText(value)
    ? format.eastAsia || format.latin
    : format.latin || format.eastAsia;
  return {
    value,
    font,
    size: format.size,
    bold: format.bold,
    italic: format.italic,
    underline: format.underline,
    strikeout: format.strikeout,
    color: format.color,
    highlight: format.highlight,
    rowFlex: paragraph.rowFlex,
    rowMargin: paragraph.rowMargin,
    type: format.vertical === "superscript"
      ? ElementType.SUPERSCRIPT
      : format.vertical === "subscript"
        ? ElementType.SUBSCRIPT
        : undefined,
  };
}

function paragraphStyle(node: XmlNode, context: ParseContext): {
  run: RunFormat;
  paragraph: ParagraphFormat;
} {
  const properties = firstChild(node, "pPr");
  const styleId = attribute(firstChild(properties, "pStyle"), "val")
    || context.defaultParagraphStyle;
  const style = styleId ? context.styles.get(styleId) : undefined;
  return {
    run: mergeRun(context.defaultRun, style?.run, runProperties(firstChild(properties, "rPr"), context.themes)),
    paragraph: mergeParagraph(context.defaultParagraph, style?.paragraph, paragraphProperties(properties)),
  };
}

function runElements(node: XmlNode, baseRun: RunFormat, paragraph: ParagraphFormat, context: ParseContext): IElement[] {
  const properties = firstChild(node, "rPr");
  const runStyleId = attribute(firstChild(properties, "rStyle"), "val");
  const format = mergeRun(baseRun, runStyleId ? context.styles.get(runStyleId)?.run : undefined, runProperties(properties, context.themes));
  if (format.hidden) return [];
  const output: IElement[] = [];
  for (const child of nodeChildren(node)) {
    const name = nodeName(child);
    if (name === "t" || name === "delText") {
      const value = nodeText(child);
      if (value) output.push(elementFromText(value, format, paragraph));
    } else if (name === "tab") {
      output.push({ ...elementFromText("\t", format, paragraph), type: ElementType.TAB });
    } else if (name === "br" || name === "cr") {
      output.push({
        ...elementFromText("\n", format, paragraph),
        type: attribute(child, "type") === "page" ? ElementType.PAGE_BREAK : undefined,
      });
    } else if (name === "noBreakHyphen") {
      output.push(elementFromText("\u2011", format, paragraph));
    } else if (name === "softHyphen") {
      output.push(elementFromText("\u00ad", format, paragraph));
    } else if (name === "drawing" || name === "pict") {
      const blip = descendants(child, "blip")[0];
      const relationshipId = attribute(blip, "embed") || attribute(descendants(child, "imagedata")[0], "id");
      const image = relationshipId ? context.imageByRelationship.get(relationshipId) : undefined;
      if (image) {
        const extent = descendants(child, "extent")[0];
        const width = numberAttribute(extent, "cx");
        const height = numberAttribute(extent, "cy");
        output.push({
          type: ElementType.IMAGE,
          value: image.dataUrl,
          width: width ? width / 9525 : image.width,
          height: height ? height / 9525 : image.height,
        });
      }
    }
  }
  return output;
}

function paragraphElements(node: XmlNode, context: ParseContext): IElement[] {
  const base = paragraphStyle(node, context);
  const output: IElement[] = [];
  const appendRuns = (container: XmlNode) => {
    for (const child of nodeChildren(container)) {
      const name = nodeName(child);
      if (name === "r") {
        output.push(...runElements(child, base.run, base.paragraph, context));
      } else if (name === "hyperlink") {
        const values: IElement[] = [];
        for (const run of directChildren(child, "r")) {
          values.push(...runElements(run, base.run, base.paragraph, context));
        }
        const url = context.hyperlinkByRelationship.get(attribute(child, "id") ?? "");
        if (values.length && url) {
          output.push({ type: ElementType.HYPERLINK, value: "", valueList: values, url });
        } else {
          output.push(...values);
        }
      } else if (["smartTag", "sdt", "sdtContent", "ins", "moveTo"].includes(name ?? "")) {
        appendRuns(child);
      }
    }
  };
  appendRuns(node);
  if (!output.length) output.push(elementFromText("", base.run, base.paragraph));
  return output;
}

type CanvasCell = NonNullable<NonNullable<IElement["trList"]>[number]["tdList"]>[number];

function cellProperties(node: XmlNode, colgroup: Array<{ width: number }>, colIndex: number, colspan: number): Partial<CanvasCell> {
  const properties = firstChild(node, "tcPr");
  const shading = attribute(firstChild(properties, "shd"), "fill");
  const vertical = attribute(firstChild(properties, "vAlign"), "val");
  const borders = borderProperties(firstChild(properties, "tcBorders"));
  const gridWidth = colgroup.slice(colIndex, colIndex + colspan)
    .reduce((sum, column) => sum + column.width, 0);
  const declaredWidth = firstChild(properties, "tcW");
  const widthType = attribute(declaredWidth, "type");
  const widthValue = numberAttribute(declaredWidth, "w");
  return {
    width: widthType === "dxa" && widthValue ? widthValue / 15 : gridWidth || undefined,
    verticalAlign: vertical === "center"
      ? VerticalAlign.MIDDLE
      : vertical === "bottom"
        ? VerticalAlign.BOTTOM
        : vertical === "top"
          ? VerticalAlign.TOP
          : undefined,
    backgroundColor: normalizedColor(shading),
    borderTypes: borders?.cellSides?.length ? borders.cellSides : undefined,
  };
}

function tableElement(node: XmlNode, context: ParseContext): IElement {
  const properties = firstChild(node, "tblPr");
  const styleId = attribute(firstChild(properties, "tblStyle"), "val");
  const styleBorders = styleId ? context.styles.get(styleId)?.tableBorders : undefined;
  const borders = borderProperties(firstChild(properties, "tblBorders")) ?? styleBorders;
  const colgroup = directChildren(firstChild(node, "tblGrid"), "gridCol")
    .map((column) => ({ width: (numberAttribute(column, "w") ?? 0) / 15 }))
    .filter((column) => column.width > 0);
  const rows = directChildren(node, "tr");
  const activeMerges = new Map<number, CanvasCell>();
  const trList = rows.map((row) => {
    let colIndex = 0;
    const continued = new Set<CanvasCell>();
    const tdList: CanvasCell[] = [];
    for (const cell of directChildren(row, "tc")) {
      const cellPr = firstChild(cell, "tcPr");
      const colspan = Math.max(1, numberAttribute(firstChild(cellPr, "gridSpan"), "val") ?? 1);
      const mergeNode = firstChild(cellPr, "vMerge");
      const mergeValue = attribute(mergeNode, "val");
      const isContinuation = !!mergeNode && mergeValue !== "restart";
      if (isContinuation) {
        const origin = activeMerges.get(colIndex);
        if (origin && !continued.has(origin)) {
          origin.rowspan += 1;
          continued.add(origin);
        }
      } else {
        const value = directChildren(cell, "p").flatMap((paragraph, index, paragraphs) => [
          ...paragraphElements(paragraph, context),
          ...(index < paragraphs.length - 1 ? [{ value: "\n" } satisfies IElement] : []),
        ]);
        const canvasCell: CanvasCell = {
          colspan,
          rowspan: 1,
          colIndex,
          value: value.length ? value : [{ value: "" }],
          ...cellProperties(cell, colgroup, colIndex, colspan),
        };
        tdList.push(canvasCell);
        for (let column = colIndex; column < colIndex + colspan; column += 1) {
          if (mergeValue === "restart") activeMerges.set(column, canvasCell);
          else activeMerges.delete(column);
        }
      }
      colIndex += colspan;
    }
    const rowHeightNode = firstChild(firstChild(row, "trPr"), "trHeight");
    const specifiedHeight = numberAttribute(rowHeightNode, "val");
    return {
      height: specifiedHeight ? Math.max(20, specifiedHeight / 15) : 28,
      minHeight: attribute(rowHeightNode, "hRule") === "exact" && specifiedHeight
        ? specifiedHeight / 15
        : undefined,
      pagingRepeat: !!firstChild(firstChild(row, "trPr"), "tblHeader"),
      tdList,
    };
  });
  const indent = firstChild(properties, "tblInd");
  const indentWidth = attribute(indent, "type") === "dxa" ? numberAttribute(indent, "w") : undefined;
  return {
    type: ElementType.TABLE,
    value: "",
    colgroup,
    trList,
    borderType: borders?.type ?? TableBorder.ALL,
    borderColor: borders?.color ?? "#000000",
    borderWidth: borders?.width,
    translateX: indentWidth ? indentWidth / 15 : undefined,
  };
}

function pageSettings(body: XmlNode): OoxmlPageSettings | undefined {
  const section = descendants(body, "sectPr").at(-1);
  const size = firstChild(section, "pgSz");
  const margins = firstChild(section, "pgMar");
  const width = numberAttribute(size, "w");
  const height = numberAttribute(size, "h");
  if (!width || !height) return undefined;
  return {
    width: width / 15,
    height: height / 15,
    margins: [
      (numberAttribute(margins, "top") ?? 1440) / 15,
      (numberAttribute(margins, "right") ?? 1440) / 15,
      (numberAttribute(margins, "bottom") ?? 1440) / 15,
      (numberAttribute(margins, "left") ?? 1440) / 15,
    ],
  };
}

export function parseOoxmlPresentation(
  documentXml: string,
  stylesXml?: string,
  themeXml?: string,
  imageByRelationship = new Map<string, { dataUrl: string; width?: number; height?: number }>(),
  hyperlinkByRelationship = new Map<string, string>(),
): OoxmlPresentation {
  const themes = themeFonts(themeXml);
  const styleContext = parseStyles(stylesXml, themes);
  const context: ParseContext = {
    themes,
    ...styleContext,
    imageByRelationship,
    hyperlinkByRelationship,
  };
  const document = parseXml(documentXml);
  const body = firstChild(rootNode(document, "document"), "body");
  if (!body) throw new Error("DOCX document.xml does not contain a body");
  const main: IElement[] = [];
  for (const child of nodeChildren(body)) {
    const name = nodeName(child);
    if (name === "p") {
      main.push(...paragraphElements(child, context), { value: "\n" });
    } else if (name === "tbl") {
      main.push(tableElement(child, context), { value: "\n" });
    } else if (name === "sdt") {
      const content = firstChild(child, "sdtContent");
      for (const nested of nodeChildren(content ?? child)) {
        if (nodeName(nested) === "p") main.push(...paragraphElements(nested, context), { value: "\n" });
        if (nodeName(nested) === "tbl") main.push(tableElement(nested, context), { value: "\n" });
      }
    }
  }
  if (main.at(-1)?.value === "\n") main.pop();
  const defaultStyle = styleContext.defaultParagraphStyle
    ? styleContext.styles.get(styleContext.defaultParagraphStyle)
    : undefined;
  return {
    main: main.length ? main : [{ value: "" }],
    page: pageSettings(body),
    defaultFont: defaultStyle?.run.latin
      || defaultStyle?.run.eastAsia
      || styleContext.defaultRun.latin
      || styleContext.defaultRun.eastAsia
      || "Times New Roman",
    defaultSize: defaultStyle?.run.size || styleContext.defaultRun.size || 16,
  };
}

function normalizeZipTarget(target: string): string {
  const segments = `word/${target.replace(/^\//, "")}`.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") normalized.pop();
    else normalized.push(segment);
  }
  return normalized.join("/");
}

function mimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "bmp") return "image/bmp";
  if (extension === "svg") return "image/svg+xml";
  return "image/png";
}

async function relationships(
  zip: JSZip,
  relationshipsXml?: string,
): Promise<{
  images: Map<string, { dataUrl: string }>;
  hyperlinks: Map<string, string>;
}> {
  const images = new Map<string, { dataUrl: string }>();
  const hyperlinks = new Map<string, string>();
  const root = rootNode(parseXml(relationshipsXml), "Relationships");
  for (const relationship of directChildren(root, "Relationship")) {
    const attrs = nodeAttributes(relationship);
    if (!attrs.Id || !attrs.Target) continue;
    if (attrs.Type?.endsWith("/hyperlink")) {
      hyperlinks.set(attrs.Id, attrs.Target);
      continue;
    }
    if (!attrs.Type?.endsWith("/image")) continue;
    const path = normalizeZipTarget(attrs.Target);
    const file = zip.file(path);
    if (!file) continue;
    images.set(attrs.Id, {
      dataUrl: `data:${mimeType(path)};base64,${await file.async("base64")}`,
    });
  }
  return { images, hyperlinks };
}

const MAX_DOCX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_DOCX_EXPANDED_BYTES = 96 * 1024 * 1024;

function declaredUncompressedSize(file: JSZip.JSZipObject): number {
  const data = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  return Number.isFinite(data?.uncompressedSize) ? Number(data?.uncompressedSize) : 0;
}

function assertDocxExpansionBudget(zip: JSZip): void {
  let total = 0;
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    const size = declaredUncompressedSize(file);
    if (size > MAX_DOCX_ENTRY_BYTES) throw new Error("DOCX contains an oversized expanded entry");
    total += size;
    if (total > MAX_DOCX_EXPANDED_BYTES) throw new Error("DOCX expanded content exceeds 96 MiB");
  }
}

async function zipText(zip: JSZip, path: string): Promise<string | undefined> {
  return zip.file(path)?.async("string");
}

export async function importDocxIntoCanvas(
  command: Command,
  arrayBuffer: ArrayBuffer,
  shouldApply: () => boolean = () => true,
): Promise<void> {
  try {
    const zip = await JSZip.loadAsync(arrayBuffer);
    assertDocxExpansionBudget(zip);
    const [documentXml, stylesXml, themeXml, relationshipXml] = await Promise.all([
      zipText(zip, "word/document.xml"),
      zipText(zip, "word/styles.xml"),
      zipText(zip, "word/theme/theme1.xml"),
      zipText(zip, "word/_rels/document.xml.rels"),
    ]);
    if (!documentXml) throw new Error("DOCX is missing word/document.xml");
    const related = await relationships(zip, relationshipXml);
    const presentation = parseOoxmlPresentation(
      documentXml,
      stylesXml,
      themeXml,
      related.images,
      related.hyperlinks,
    );
    if (!shouldApply()) return;
    command.executeUpdateOptions({
      defaultFont: presentation.defaultFont,
      defaultSize: presentation.defaultSize,
    });
    if (presentation.page) {
      command.executePaperSize(presentation.page.width, presentation.page.height);
      command.executeSetPaperMargin(presentation.page.margins);
    }
    command.executeSetValue({ main: presentation.main }, { isSetCursor: false });
    return;
  } catch (ooxmlError) {
    const { default: mammoth } = await import("mammoth");
    const result = await mammoth.convertToHtml(
      { arrayBuffer },
      {
        includeDefaultStyleMap: true,
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
        ],
      },
    );
    if (!result.value.trim()) throw ooxmlError;
    if (!shouldApply()) return;
    command.executeSetHTML({ main: result.value });
  }
}
