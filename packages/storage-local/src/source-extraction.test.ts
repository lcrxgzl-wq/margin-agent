import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { afterEach, describe, expect, it } from "vitest";
import {
  listWorkspaceSourceFiles,
  openWorkspace,
  readWorkspaceSource,
  type Workspace,
} from "./index.js";

const roots: string[] = [];
const workspaces: Workspace[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    try { workspace.db.close(); } catch { /* ignore */ }
    try { await workspace.releaseLock(); } catch { /* ignore */ }
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function simplePdf(text: string): Buffer {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

describe("workspace rich source extraction", () => {
  it("lists and extracts DOCX and text-layer PDF materials", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-sources-"));
    roots.push(root);
    const docx = await Packer.toBuffer(new Document({
      sections: [{ children: [new Paragraph("Interview evidence from DOCX")] }],
    }));
    fs.writeFileSync(path.join(root, "interview.docx"), docx);
    fs.writeFileSync(path.join(root, "article.pdf"), simplePdf("Evidence from PDF page"));
    const workspace = await openWorkspace(root);
    workspaces.push(workspace);

    expect(listWorkspaceSourceFiles(workspace)).toEqual(["article.pdf", "interview.docx"]);
    await expect(readWorkspaceSource(workspace, "interview.docx"))
      .resolves.toMatchObject({ text: "Interview evidence from DOCX" });
    await expect(readWorkspaceSource(workspace, "article.pdf"))
      .resolves.toMatchObject({ text: expect.stringContaining("Evidence from PDF page") });
  });
});
