import { ElementType, RowFlex, TableBorder, VerticalAlign, type Command } from "@hufe921/canvas-editor";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { importDocxIntoCanvas, parseOoxmlPresentation } from "./docxImport";

const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr>
      <w:r><w:rPr><w:b/><w:i/><w:u w:val="single"/></w:rPr><w:t>Formatted</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="Grid"/></w:tblPr>
      <w:tblGrid>
        <w:gridCol w:w="1500"/><w:gridCol w:w="3000"/><w:gridCol w:w="750"/>
      </w:tblGrid>
      <w:tr>
        <w:trPr><w:trHeight w:val="450" w:hRule="exact"/></w:trPr>
        <w:tc>
          <w:tcPr>
            <w:gridSpan w:val="2"/><w:vMerge w:val="restart"/><w:shd w:fill="D9EAF7"/><w:vAlign w:val="center"/>
          </w:tcPr>
          <w:p><w:r><w:t>Merged</w:t></w:r></w:p>
        </w:tc>
        <w:tc><w:p><w:r><w:t>Right 1</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p/></w:tc>
        <w:tc><w:p><w:r><w:t>Right 2</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/>
    </w:sectPr>
  </w:body>
</w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="table" w:styleId="Grid">
    <w:name w:val="Table Grid"/>
    <w:tblPr><w:tblBorders>
      <w:top w:val="single" w:sz="6" w:color="4472C4"/><w:left w:val="single" w:sz="6" w:color="4472C4"/>
      <w:bottom w:val="single" w:sz="6" w:color="4472C4"/><w:right w:val="single" w:sz="6" w:color="4472C4"/>
      <w:insideH w:val="single" w:sz="6" w:color="4472C4"/><w:insideV w:val="single" w:sz="6" w:color="4472C4"/>
    </w:tblBorders></w:tblPr>
  </w:style>
</w:styles>`;

describe("parseOoxmlPresentation", () => {
  it("keeps page, run, paragraph, and table geometry from OOXML", () => {
    const result = parseOoxmlPresentation(documentXml, stylesXml);
    expect(result.defaultFont).toBe("Times New Roman");
    expect(result.defaultSize).toBe(16);
    expect(result.page).toEqual({
      width: 11906 / 15,
      height: 16838 / 15,
      margins: [96, 120, 96, 120],
    });

    const text = result.main[0];
    expect(text).toMatchObject({
      value: "Formatted",
      font: "Times New Roman",
      size: 16,
      bold: true,
      italic: true,
      underline: true,
      rowFlex: RowFlex.CENTER,
      rowMargin: 1.5,
    });

    const table = result.main.find((element) => element.type === ElementType.TABLE);
    expect(table).toMatchObject({
      borderType: TableBorder.ALL,
      borderColor: "#4472C4",
      borderWidth: 1,
      colgroup: [{ width: 100 }, { width: 200 }, { width: 50 }],
    });
    expect(table?.trList).toHaveLength(2);
    expect(table?.trList?.[0]).toMatchObject({ height: 30, minHeight: 30 });
    expect(table?.trList?.[0].tdList[0]).toMatchObject({
      colspan: 2,
      rowspan: 2,
      width: 300,
      backgroundColor: "#D9EAF7",
      verticalAlign: VerticalAlign.MIDDLE,
    });
    expect(table?.trList?.[1].tdList).toHaveLength(1);
    expect(table?.trList?.[1].tdList[0].value[0].value).toBe("Right 2");
  });

  it("decodes XML entities exactly once into element values", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t xml:space="preserve">Foucault&apos;s &amp; &lt;tag&gt; &quot;q&quot;</w:t></w:r></w:p>
  </w:body>
</w:document>`;
    const result = parseOoxmlPresentation(xml);
    expect(result.main[0]?.value).toBe(`Foucault's & <tag> "q"`);
  });

  it("does not let an obsolete async revision write into the canvas", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", documentXml);
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const command = {
      executeUpdateOptions: vi.fn(),
      executePaperSize: vi.fn(),
      executeSetPaperMargin: vi.fn(),
      executeSetValue: vi.fn(),
      executeSetHTML: vi.fn(),
    } as unknown as Command;

    await importDocxIntoCanvas(command, bytes, () => false);

    expect(command.executeSetValue).not.toHaveBeenCalled();
    expect(command.executeSetHTML).not.toHaveBeenCalled();
    expect(command.executePaperSize).not.toHaveBeenCalled();
  });
});
