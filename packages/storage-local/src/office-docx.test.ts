import { describe, expect, it } from "vitest";
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalMergeType,
} from "docx";
import {
  applyDocxPreservingEdits,
  applyDocxParagraphEdits,
  applyDocxTableCellEdit,
  extractDocxBlocks,
  extractDocxBlocksFromXml,
  readDocxXml,
  readDocxTableCell,
} from "./office-docx.js";
import JSZip from "jszip";

async function xmlFixture(xml: string, extraParts: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", xml);
  for (const [name, content] of Object.entries(extraParts)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function fixture(): Promise<Buffer> {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun({ text: "Before", bold: true })] }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("A1")] }),
                  new TableCell({ children: [new Paragraph("B1")] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("A2")] }),
                  new TableCell({ children: [new Paragraph("B2")] }),
                ],
              }),
            ],
          }),
          new Paragraph("After table"),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

describe("OOXML document blocks", () => {
  it("indexes paragraphs and a table without Markdown flattening", async () => {
    const blocks = await extractDocxBlocks(await fixture());

    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table", "paragraph"]);
    expect(blocks[1]?.text).toBe("A1\tB1\nA2\tB2");
  });

  it("changes one paragraph while preserving the table OOXML", async () => {
    const source = await fixture();
    const blocks = await extractDocxBlocks(source);
    const paragraph = blocks[0]!;
    const beforeXml = await readDocxXml(source);
    const result = await applyDocxParagraphEdits(
      source,
      new Map([[paragraph.id, "Edited paragraph"]]),
    );
    const afterXml = await readDocxXml(result.buffer);

    expect(result.blocks[0]?.text).toBe("Edited paragraph");
    expect(result.blocks[1]?.text).toBe("A1\tB1\nA2\tB2");
    expect((beforeXml.match(/<w:tbl[ >]/g) ?? []).length).toBe(1);
    expect((afterXml.match(/<w:tbl[ >]/g) ?? []).length).toBe(1);
    expect(afterXml).toContain("w:tbl");
    expect(afterXml).toContain("<w:b");
  });

  it("patches a selected span without shifting later run formatting", async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Plain selected </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Bold suffix</w:t></w:r></w:p></w:body></w:document>`;
    const source = await xmlFixture(xml);
    const block = (await extractDocxBlocks(source))[0]!;
    const replacement = "a much longer translated selection";
    const operation = {
      kind: "translate" as const,
      scope: "selection" as const,
      targetLanguage: "en" as const,
      selection: { start: 6, end: 14, before: "selected", after: replacement },
    };
    const edited = await applyDocxParagraphEdits(
      source,
      new Map([[block.id, `Plain ${replacement} Bold suffix`]]),
      new Map([[block.id, operation]]),
    );
    const afterXml = await readDocxXml(edited.buffer);

    expect(edited.blocks[0]?.text).toBe(`Plain ${replacement} Bold suffix`);
    expect(afterXml).toMatch(new RegExp(`<w:t>Plain ${replacement} </w:t></w:r><w:r><w:rPr><w:b`));
    expect(afterXml).toContain("<w:t>Bold suffix</w:t>");
  });

  it("patches a selection spanning runs while preserving the suffix run", async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alpha sel</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>ected</w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:rPr><w:u/></w:rPr><w:t> linked suffix</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`;
    const source = await xmlFixture(xml);
    const block = (await extractDocxBlocks(source))[0]!;
    const replacement = "translated";
    const edited = await applyDocxParagraphEdits(
      source,
      new Map([[block.id, `Alpha ${replacement} linked suffix`]]),
      new Map([[block.id, {
        kind: "translate",
        scope: "selection",
        targetLanguage: "en",
        selection: { start: 6, end: 14, before: "selected", after: replacement },
      }]]),
    );
    const afterXml = await readDocxXml(edited.buffer);

    expect(edited.blocks[0]?.text).toBe(`Alpha ${replacement} linked suffix`);
    expect(afterXml).toContain(`<w:t>Alpha ${replacement}</w:t>`);
    expect(afterXml).toContain("<w:i");
    expect(afterXml).toContain("<w:t/>");
    expect(afterXml).toContain('<w:hyperlink r:id="rId1">');
    expect(afterXml).toContain("<w:t> linked suffix</w:t>");
  });

  it("uses an E decision replacement while keeping text outside the selection immutable", async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Before selected </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>suffix</w:t></w:r></w:p></w:body></w:document>`;
    const source = await xmlFixture(xml);
    const block = (await extractDocxBlocks(source))[0]!;
    const operation = {
      kind: "polish" as const,
      scope: "selection" as const,
      selection: { start: 7, end: 15, before: "selected", after: "proposal" },
    };
    const edited = await applyDocxParagraphEdits(
      source,
      new Map([[block.id, "Before human edit suffix"]]),
      new Map([[block.id, operation]]),
    );
    const afterXml = await readDocxXml(edited.buffer);

    expect(edited.blocks[0]?.text).toBe("Before human edit suffix");
    expect(afterXml).toContain("<w:t>Before human edit </w:t>");
    expect(afterXml).toMatch(/<w:rPr><w:b\s*\/><\/w:rPr><w:t>suffix<\/w:t>/);
    await expect(applyDocxParagraphEdits(
      source,
      new Map([[block.id, "Changed prefix proposal suffix"]]),
      new Map([[block.id, operation]]),
    )).rejects.toThrow(/outside the selected range/);
  });

  it("reads and patches one table cell without changing table structure", async () => {
    const source = await fixture();
    const table = (await extractDocxBlocks(source)).find((block) => block.kind === "table")!;
    await expect(readDocxTableCell(source, table.id, 2, 2)).resolves.toEqual({
      address: "B2",
      text: "B2",
    });
    const edited = await applyDocxTableCellEdit(source, table.id, 2, 2, "B2", "Changed");
    expect(edited.blocks.find((block) => block.kind === "table")?.text).toBe(
      "A1\tB1\nA2\tChanged",
    );
    const xml = await readDocxXml(edited.buffer);
    expect((xml.match(/<w:tr[ >]/g) ?? []).length).toBe(2);
    expect((xml.match(/<w:tc[ >]/g) ?? []).length).toBe(4);
  });

  it("addresses gridSpan cells by logical column and rejects merged continuations", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:tbl>
          <w:tr>
            <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Wide</w:t></w:r></w:p></w:tc>
            <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>C1</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc>
            <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
          </w:tr>
        </w:tbl></w:body>
      </w:document>`;
    const source = await xmlFixture(xml);
    const table = (await extractDocxBlocks(source)).find((block) => block.kind === "table")!;

    await expect(readDocxTableCell(source, table.id, 1, 1)).resolves.toEqual({
      address: "A1",
      text: "Wide",
    });
    await expect(readDocxTableCell(source, table.id, 1, 2))
      .rejects.toThrow(/top-left/);
    await expect(readDocxTableCell(source, table.id, 1, 3)).resolves.toEqual({
      address: "C1",
      text: "C1",
    });
    await expect(readDocxTableCell(source, table.id, 2, 3))
      .rejects.toThrow(/continuation/);
    await expect(applyDocxTableCellEdit(source, table.id, 1, 3, "stale", "Changed"))
      .rejects.toThrow(/stale/);
  });

  it("rejects multi-paragraph table cells before a proposal can be generated", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>first</w:t></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>
      </w:document>`;
    const source = await xmlFixture(xml);
    const table = (await extractDocxBlocks(source)).find((block) => block.kind === "table")!;

    await expect(readDocxTableCell(source, table.id, 1, 1))
      .rejects.toThrow(/multi-paragraph table cell edit is unsupported/);
  });

  it("indexes visible field results and preserves hidden field instructions on edit", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText> ADDIN CNKISM.Hidden </w:instrText><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Visible title</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body>
      </w:document>`;
    const blocks = extractDocxBlocksFromXml(xml);
    expect(blocks[0]?.text).toBe("Visible title");

    const zip = new JSZip();
    zip.file("word/document.xml", xml);
    const source = await zip.generateAsync({ type: "nodebuffer" });
    const edited = await applyDocxParagraphEdits(
      source,
      new Map([[blocks[0]!.id, "Edited title"]]),
    );
    const afterXml = await readDocxXml(edited.buffer);

    expect(afterXml).toContain("ADDIN CNKISM.Hidden");
    expect(afterXml).toContain("fldChar");
    expect(edited.blocks[0]?.text).toBe("Edited title");
  });

  it("transplants canvas text and formatting while preserving protected OOXML", async () => {
    const originalXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <w:body>
          <w:p>
            <w:pPr><w:pStyle w:val="Heading1"/><w:keepNext/><w:jc w:val="left"/></w:pPr>
            <w:commentRangeStart w:id="0"/>
            <w:r><w:rPr><w:rStyle w:val="Emphasis"/><w:lang w:val="en-US"/></w:rPr><w:t>Before</w:t></w:r>
            <w:r><w:fldChar w:fldCharType="begin"/><w:instrText> DATE </w:instrText><w:fldChar w:fldCharType="separate"/></w:r>
            <w:r><w:rPr><w:i/></w:rPr><w:t>2024</w:t></w:r>
            <w:r><w:fldChar w:fldCharType="end"/></w:r>
            <w:hyperlink r:id="rId5"><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>Link</w:t></w:r></w:hyperlink>
            <w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>
          </w:p>
          <w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid>
            <w:tr>
              <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
            </w:tr>
            <w:tr>
              <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
              <w:tc><w:p><w:r><w:t>Old</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
          <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
        </w:body>
      </w:document>`;
    const exportedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:pPr><w:jc w:val="center"/><w:spacing w:line="360"/></w:pPr>
            <w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>After</w:t></w:r>
            <w:r><w:rPr><w:i/></w:rPr><w:t>2025</w:t></w:r>
            <w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>Link</w:t></w:r>
          </w:p>
          <w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid>
            <w:tr>
              <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
            </w:tr>
            <w:tr>
              <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
              <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>New</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
          <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
        </w:body>
      </w:document>`;
    const parts = {
      "word/header1.xml": "<w:hdr>ORIGINAL_HEADER</w:hdr>",
      "word/comments.xml": "<w:comments>ORIGINAL_COMMENT</w:comments>",
      "word/_rels/document.xml.rels": "<Relationships>ORIGINAL_RELATIONSHIPS</Relationships>",
    };
    const original = await xmlFixture(originalXml, parts);
    const exported = await xmlFixture(exportedXml, {
      "word/header1.xml": "<w:hdr>REBUILT_HEADER</w:hdr>",
      "word/comments.xml": "<w:comments>REBUILT_COMMENT</w:comments>",
    });

    const result = await applyDocxPreservingEdits(original, exported);

    expect(result).not.toBeNull();
    if (!result) throw new Error("expected compatible OOXML patch");
    const xml = await readDocxXml(result.buffer);
    expect(xml).toContain("<w:jc w:val=\"center\"");
    expect(xml).toContain("<w:pStyle w:val=\"Heading1\"");
    expect(xml).toContain("<w:keepNext");
    expect(xml).toContain("<w:rStyle w:val=\"Emphasis\"");
    expect(xml).toContain("<w:lang w:val=\"en-US\"");
    expect(xml).toContain("<w:b");
    expect(xml).toContain("<w:sz w:val=\"28\"");
    expect(xml).toContain("<w:instrText> DATE </w:instrText>");
    expect(xml).toContain("<w:hyperlink r:id=\"rId5\"");
    expect(xml).toContain("commentRangeStart");
    expect(xml).toContain("commentReference");
    expect(xml).toContain("<w:vMerge w:val=\"restart\"");
    expect(xml).toContain("<w:vMerge");
    expect(xml).toContain("<w:sectPr>");
    expect(result.blocks.map((block) => block.text)).toEqual([
      "After2025Link",
      "A\tB\n\tNew",
    ]);

    const patchedZip = await JSZip.loadAsync(result.buffer);
    for (const [name, content] of Object.entries(parts)) {
      expect(await patchedZip.file(name)?.async("string")).toBe(content);
    }
  });

  it("leaves untouched protected paragraphs byte-structurally owned by the original", async () => {
    const originalXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:bookmarkStart w:id="1" w:name="mark"/><w:r><w:t>Protected</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>
          <w:p><w:r><w:t>Editable</w:t></w:r></w:p>
        </w:body>
      </w:document>`;
    const exportedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Protected</w:t></w:r></w:p>
          <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Edited</w:t></w:r></w:p>
        </w:body>
      </w:document>`;
    const original = await xmlFixture(originalXml);
    const exported = await xmlFixture(exportedXml);
    const editable = (await extractDocxBlocks(original))[1]!;

    const result = await applyDocxPreservingEdits(original, exported, new Set([editable.id]));

    expect(result).not.toBeNull();
    const xml = await readDocxXml(result!.buffer);
    expect(xml).toContain("bookmarkStart");
    expect(xml).toContain("bookmarkEnd");
    expect(xml).toContain("Protected");
    expect(result!.blocks[1]?.text).toBe("Edited");
    expect(xml).toContain("<w:b");
  });

  it("rejects table structure changes from the preserving patch", async () => {
    const original = await xmlFixture(`
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>`);
    const changed = await xmlFixture(`
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>`);

    await expect(applyDocxPreservingEdits(original, changed)).resolves.toBeNull();
  });

  it("accepts equivalent vertical merge topology emitted by the DOCX exporter", async () => {
    const original = await xmlFixture(`
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
          <w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
          <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
      </w:body></w:document>`);
    const exported = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [new Table({ rows: [
        new TableRow({ children: [
          new TableCell({ verticalMerge: VerticalMergeType.RESTART, children: [new Paragraph("A")] }),
          new TableCell({ children: [new Paragraph("B")] }),
        ] }),
        new TableRow({ children: [
          new TableCell({ verticalMerge: VerticalMergeType.CONTINUE, children: [new Paragraph("")] }),
          new TableCell({ children: [new Paragraph("Changed")] }),
        ] }),
      ] })] }],
    })));

    const result = await applyDocxPreservingEdits(original, exported);
    expect(result?.blocks[0]?.text).toBe("A\tB\n\tChanged");
  });

  it("rejects a newly introduced relationship-bearing paragraph structure", async () => {
    const original = await xmlFixture(`
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t>Plain</w:t></w:r></w:p>
      </w:body></w:document>`);
    const changed = await xmlFixture(`
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
        <w:p><w:hyperlink r:id="rId99"><w:r><w:t>Plain</w:t></w:r></w:hyperlink></w:p>
      </w:body></w:document>`, {
      "word/_rels/document.xml.rels": "<Relationships><Relationship Id=\"rId99\"/></Relationships>",
    });

    await expect(applyDocxPreservingEdits(original, changed)).resolves.toBeNull();
  });

  it("rejects a protected paragraph when the exported visible run topology differs", async () => {
    const original = await xmlFixture(`
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
        <w:p><w:r><w:t>Before</w:t></w:r><w:hyperlink r:id="rId5"><w:r><w:t>Link</w:t></w:r></w:hyperlink></w:p>
      </w:body></w:document>`, {
      "word/_rels/document.xml.rels": "<Relationships><Relationship Id=\"rId5\"/></Relationships>",
    });
    const changed = await xmlFixture(`
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t>Collapsed replacement</w:t></w:r></w:p>
      </w:body></w:document>`);

    await expect(applyDocxPreservingEdits(original, changed)).resolves.toBeNull();
  });

  it("decodes XML entities once so repeated saves do not stack escape layers", async () => {
    const originalXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t xml:space="preserve">Foucault&apos;s &amp; &lt;tag&gt; &quot;q&quot;</w:t></w:r></w:p>
      </w:body></w:document>`;
    const exportedXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t xml:space="preserve">Foucault&apos;s &amp; &lt;tag&gt; &quot;q&quot;</w:t></w:r></w:p>
      </w:body></w:document>`;
    const original = await xmlFixture(originalXml);
    const exported = await xmlFixture(exportedXml);

    const blocks = await extractDocxBlocks(original);
    expect(blocks[0]?.text).toBe(`Foucault's & <tag> "q"`);

    const result = await applyDocxPreservingEdits(original, exported);
    expect(result).not.toBeNull();
    const xml = await readDocxXml(result!.buffer);
    expect(xml).not.toContain("&amp;apos;");
    expect(xml).not.toContain("&amp;amp;");
    expect(result!.blocks[0]?.text).toBe(`Foucault's & <tag> "q"`);

    const edited = await applyDocxParagraphEdits(
      result!.buffer,
      new Map([[result!.blocks[0]!.id, `Edited 'quote' & <tag>`]]),
    );
    const editedXml = await readDocxXml(edited.buffer);
    expect(editedXml).not.toContain("&amp;apos;");
    expect(editedXml).not.toContain("&amp;amp;");
    expect(edited.blocks[0]?.text).toBe(`Edited 'quote' & <tag>`);
  });
});
