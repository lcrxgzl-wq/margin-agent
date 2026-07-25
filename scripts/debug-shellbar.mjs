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

async function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(buffer)), 20_000);
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

const port = await freePort();
const workspace = fs.mkdtempSync(path.join(repoRoot, ".tmp-probe-ws-"));
fs.copyFileSync(sourceDocx, path.join(workspace, path.basename(sourceDocx)));
const child = spawn(process.execPath, [path.join(repoRoot, "apps/cli/dist/index.js"), workspace], {
  cwd: repoRoot,
  env: { ...process.env, MARGIN_PORT: String(port), MARGIN_NO_OPEN: "1", MARGIN_ENGINE: "simple", OPENAI_API_KEY: "", MARGIN_BASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let browser;
try {
  const url = await waitForUrl(child);
  const parsed = new URL(url);
  const token = parsed.hash.replace(/^#token=/, "");
  await fetch(`${parsed.origin}/api/v1/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `"${path.join(workspace, path.basename(sourceDocx))}"` }),
  });
  browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".office-workspace").waitFor({ state: "visible", timeout: 45_000 });
  await page.locator(".office-loading").waitFor({ state: "detached", timeout: 45_000 });
  await page.waitForTimeout(800);
  const probe = await page.evaluate(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const floatBtn = document.querySelector('.layout-control button[title="悬浮侧栏"]');
    const r = floatBtn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      shellBar: box(".shell-bar"),
      tabs: box(".activity-tabs"),
      tab2: box(".activity-tabs button:nth-child(2)"),
      layoutControl: box(".layout-control"),
      floatBtn: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) },
      hitAtFloatCenter: hit ? `${hit.tagName}.${hit.className}` : null,
      sidecarWidth: document.querySelector(".sidecar-shell")?.getBoundingClientRect().width,
      layout: document.querySelector(".app")?.className,
    };
  });
  console.log(JSON.stringify(probe, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}
process.exit(0);
