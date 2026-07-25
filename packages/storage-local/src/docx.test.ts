import { describe, expect, it } from "vitest";
import {
  compareContentStats,
  statsFromBlocks,
  statsFromMarkdown,
} from "./docx-loss.js";
import { blocksToDocxBuffer, docxFileToMarkdown, writeBlocksDocx } from "./docx.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("docx loss report", () => {
  it("flags empty and severe drops", () => {
    const source = statsFromMarkdown("# 标题\n\n正文一段。\n");
    const empty = compareContentStats(source, statsFromMarkdown(""));
    expect(empty.ok).toBe(false);
    expect(empty.flags).toContain("empty_output");

    const ok = compareContentStats(source, source);
    expect(ok.ok).toBe(true);
  });

  it("export→mammoth keeps core text above gate", async () => {
    const blocks = [
      {
        id: "h1",
        kind: "heading" as const,
        text: "# 县域教育政策",
        order: 0,
        contentHash: "a",
      },
      {
        id: "p1",
        kind: "paragraph" as const,
        text: "执行张力体现在科层考核与地方调适之间。",
        order: 1,
        contentHash: "b",
      },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "margin-loss-"));
    dirs.push(dir);
    const docxPath = path.join(dir, "t.docx");
    await writeBlocksDocx(docxPath, blocks);
    const md = await docxFileToMarkdown(docxPath);
    const report = compareContentStats(statsFromBlocks(blocks), statsFromMarkdown(md));
    expect(report.ok).toBe(true);
    expect(report.ratios.chars).toBeGreaterThan(0.5);
  });

  it("docx buffer is zip", async () => {
    const buf = await blocksToDocxBuffer([
      {
        id: "p1",
        kind: "paragraph",
        text: "hello",
        order: 0,
        contentHash: "x",
      },
    ]);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});
