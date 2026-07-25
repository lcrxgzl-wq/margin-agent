import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chunkMarkdown } from "./index.js";
import {
  compareContentStats,
  statsFromBlocks,
  statsFromMarkdown,
} from "./docx-loss.js";
import { docxFileToMarkdown, writeBlocksDocx } from "./docx.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const corpusRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/corpus",
);

describe("docx corpus gate", () => {
  it("roundtrips every corpus markdown above loss thresholds", async () => {
    const files = fs
      .readdirSync(corpusRoot)
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(2);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "margin-corpus-"));
    dirs.push(dir);

    for (const file of files) {
      const md = fs.readFileSync(path.join(corpusRoot, file), "utf8");
      const blocks = chunkMarkdown(md);
      expect(blocks.length, file).toBeGreaterThan(0);

      const docxPath = path.join(dir, `${file}.docx`);
      await writeBlocksDocx(docxPath, blocks);
      const roundtrip = await docxFileToMarkdown(docxPath);
      const report = compareContentStats(
        statsFromBlocks(blocks),
        statsFromMarkdown(roundtrip),
      );

      expect(report.ok, `${file} flags=${report.flags.join(",")}`).toBe(true);
      // Corpus bar: keep most non-whitespace text and headings.
      expect(report.ratios.chars, file).toBeGreaterThanOrEqual(0.65);
      if (blocks.some((b) => b.kind === "heading")) {
        expect(report.ratios.headings, file).toBeGreaterThanOrEqual(0.8);
      }
    }
  });

  it("preserves list and quote signal after export", async () => {
    const md = fs.readFileSync(path.join(corpusRoot, "02-quotes-lists.md"), "utf8");
    const blocks = chunkMarkdown(md);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "margin-corpus-ql-"));
    dirs.push(dir);
    const docxPath = path.join(dir, "ql.docx");
    await writeBlocksDocx(docxPath, blocks);
    const roundtrip = await docxFileToMarkdown(docxPath);
    expect(roundtrip.includes("科层考核") || roundtrip.includes("地方调适")).toBe(true);
    expect(roundtrip.includes("引用块") || roundtrip.includes("往返")).toBe(true);
  });
});
