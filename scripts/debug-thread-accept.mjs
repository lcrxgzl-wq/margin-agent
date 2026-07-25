import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sourceDocx = process.argv[2];

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
    const timer = setTimeout(() => reject(new Error(`CLI did not print URL. Log:\n${buffer}`)), timeoutMs);
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
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  return response.json();
}

const port = await freePort();
const workspace = fs.mkdtempSync(path.join(repoRoot, ".tmp-debug-thread-"));
fs.copyFileSync(sourceDocx, path.join(workspace, path.basename(sourceDocx)));
const child = spawn(process.execPath, [path.join(repoRoot, "apps/cli/dist/index.js"), workspace], {
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
  const chat = { opened: null };
  const parsed = new URL(url);
  const token = parsed.hash.replace(/^#token=/, "");
  const baseUrl = parsed.origin;
  const chatResult = await apiJson(baseUrl, token, "/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({ message: `"${path.join(workspace, path.basename(sourceDocx))}"` }),
  });
  Object.assign(chat, chatResult);
  console.log("opened:", chat.opened?.document?.relativePath ?? JSON.stringify(chatResult).slice(0, 200));
  const translationBlock = chat.opened.blocks.find((block) =>
    block.kind !== "table" && /[A-Za-z]{4}/.test(block.text) && block.text.length > 32,
  );
  const translationMatch = /[A-Za-z][A-Za-z\s,.'()\-]{24,72}/.exec(translationBlock.text);
  const selection = translationMatch[0].trim();
  console.log("selection:", selection);

  browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => console.log("PAGEERROR:", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.log("CONSOLE:", message.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".office-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".office-loading").waitFor({ state: "detached", timeout: 30_000 });
  await page.getByTitle("专注文稿").click();
  await page.locator(".office-editor").evaluate((element, query) => {
    return Reflect.get(element, "__marginOfficeTestSelect")?.(query, 0) ?? null;
  }, selection);
  await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".sel-bubble button").filter({ hasText: /^译[中英]$/ }).click();
  await page.locator(".thread-popover .review-fragment.before del").waitFor({ state: "visible", timeout: 30_000 });
  console.log("proposal card visible");
  await page.locator(".thread-popover .review-actions button.primary").filter({ hasText: "接受" }).click();
  await page.waitForTimeout(4000);
  const state = await page.evaluate(() => ({
    popover: document.querySelectorAll(".thread-popover").length,
    reviewError: document.querySelector(".review-error")?.textContent ?? null,
    railDots: document.querySelectorAll(".anchor-rail .anchor-dot").length,
    dirty: document.querySelectorAll(".doc-dirty").length,
    bodySnippet: document.body.innerText.slice(0, 400),
  }));
  console.log("after-accept:", JSON.stringify(state, null, 2));
  const proposals = await apiJson(baseUrl, token, `/api/v1/documents/${chat.opened.document.id}/proposals?status=proposed`);
  console.log("pending proposals after accept:", proposals.proposals?.length);
  await page.screenshot({ path: path.join(repoRoot, ".tmp-debug-thread.png"), fullPage: false });
} finally {
  await browser?.close().catch(() => undefined);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}
process.exit(0);
