import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromWeb = createRequire(path.join(repoRoot, "apps", "web", "package.json"));
const { Document, HeadingLevel, Packer, Paragraph } = requireFromWeb("docx");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const disclosure =
  "形态学通过 ≠ 文献真实存在。此检查不验证文献真实性、存在性，也不验证引文是否支持正文主张。";
const outDir = path.join(repoRoot, ".tmp-visual", "checklists");
fs.mkdirSync(outDir, { recursive: true });

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForUrl(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`CLI did not print URL. Log:\n${buffer}`)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = /(https?:\/\/\S+#token=\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => { buffer += chunk; });
  });
}

async function apiJson(baseUrl, token, route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${route} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function openChecks(page) {
  await page.getByRole("tab", { name: /审阅/ }).click();
  await page.locator(".review-sections button", { hasText: "检查" }).first().click();
  await page.locator(".review-checklists").waitFor({ state: "visible", timeout: 10_000 });
}

async function assertChecklistFits(page) {
  const result = await page.locator(".review-panel").evaluate((panel) => {
    const panelRect = panel.getBoundingClientRect();
    const selectors = [
      ".checklist-run",
      ".checklist-disclosure",
      ".checklist-batch",
      ".checklist-group",
      ".checklist-block",
      ".checklist-item",
    ];
    const offenders = [...panel.querySelectorAll(selectors.join(","))]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left < panelRect.left - 1 || rect.right > panelRect.right + 1;
      })
      .map((node) => `${node.className}:${node.textContent?.trim().slice(0, 40)}`);
    return {
      clientWidth: panel.clientWidth,
      scrollWidth: panel.scrollWidth,
      offenders,
    };
  });
  if (result.scrollWidth > result.clientWidth + 1 || result.offenders.length) {
    throw new Error(`Checklist overflows review panel: ${JSON.stringify(result)}`);
  }
}

for (const entry of fs.readdirSync(repoRoot)) {
  if (entry.startsWith(".tmp-checklist-ws-")) {
    fs.rmSync(path.join(repoRoot, entry), { recursive: true, force: true });
  }
}
const workspace = fs.mkdtempSync(path.join(repoRoot, ".tmp-checklist-ws-"));
const documentPath = path.join(workspace, "checklist-fixture.docx");
const fixture = new Document({
  sections: [{
    children: [
      new Paragraph({ text: "检查清单专项走查", heading: HeadingLevel.HEADING_1 }),
      new Paragraph("新时代背景下，治理工具需要深度融合并赋能基层实践。已有方案被描述为行之有效的路径。"),
      new Paragraph("相关研究提出了不同解释（张三，2020），也有编号引用 [12]。"),
      new Paragraph("“这是一段尚未核验出处但长度足够的直接引语内容”需要人工确认。DOI 10.1234/example.5678。"),
      new Paragraph("综上所述，本文认为该机制具有重要的理论意义。[需插入引文：治理成效]"),
      new Paragraph("新时代背景下，另一个段落同样赋能协同治理，并提出困境与路径。"),
    ],
  }],
});
fs.writeFileSync(documentPath, await Packer.toBuffer(fixture));

