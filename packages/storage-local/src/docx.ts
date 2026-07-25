import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { BlockSnapshot } from "@margin/domain";

// mammoth ships convertToMarkdown but @types omit it
type MammothWithMd = typeof mammoth & {
  convertToMarkdown: (
    input: { path: string },
  ) => Promise<{ value: string; messages: unknown[] }>;
};

/** Best-effort DOCX → markdown. */
export async function docxFileToMarkdown(absPath: string): Promise<string> {
  const result = await (mammoth as MammothWithMd).convertToMarkdown({ path: absPath });
  return result.value.replace(/\r\n/g, "\n").trim() + "\n";
}

export async function writeMarkdownFromDocx(
  absDocx: string,
  absMd: string,
): Promise<void> {
  const md = await docxFileToMarkdown(absDocx);
  fs.mkdirSync(path.dirname(absMd), { recursive: true });
  fs.writeFileSync(absMd, md, "utf8");
}

function paragraphForBlock(b: BlockSnapshot): Paragraph[] {
  if (b.kind === "heading") {
    const levelMatch = /^(#{1,6})\s+(.*)$/s.exec(b.text);
    const level = Math.min(Math.max(levelMatch?.[1].length ?? 1, 1), 3);
    const text = (levelMatch?.[2] ?? b.text.replace(/^#+\s*/, "")).trim();
    const heading =
      level === 1
        ? HeadingLevel.HEADING_1
        : level === 2
          ? HeadingLevel.HEADING_2
          : HeadingLevel.HEADING_3;
    return [new Paragraph({ text, heading })];
  }

  if (b.kind === "blockquote") {
    const text = b.text
      .split("\n")
      .map((line) => line.replace(/^>\s?/, ""))
      .join("\n")
      .trim();
    return [
      new Paragraph({
        children: [new TextRun({ text, italics: true })],
        spacing: { after: 200 },
        indent: { left: 360 },
      }),
    ];
  }

  if (b.kind === "list_item") {
    const lines = b.text.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.map(
      (line) =>
        new Paragraph({
          text: line.replace(/^([-*+]|\d+\.)\s+/, ""),
          bullet: { level: 0 },
          spacing: { after: 80 },
        }),
    );
  }

  return b.text.split("\n").map(
    (line) =>
      new Paragraph({
        children: [new TextRun({ text: line })],
        spacing: { after: 200 },
      }),
  );
}

export async function blocksToDocxBuffer(blocks: BlockSnapshot[]): Promise<Buffer> {
  const children: Paragraph[] = [];
  for (const b of [...blocks].sort((a, c) => a.order - c.order)) {
    children.push(...paragraphForBlock(b));
  }
  if (!children.length) {
    children.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
  }
  const doc = new Document({
    sections: [{ children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export async function writeBlocksDocx(
  absOut: string,
  blocks: BlockSnapshot[],
): Promise<void> {
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  const buf = await blocksToDocxBuffer(blocks);
  fs.writeFileSync(absOut, buf);
}
