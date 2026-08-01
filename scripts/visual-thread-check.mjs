import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sourceDocx = process.argv[2];
if (!sourceDocx || !fs.existsSync(sourceDocx)) {
  console.error("usage: node scripts/visual-thread-check.mjs <docx>");
  process.exit(2);
}
const outDir = path.join(repoRoot, ".tmp-visual");
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
// Clean up workspaces left behind by previous runs of this script.
for (const entry of fs.readdirSync(repoRoot)) {
  if (entry.startsWith(".tmp-visual-ws-")) {
    fs.rmSync(path.join(repoRoot, entry), { recursive: true, force: true });
  }
}
const workspace = fs.mkdtempSync(path.join(repoRoot, ".tmp-visual-ws-"));
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
  const parsed = new URL(url);
  const token = parsed.hash.replace(/^#token=/, "");
  const baseUrl = parsed.origin;
  const chat = await apiJson(baseUrl, token, "/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({ message: `"${path.join(workspace, path.basename(sourceDocx))}"` }),
  });
  const block = chat.opened.blocks.find((candidate) =>
    candidate.kind !== "table" && candidate.text.startsWith("Urban project scopes"),
  ) ?? chat.opened.blocks.find((candidate) =>
    candidate.kind !== "table" && /[A-Za-z]{4}/.test(candidate.text) && candidate.text.length > 32,
  );
  // Keep this anchored at offset 0: canvas-editor can report a phantom extra
  // paragraph for selections that begin at the first character.
  const selection = block.text.slice(0, 72).trimEnd();

  browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".office-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".office-loading").waitFor({ state: "detached", timeout: 30_000 });
  await page.waitForTimeout(800);

  const selectText = (query) => page.locator(".office-editor").evaluate((element, target) => {
    return Reflect.get(element, "__marginOfficeTestSelect")?.(target, 0) ?? null;
  }, query);
  const assertViewportContained = async (locator, label) => {
    const box = await locator.boundingBox();
    const viewport = page.viewportSize();
    if (
      !box
      || !viewport
      || box.x < -1
      || box.y < -1
      || box.x + box.width > viewport.width + 1
      || box.y + box.height > viewport.height + 1
    ) {
      throw new Error(
        `${label} must remain fully inside the viewport: `
        + `box=${JSON.stringify(box)}, viewport=${JSON.stringify(viewport)}`,
      );
    }
  };

  // 1. Selection bubble
  await selectText(selection);
  const selectionY = await page.locator(".office-editor").evaluate((element) => {
    return Reflect.get(element, "__marginOfficeDiagnostics")?.().context?.rangeRects?.[0]?.y ?? 0;
  });
  await page.locator(".office-canvas-scroll").evaluate((element, targetY) => {
    element.scrollTop = Math.max(0, targetY - element.clientHeight / 3);
  }, selectionY);
  await page.waitForTimeout(200);
  await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
  const bubbleBox = await page.locator(".sel-bubble").boundingBox();
  if (!bubbleBox) throw new Error("Selection bubble has no measurable position.");
  const selectionAnchorY = bubbleBox.y + 48;
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "01-bubble.png") });

  // 2. Single-shot translation keeps the draggable/resizable floating-window workflow.
  await page.getByRole("button", { name: /^译[英中]$/ }).click();
  const translationPopover = page.locator(".translation-popover");
  await translationPopover.waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".translation-body p").waitFor({ state: "visible", timeout: 10_000 });
  if (await page.locator(".thread-popover").count()) {
    throw new Error("Single-shot translation must not create an Agent thread.");
  }
  const initialTranslationBox = await translationPopover.boundingBox();
  const translationHeadBox = await page.locator(".translation-heading").boundingBox();
  if (!initialTranslationBox || !translationHeadBox) {
    throw new Error("Translation popover has no measurable position.");
  }
  const dragX = initialTranslationBox.x > 400 ? -80 : 80;
  const dragY = initialTranslationBox.y > 400 ? -60 : 60;
  await page.mouse.move(translationHeadBox.x + 48, translationHeadBox.y + translationHeadBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(translationHeadBox.x + 48 + dragX, translationHeadBox.y + translationHeadBox.height / 2 + dragY, { steps: 6 });
  await page.mouse.up();
  const draggedTranslationBox = await translationPopover.boundingBox();
  if (!draggedTranslationBox || Math.abs(draggedTranslationBox.x - initialTranslationBox.x) < 30) {
    throw new Error("Translation popover must move when its header is dragged.");
  }
  const resizeBox = await page.locator(".translation-resize").boundingBox();
  if (!resizeBox) throw new Error("Translation popover resize handle is missing.");
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 - 60, resizeBox.y + resizeBox.height / 2 - 10, { steps: 6 });
  await page.mouse.up();
  const resizedTranslationBox = await translationPopover.boundingBox();
  if (!resizedTranslationBox || initialTranslationBox.width - resizedTranslationBox.width < 30) {
    throw new Error("Translation popover must resize from its lower-right handle.");
  }
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, "02-translation-floating.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await assertViewportContained(translationPopover, "Translation popover after viewport resize");
  await page.screenshot({ path: path.join(outDir, "02-translation-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "关闭翻译" }).click();
  await translationPopover.waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 5_000 });

  // 3. Discussion thread popover
  await page.locator(".sel-bubble button").filter({ hasText: "讨论" }).click();
  const threadPopover = page.locator(".thread-popover");
  await threadPopover.waitFor({ state: "visible", timeout: 10_000 });
  const initialThreadBox = await threadPopover.boundingBox();
  const threadHeadBox = await page.locator(".thread-head").boundingBox();
  if (!initialThreadBox || !threadHeadBox) {
    throw new Error("Thread popover has no measurable position.");
  }
  const threadDragX = initialThreadBox.x > 400 ? -60 : 60;
  const threadDragY = initialThreadBox.y > 400 ? -40 : 40;
  await page.mouse.move(threadHeadBox.x + 80, threadHeadBox.y + threadHeadBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(threadHeadBox.x + 80 + threadDragX, threadHeadBox.y + threadHeadBox.height / 2 + threadDragY, { steps: 6 });
  await page.mouse.up();
  const draggedThreadBox = await threadPopover.boundingBox();
  if (!draggedThreadBox || Math.abs(draggedThreadBox.x - initialThreadBox.x) < 30) {
    throw new Error("Thread popover must move when its header is dragged.");
  }
  const threadResizeBox = await page.locator(".thread-resize").boundingBox();
  if (!threadResizeBox) throw new Error("Thread popover resize handle is missing.");
  await page.mouse.move(threadResizeBox.x + threadResizeBox.width / 2, threadResizeBox.y + threadResizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(threadResizeBox.x + threadResizeBox.width / 2 - 50, threadResizeBox.y + threadResizeBox.height / 2 - 30, { steps: 6 });
  await page.mouse.up();
  const resizedThreadBox = await threadPopover.boundingBox();
  if (!resizedThreadBox || initialThreadBox.width - resizedThreadBox.width < 25) {
    throw new Error("Thread popover must resize from its lower-right handle.");
  }
  const composer = page.locator(".thread-popover .thread-composer textarea");
  await composer.fill("这段的论证风险是什么？");
  await page.locator(".thread-popover .thread-send").click();
  await page.waitForFunction(() => {
    const node = document.querySelector(".thread-popover .thread-composer textarea");
    const replies = [...document.querySelectorAll('.thread-popover .thread-message[data-role="assistant"]')];
    const reply = replies.at(-1);
    return Boolean(node && !node.disabled && reply?.textContent && reply.textContent.trim().length > 2);
  }, undefined, { timeout: 30_000 });
  const duplicatedThreadTurn = page.locator(".chat-activity .turn", { hasText: "这段的论证风险是什么？" });
  if (await duplicatedThreadTurn.count()) {
    throw new Error("Anchored thread messages must not be rendered in the global chat pane.");
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "02-thread-discussion.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await assertViewportContained(threadPopover, "Thread popover after viewport resize");
  await page.screenshot({ path: path.join(outDir, "02-thread-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(200);

  // 3. Proposal card inside the same thread
  await composer.fill("译成英文");
  await page.locator(".thread-popover .thread-send").click();
  await page.locator(".thread-popover .review-fragment.before del").waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector(".thread-popover .thread-composer textarea");
    return Boolean(node && !node.disabled);
  }, undefined, { timeout: 60_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "03-thread-proposal.png") });

  // 4. Collapse to rail
  await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
  await page.locator(".thread-popover").waitFor({ state: "detached", timeout: 5_000 });
  const anchorDot = page.locator(".anchor-rail .anchor-dot");
  await anchorDot.waitFor({ state: "visible", timeout: 5_000 });
  // 修订标记注入后正文会重排（ins 文本撑长段落，锚点随之下移），
  // 第一步测得的选区 Y 已过期——以当前正文中选区文本的位置重新取参考值。
  await selectText(selection);
  await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
  const refreshedBubbleBox = await page.locator(".sel-bubble").boundingBox();
  const currentAnchorY = refreshedBubbleBox ? refreshedBubbleBox.y + 48 : selectionAnchorY;
  const anchorDotBox = await anchorDot.boundingBox();
  if (!anchorDotBox || Math.abs(anchorDotBox.y + anchorDotBox.height / 2 - currentAnchorY) > 36) {
    throw new Error("Collapsed thread anchor must remain beside its original selection.");
  }
  const scrolledBy = await page.locator(".office-canvas-scroll").evaluate((element) => {
    const before = element.scrollTop;
    element.scrollTop = before + 120;
    return element.scrollTop - before;
  });
  await page.waitForTimeout(120);
  const scrolledAnchorDotBox = await anchorDot.boundingBox();
  if (!scrolledAnchorDotBox || Math.abs(scrolledAnchorDotBox.y + scrolledAnchorDotBox.height / 2 - (currentAnchorY - scrolledBy)) > 36) {
    throw new Error("Collapsed thread anchor must follow its selection when the Word canvas scrolls.");
  }
  const [scrolledBubbleBox, officeToolbarBox] = await Promise.all([
    page.locator(".sel-bubble").boundingBox(),
    page.locator(".office-toolbar").boundingBox(),
  ]);
  if (!scrolledBubbleBox || !officeToolbarBox || scrolledBubbleBox.y < officeToolbarBox.y + officeToolbarBox.height) {
    throw new Error("Selection tools must not overlap the Word toolbar after scrolling near the document top.");
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "04-rail-collapsed.png") });

  // 5. The nearby rail dot restores the same thread before the inbox route does.
  await anchorDot.click();
  await page.locator(".thread-popover").waitFor({ state: "visible", timeout: 10_000 });
  const railRestoredTurn = page.locator('.thread-popover .thread-message[data-role="user"]', { hasText: "这段的论证风险是什么？" });
  if (await railRestoredTurn.count() !== 1) {
    throw new Error("The nearby rail anchor must restore the collapsed thread context exactly once.");
  }
  await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
  await page.locator(".thread-popover").waitFor({ state: "detached", timeout: 5_000 });

  // 6. Sidecar inbox (review tab with thread list)
  await page.getByTitle("停靠侧栏").click();
  await page.getByRole("tab", { name: /审阅/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "05-inbox.png") });

  // 7. The inbox must restore the thread context after it leaves the canvas.
  await page.locator(".review-thread-item").click();
  await page.locator(".thread-popover").waitFor({ state: "visible", timeout: 10_000 });
  if (await page.getByRole("tab", { name: "对话" }).getAttribute("aria-selected") !== "true") {
    throw new Error("Opening a thread must move the sidecar away from its duplicate review actions.");
  }
  const restoredTurn = page.locator('.thread-popover .thread-message[data-role="user"]', { hasText: "这段的论证风险是什么？" });
  if (await restoredTurn.count() !== 1) {
    throw new Error("The review inbox must restore the collapsed thread context exactly once.");
  }
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, "06-thread-restored.png") });

  console.log("VISUAL_CHECK_OK", outDir);
} finally {
  await browser?.close().catch(() => undefined);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}
process.exit(0);