const port = await freePort();
const child = spawn(process.execPath, [path.join(repoRoot, "apps", "cli", "dist", "index.js"), workspace], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MARGIN_PORT: String(port),
    MARGIN_NO_OPEN: "1",
    MARGIN_ENGINE: "simple",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    MARGIN_API_KEY: "",
    MARGIN_BASE_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let browser;
try {
  const url = await waitForUrl(child);
  const parsed = new URL(url);
  const token = parsed.hash.replace(/^#token=/, "");
  const baseUrl = parsed.origin;
  const opened = await apiJson(baseUrl, token, "/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({ message: `"${documentPath}"` }),
  });
  const document = opened.opened?.document;
  const blocks = opened.opened?.blocks ?? [];
  if (!document || !blocks.length) throw new Error("Controlled DOCX did not open.");

  await apiJson(baseUrl, token, "/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({ message: "检查清单", documentId: document.id }),
  });
  let active = await apiJson(baseUrl, token, `/api/v1/documents/${document.id}/checklists`);
  const cite = active.runs.find((entry) => entry.run.checker === "cite_check");
  const style = active.runs.find((entry) => entry.run.checker === "style_lint");
  if (!cite || cite.items.length < 5) throw new Error("Citation checklist fixture did not produce all expected findings.");
  if (!style || style.items.length < 6) throw new Error("Style checklist fixture did not produce all expected findings.");
  if (new Set(cite.items.map((item) => item.issueType)).size < 4) {
    throw new Error("Citation checklist did not group multiple issue types.");
  }
  if (new Set(style.items.map((item) => item.issueType)).size < 3) {
    throw new Error("Style checklist did not group multiple issue types.");
  }

  browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".office-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".office-loading").waitFor({ state: "detached", timeout: 30_000 });
  await openChecks(page);

  const citeSection = page.locator('.checklist-run[aria-label="引用形态"]');
  const styleSection = page.locator('.checklist-run[aria-label="语体词表"]');
  if ((await citeSection.locator(".checklist-disclosure").textContent())?.trim() !== disclosure) {
    throw new Error("Citation checklist disclosure is missing or has been weakened.");
  }
  if (await citeSection.locator(".checklist-group").count() < 4) {
    throw new Error("Citation findings are not grouped by issue type.");
  }
  if (await styleSection.locator(".checklist-group").count() < 3) {
    throw new Error("Style findings are not grouped by issue type.");
  }
  await assertChecklistFits(page);
  await page.screenshot({ path: path.join(outDir, "01-desktop-groups.png") });

  const locateItem = cite.items.find((item) => item.issueType === "citation.author_year") ?? cite.items[0];
  const locateBlock = citeSection.locator(".checklist-block", { hasText: locateItem.blockId }).first();
  await locateBlock.locator(".checklist-block-heading button").click();
  await page.waitForFunction((excerpt) => {
    const host = document.querySelector(".office-editor");
    const diagnostics = host ? Reflect.get(host, "__marginOfficeDiagnostics")?.() : null;
    return diagnostics?.context?.selectionText === excerpt;
  }, locateItem.excerpt, { timeout: 10_000 });
  await page.screenshot({ path: path.join(outDir, "02-located.png") });

  const firstStyleGroup = styleSection.locator(".checklist-group").first();
  const styleGroupOpen = await firstStyleGroup.locator(".checklist-item input:not(:disabled)").count();
  if (!styleGroupOpen) throw new Error("Style group has no selectable findings.");
  await firstStyleGroup.locator(":scope > header input").check();
  await styleSection.locator(".checklist-batch button", { hasText: "标为已处理" }).click();
  await page.waitForFunction((count) => (
    document.querySelectorAll('.checklist-run[aria-label="语体词表"] .checklist-item.status-resolved').length >= count
  ), styleGroupOpen, { timeout: 10_000 });

  await page.evaluate(() => localStorage.setItem("margin_dock_width", "320"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".office-loading").waitFor({ state: "detached", timeout: 30_000 });
  await openChecks(page);
  const shellWidth = await page.locator(".sidecar-shell").evaluate((node) => node.getBoundingClientRect().width);
  if (Math.abs(shellWidth - 320) > 1) throw new Error(`Expected 320px dock, got ${shellWidth}px.`);
  await assertChecklistFits(page);

  const narrowCite = page.locator('.checklist-run[aria-label="引用形态"]');
  const openGroups = narrowCite.locator(".checklist-group", {
    has: page.locator(".checklist-item input:not(:disabled)"),
  });
  if (await openGroups.count() < 2) throw new Error("Need two open citation groups for cross-group batch review.");
  const firstCrossItem = openGroups.nth(0).locator(".checklist-item input:not(:disabled)").first();
  const secondCrossItem = openGroups.nth(1).locator(".checklist-item input:not(:disabled)").first();
  await firstCrossItem.check();
  await secondCrossItem.check();
  await narrowCite.locator(".checklist-batch > span").filter({ hasText: "已选 2 条" }).waitFor();
  await narrowCite.locator(".checklist-batch button", { hasText: "忽略" }).click();
  await page.waitForFunction(() => (
    document.querySelectorAll('.checklist-run[aria-label="引用形态"] .checklist-item.status-dismissed').length >= 2
  ), undefined, { timeout: 10_000 });
  await assertChecklistFits(page);
  await page.screenshot({ path: path.join(outDir, "03-narrow-batch-results.png") });

  active = await apiJson(baseUrl, token, `/api/v1/documents/${document.id}/checklists`);
  const storedStyle = active.runs.find((entry) => entry.run.checker === "style_lint");
  const storedCite = active.runs.find((entry) => entry.run.checker === "cite_check");
  if (storedStyle.items.filter((item) => item.status === "resolved").length < styleGroupOpen) {
    throw new Error("Resolved batch decision was not persisted.");
  }
  if (storedCite.items.filter((item) => item.status === "dismissed").length < 2) {
    throw new Error("Cross-group dismiss decision was not persisted.");
  }

  const emptyBlock = blocks.find((block) => block.kind === "heading") ?? blocks[0];
  await apiJson(baseUrl, token, "/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({
      message: "引用检查",
      documentId: document.id,
      selectionBlockIds: [emptyBlock.id],
    }),
  });
  active = await apiJson(baseUrl, token, `/api/v1/documents/${document.id}/checklists`);
  const emptyCite = active.runs.find((entry) => entry.run.checker === "cite_check");
  if (!emptyCite || emptyCite.items.length) throw new Error("Zero-finding citation run was not persisted.");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".office-loading").waitFor({ state: "detached", timeout: 30_000 });
  await openChecks(page);
  const emptyCiteSection = page.locator('.checklist-run[aria-label="引用形态"]');
  if ((await emptyCiteSection.locator(".checklist-disclosure").textContent())?.trim() !== disclosure) {
    throw new Error("Zero-finding citation run lost the fixed disclosure.");
  }
  await emptyCiteSection.locator(".checklist-empty", { hasText: "未发现引用形态项" }).waitFor();
  await assertChecklistFits(page);
  await page.screenshot({ path: path.join(outDir, "04-zero-findings.png") });

  console.log("VISUAL_CHECKLIST_OK", outDir);
} finally {
  await browser?.close().catch(() => undefined);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}
process.exit(0);
