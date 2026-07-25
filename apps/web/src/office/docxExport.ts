/*
 * Derived from Hufe921/canvas-editor-plugin-docx (MIT).
 * Margin changes export into a host-controlled function that returns data
 * instead of downloading directly. See THIRD_PARTY_NOTICES.md.
 */
import Color from "color";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LineRuleType,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign as DocxVerticalAlign,
  WidthType,
  type ParagraphChild,
} from "docx";
import {
  ElementType,
  ListStyle,
  RowFlex,
  TableBorder,
  TitleLevel,
  VerticalAlign,
  type IEditorData,
  type IElement,
} from "@hufe921/canvas-editor";

const headingMap = {
  [TitleLevel.FIRST]: HeadingLevel.HEADING_1,
  [TitleLevel.SECOND]: HeadingLevel.HEADING_2,
  [TitleLevel.THIRD]: HeadingLevel.HEADING_3,
  [TitleLevel.FOURTH]: HeadingLevel.HEADING_4,
  [TitleLevel.FIFTH]: HeadingLevel.HEADING_5,
  [TitleLevel.SIXTH]: HeadingLevel.HEADING_6,
};

function safeColor(value?: string, fallback = "000000"): string {
  if (!value || value === "transparent") return fallback;
  try {
    return Color(value).hex().replace(/^#/, "");
  } catch {
    return fallback;
  }
}

function alignment(rowFlex?: RowFlex) {
  if (rowFlex === RowFlex.CENTER) return AlignmentType.CENTER;
  if (rowFlex === RowFlex.RIGHT) return AlignmentType.RIGHT;
  if (rowFlex === RowFlex.ALIGNMENT) return AlignmentType.JUSTIFIED;
  if (rowFlex === RowFlex.LEFT) return AlignmentType.LEFT;
  return undefined;
}

function verticalAlignment(value?: VerticalAlign) {
  if (value === VerticalAlign.MIDDLE) return DocxVerticalAlign.CENTER;
  if (value === VerticalAlign.BOTTOM) return DocxVerticalAlign.BOTTOM;
  if (value === VerticalAlign.TOP) return DocxVerticalAlign.TOP;
  return undefined;
}

function borders(border?: TableBorder) {
  const line = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
  const none = { style: BorderStyle.NIL, size: 0, color: "000000" };
  if (border === TableBorder.EMPTY) {
    return { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
  }
  if (border === TableBorder.EXTERNAL) {
    return { top: line, bottom: line, left: line, right: line, insideHorizontal: none, insideVertical: none };
  }
  return { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line };
}

function imageBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function inline(element: IElement): ParagraphChild {
  if (element.type === ElementType.IMAGE && /^data:image\//.test(element.value)) {
    const subtype = /^data:image\/(png|jpe?g|gif|bmp)/i.exec(element.value)?.[1]?.toLowerCase();
    const type = subtype === "jpeg" ? "jpg" : subtype ?? "png";
    return new ImageRun({
      data: imageBytes(element.value),
      type: type as "png",
      transformation: { width: element.width ?? 240, height: element.height ?? 160 },
    });
  }
  if (element.type === ElementType.HYPERLINK) {
    return new ExternalHyperlink({
      link: element.url ?? "",
      children: [new TextRun({ text: element.valueList?.map((item) => item.value).join("") ?? element.value })],
    });
  }
  if (element.type === ElementType.PAGE_BREAK) return new PageBreak();
  return new TextRun({
    text: element.value,
    font: element.font,
    size: element.size ? Math.round(element.size * 1.5) : undefined,
    bold: element.bold,
    italics: element.italic,
    underline: element.underline ? {} : undefined,
    strike: element.strikeout,
    color: safeColor(element.color),
    shading: element.highlight ? { fill: safeColor(element.highlight, "FFFF00") } : undefined,
    superScript: element.type === ElementType.SUPERSCRIPT,
    subScript: element.type === ElementType.SUBSCRIPT,
  });
}

type DocxChild = Paragraph | Table;

function childrenFromElements(elements: IElement[]): DocxChild[] {
  const output: DocxChild[] = [];
  let runs: ParagraphChild[] = [];
  let rowFlex: RowFlex | undefined;
  let rowMargin: number | undefined;

  const flush = () => {
    if (!runs.length) return;
    output.push(new Paragraph({
      children: runs,
      alignment: alignment(rowFlex),
      spacing: rowMargin ? { line: Math.round(rowMargin * 15), lineRule: LineRuleType.AUTO } : undefined,
    }));
    runs = [];
    rowFlex = undefined;
    rowMargin = undefined;
  };

  for (const element of elements) {
    if (element.type === ElementType.TABLE) {
      flush();
      const rows = (element.trList ?? []).map((row) => new TableRow({
        children: row.tdList.map((cell) => {
          const cellChildren = childrenFromElements(cell.value);
          return new TableCell({
            columnSpan: cell.colspan,
            rowSpan: cell.rowspan,
            verticalAlign: verticalAlignment(cell.verticalAlign),
            shading: cell.backgroundColor ? { fill: safeColor(cell.backgroundColor, "FFFFFF") } : undefined,
            width: cell.width ? { size: Math.round(cell.width * 15), type: WidthType.DXA } : undefined,
            children: cellChildren.length ? cellChildren : [new Paragraph("")],
          });
        }),
      }));
      output.push(new Table({
        rows,
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: element.colgroup?.map((column) => Math.round(column.width * 15)),
        borders: borders(element.borderType),
      }));
      continue;
    }
    if (element.type === ElementType.TITLE) {
      flush();
      output.push(new Paragraph({
        heading: headingMap[element.level ?? TitleLevel.FIRST],
        alignment: alignment(element.rowFlex),
        children: (element.valueList ?? []).map(inline),
      }));
      continue;
    }
    if (element.type === ElementType.LIST) {
      flush();
      const values = (element.valueList ?? []).map((item) => item.value).join("").split("\n").filter(Boolean);
      values.forEach((value, index) => output.push(new Paragraph({
        children: [new TextRun(`${element.listStyle === ListStyle.DECIMAL ? `${index + 1}.` : "•"} ${value}`)],
      })));
      continue;
    }
    const pieces = element.value.split("\n");
    for (let index = 0; index < pieces.length; index += 1) {
      if (index > 0) flush();
      if (!runs.length) {
        rowFlex = element.rowFlex;
        rowMargin = element.rowMargin;
      }
      if (pieces[index] || element.type === ElementType.PAGE_BREAK) {
        runs.push(inline({ ...element, value: pieces[index] }));
      }
    }
  }
  flush();
  return output;
}

export async function exportCanvasToDocx(data: IEditorData): Promise<Blob> {
  const document = new Document({
    sections: [
      {
        headers: { default: new Header({ children: childrenFromElements(data.header ?? []) }) },
        footers: { default: new Footer({ children: childrenFromElements(data.footer ?? []) }) },
        children: childrenFromElements(data.main),
      },
    ],
  });
  return Packer.toBlob(document);
}
