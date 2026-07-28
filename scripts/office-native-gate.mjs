import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceArgument = process.argv.slice(2).find((argument) => argument !== "--");
const sourceDocx = path.resolve(sourceArgument ?? process.env.MARGIN_OFFICE_DOCX ?? "");
const edgePath = process.env.MARGIN_EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const keepArtifacts = process.env.MARGIN_KEEP_OFFICE_E2E === "1";
const workspace = path.join(repoRoot, `.tmp-office-e2e-${process.pid}`);
const artifactDir = path.join(workspace, "artifacts");
const storageRequire = createRequire(path.join(repoRoot, "packages/storage-local/package.json"));

function invariant(value, message) {
  if (!value) throw new Error(message);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  invariant(address && typeof address === "object", "could not allocate a test port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startCli(port) {
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
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForUrl(server, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = /UI:\s+(http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+)/i.exec(server.output());
    if (match) return match[1];
    if (server.child.exitCode != null) {
      throw new Error(`CLI exited before startup (${server.child.exitCode})\n${server.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`CLI startup timed out\n${server.output()}`);
}

async function stopCli(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

function tableShape(tableText) {
  const rows = tableText.split("\n");
  return {
    rows: rows.length,
    columns: Math.max(...rows.map((row) => row.split("\t").length)),
  };
}

function countXml(xml, pattern) {
  return (xml.match(pattern) ?? []).length;
}

async function docxProtectedShape(filePath) {
  const JSZip = storageRequire("jszip");
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const documentXml = await zip.file("word/document.xml")?.async("string");
  invariant(documentXml, "DOCX has no word/document.xml");
  return {
    headers: zip.file(/^word\/header\d+\.xml$/).length,
    footers: zip.file(/^word\/footer\d+\.xml$/).length,
    comments: zip.file("word/comments.xml") ? 1 : 0,
    fields: countXml(documentXml, /<w:(?:fldChar|instrText)[ >]/g),
    hyperlinks: countXml(documentXml, /<w:hyperlink[ >]/g),
    bookmarks: countXml(documentXml, /<w:bookmarkStart[ >]/g),
    tables: countXml(documentXml, /<w:tbl[ >]/g),
  };
}

function localXmlName(name) {
  const separator = name.indexOf(":");
  return separator < 0 ? name : name.slice(separator + 1);
}

function xmlChildren(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node) => {
    if (!node || typeof node !== "object") return [];
    return Object.entries(node)
      .filter(([name]) => name !== ":@" && name !== "#text")
      .map(([name, children]) => ({ name, children: Array.isArray(children) ? children : [] }));
  });
}

function xmlChild(nodes, wanted) {
  return xmlChildren(nodes).find(({ name }) => localXmlName(name) === wanted);
}

function containsXmlNode(nodes, wanted) {
  return xmlChildren(nodes).some(({ name, children }) =>
    wanted.has(localXmlName(name)) || containsXmlNode(children, wanted),
  );
}

async function safeParagraphBodyIndexes(filePath) {
  const JSZip = storageRequire("jszip");
  const { XMLParser } = storageRequire("fast-xml-parser");
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const xml = await zip.file("word/document.xml")?.async("string");
  invariant(xml, "DOCX has no word/document.xml");
  const tree = new XMLParser({ ignoreAttributes: false, preserveOrder: true }).parse(xml);
  const documentNode = xmlChild(tree, "document");
  const body = xmlChild(documentNode?.children, "body");
  invariant(body, "DOCX document.xml has no body");
  const protectedNodes = new Set([
    "fldChar", "instrText", "hyperlink", "commentRangeStart", "commentRangeEnd",
    "commentReference", "bookmarkStart", "bookmarkEnd", "drawing", "pict", "object",
    "footnoteReference", "endnoteReference", "sdt", "smartTag", "ins", "del", "moveFrom", "moveTo",
  ]);
  return new Set(xmlChildren(body.children)
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => localXmlName(entry.name) === "p" && !containsXmlNode(entry.children, protectedNodes))
    .map(({ index }) => index));
}

function stableBlockSelection(block) {
  const candidates = [
    /[A-Za-z][A-Za-z\s,.'()\-]{15,40}/.exec(block.text)?.[0],
    /[\u3400-\u9fff，。；：、“”]{12,28}/.exec(block.text)?.[0],
  ].filter(Boolean).map((value) => value.trim());
  return candidates[0];
}

async function apiJson(baseUrl, token, route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route}: ${data.error ?? response.statusText}`);
  return data;
}

async function closeSettings(page) {
  const close = page.getByRole("button", { name: "关闭设置" });
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function verifyLlmSetupFlow(page) {
  let discoveredDraft;
  let testedDraft;
  let savedDraft;
  const modelsHandler = async (route) => {
    discoveredDraft = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        models: ["gpt-margin-fast", "gpt-margin-reasoning"],
        latencyMs: 28,
        detail: "已发现 2 个模型",
        resolvedBaseURL: "https://gateway.margin.test/v1",
      }),
    });
  };
  const testHandler = async (route) => {
    testedDraft = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        latencyMs: 42,
        detail: "模型响应正常",
        resolvedBaseURL: "https://gateway.margin.test/v1",
      }),
    });
  };
  const saveHandler = async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    savedDraft = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        activeId: "custom",
        provider: null,
        providers: [],
        presets: [],
        llmMode: "mock",
      }),
    });
  };

  await page.route("**/api/v1/settings/llm/models", modelsHandler);
  await page.route("**/api/v1/settings/llm/test", testHandler);
  await page.route("**/api/v1/settings/llm", saveHandler);
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.waitFor({ state: "visible", timeout: 5_000 });
    await settings.getByRole("tab", { name: "模型" }).click();
    const address = settings.locator('input[autocomplete="url"]');
    await address.fill("https://gateway.margin.test/v1");
    await settings.getByRole("radio", { name: "Anthropic" }).click();
    invariant(await address.inputValue() === "https://gateway.margin.test", "Anthropic did not remove the OpenAI /v1 suffix");
    await settings.getByText("默认鉴权：x-api-key", { exact: true }).waitFor({ timeout: 5_000 });
    await settings.getByText("https://gateway.margin.test/v1/messages", { exact: true }).waitFor({ timeout: 5_000 });
    await settings.getByRole("radio", { name: "OpenAI 兼容" }).click();
    invariant(await address.inputValue() === "https://gateway.margin.test/v1", "OpenAI did not restore the /v1 suffix");
    await settings.getByText("默认鉴权：Authorization: Bearer", { exact: true }).waitFor({ timeout: 5_000 });
    await settings.getByLabel("API Key").fill("sk-margin-e2e");
    await settings.getByRole("button", { name: "读取模型" }).click();
    await settings.getByText("模型读取成功", { exact: true }).waitFor({ timeout: 5_000 });
    invariant(
      JSON.stringify(discoveredDraft) === JSON.stringify({
        apiFormat: "openai",
        authStyle: "bearer",
        baseURL: "https://gateway.margin.test/v1",
        apiKey: "sk-margin-e2e",
        reuseStoredKey: false,
      }),
      `model discovery used an unexpected draft: ${JSON.stringify(discoveredDraft)}`,
    );
    const modelSelect = settings.getByLabel("选择模型");
    await modelSelect.selectOption("gpt-margin-reasoning");
    await settings.getByRole("button", { name: "测试连接" }).click();
    await settings.getByText("模型测试成功", { exact: true }).waitFor({ timeout: 5_000 });
    await settings.getByText("42 ms", { exact: true }).waitFor({ timeout: 5_000 });
    invariant(
      JSON.stringify(testedDraft) === JSON.stringify({
        apiFormat: "openai",
        authStyle: "bearer",
        baseURL: "https://gateway.margin.test/v1",
        apiKey: "sk-margin-e2e",
        model: "gpt-margin-reasoning",
        reuseStoredKey: false,
      }),
      `connection test used an unexpected draft: ${JSON.stringify(testedDraft)}`,
    );
    const screenshot = path.join(artifactDir, "settings-flow.png");
    await settings.screenshot({ path: screenshot });
    await settings.getByRole("button", { name: "保存并使用" }).click();
    await settings.waitFor({ state: "detached", timeout: 5_000 });
    invariant(
      JSON.stringify(savedDraft) === JSON.stringify({
        provider: {
          apiFormat: "openai",
          authStyle: "bearer",
          baseURL: "https://gateway.margin.test/v1",
          model: "gpt-margin-reasoning",
          apiKey: "sk-margin-e2e",
        },
      }),
      `save used an unexpected draft: ${JSON.stringify(savedDraft)}`,
    );
    return screenshot;
  } finally {
    await page.unroute("**/api/v1/settings/llm/models", modelsHandler);
    await page.unroute("**/api/v1/settings/llm/test", testHandler);
    await page.unroute("**/api/v1/settings/llm", saveHandler);
  }
}

async function waitForOffice(page) {
  await page.locator(".office-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".office-loading").waitFor({ state: "detached", timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll(".office-editor canvas").length > 0);
}

async function waitForVisualStability(page, selector) {
  await page.locator(selector).evaluate(async (element) => {
    await document.fonts?.ready;
    const finiteAnimations = element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.race([
      Promise.allSettled(finiteAnimations.map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function verifyStopControl(page) {
  let releaseRoute;
  const stalled = new Promise((resolve) => { releaseRoute = resolve; });
  const handler = async (route) => {
    await stalled;
    await route.abort("aborted").catch(() => undefined);
  };
  await page.route("**/api/v1/chat/stream", handler);
  try {
    await page.getByRole("tab", { name: /对话/ }).click();
    const composer = page.locator(".chat-activity textarea");
    await composer.fill("测试停止生成");
    await page.getByRole("button", { name: "发送" }).click();
    const stop = page.getByRole("button", { name: "停止生成" });
    await stop.waitFor({ state: "visible", timeout: 5_000 });
    await stop.click();
    releaseRoute();
    await page.getByText("已停止本轮生成。", { exact: true }).waitFor({ timeout: 5_000 });
  } finally {
    releaseRoute?.();
    await page.unroute("**/api/v1/chat/stream", handler);
  }
}

async function verifyWorkspaceSkillLifecycle(page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "设置", exact: true });
  await modal.waitFor({ state: "visible", timeout: 5_000 });
  await modal.getByRole("tab", { name: "方法" }).click();
  await modal.locator(".extensions-import textarea").fill(
    "---\nname: gate-review-skill\ndescription: Gate-only review method\n---\n\nRead evidence before proposing edits.",
  );
  await modal.getByRole("button", { name: "导入 Skill", exact: true }).click();
  const imported = modal.getByText("gate-review-skill", { exact: true });
  await imported.waitFor({ timeout: 5_000 });
  const screenshot = path.join(artifactDir, "office-extensions.png");
  await modal.screenshot({ path: screenshot });
  await modal.getByRole("tab", { name: "外部工具" }).click();
  await modal.getByText("尚未配置 MCP。", { exact: true }).waitFor({ timeout: 5_000 });
  await modal.getByRole("tab", { name: "方法" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await modal.getByRole("button", { name: "移除 gate-review-skill" }).click();
  await imported.waitFor({ state: "detached", timeout: 5_000 });
  await modal.getByRole("button", { name: "关闭设置" }).click();
  return screenshot;
}

async function canvasInk(page) {
  return page.locator(".office-editor canvas").evaluateAll((canvases) => {
    let sampled = 0;
    let ink = 0;
    for (const canvas of canvases) {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context || !canvas.width || !canvas.height) continue;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const stride = Math.max(4, Math.floor((canvas.width * canvas.height) / 25_000) * 4);
      for (let index = 0; index < pixels.length; index += stride) {
        sampled += 1;
        if (pixels[index + 3] > 0 && (pixels[index] < 235 || pixels[index + 1] < 235 || pixels[index + 2] < 235)) ink += 1;
      }
    }
    return { canvases: canvases.length, sampled, ink };
  });
}

async function findTablePage(page) {
  const canvases = page.locator('.office-editor canvas[data-index]');
  const candidates = [];
  for (let pageIndex = 0; pageIndex < await canvases.count(); pageIndex += 1) {
    const canvas = canvases.nth(pageIndex);
    await canvas.scrollIntoViewIfNeeded();
    await page.waitForTimeout(80);
    candidates.push(await canvas.evaluate((canvas) => {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return { page: Number(canvas.dataset.index), lines: 0 };
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let lines = 0;
      const requiredRun = Math.floor(canvas.width * 0.08);
      for (let y = 0; y < canvas.height; y += 2) {
        let run = 0;
        let longest = 0;
        for (let x = 0; x < canvas.width; x += 1) {
          const index = (y * canvas.width + x) * 4;
          const dark = pixels[index + 3] > 0 && pixels[index] < 225 && pixels[index + 1] < 225 && pixels[index + 2] < 225;
          run = dark ? run + 1 : 0;
          if (run > longest) longest = run;
        }
        if (longest >= requiredRun) lines += 1;
      }
      return { page: Number(canvas.dataset.index), lines };
    }));
  }
  return candidates.sort((left, right) => right.lines - left.lines)[0] ?? { page: -1, lines: 0 };
}

async function main() {
  invariant(sourceDocx && fs.existsSync(sourceDocx), "pass an existing DOCX path to gate:office");
  invariant(/\.docx$/i.test(sourceDocx), "office gate source must be .docx");
  invariant(fs.existsSync(edgePath), `Microsoft Edge not found: ${edgePath}`);
  fs.mkdirSync(artifactDir, { recursive: true });
  const originalProtectedShape = await docxProtectedShape(sourceDocx);
  const safeFormattingIndexes = await safeParagraphBodyIndexes(sourceDocx);

  const port = await freePort();
  const server = startCli(port);
  let browser;
  try {
    const url = await waitForUrl(server);
    const parsed = new URL(url);
    const token = parsed.hash.replace(/^#token=/, "");
    const baseUrl = parsed.origin;
    const chat = await apiJson(baseUrl, token, "/api/v1/chat", {
      method: "POST",
      body: JSON.stringify({ message: `"${sourceDocx}"` }),
    });
    invariant(chat.opened?.document?.relativePath?.endsWith(".docx"), "chat did not open native DOCX");
    const originalTable = chat.opened.blocks.find((block) => block.kind === "table");
    invariant(originalTable, "DOCX table was not indexed as a table block");
    const originalShape = tableShape(originalTable.text);
    invariant(originalShape.rows === 31, `expected 31 table rows, got ${originalShape.rows}`);
    invariant(originalShape.columns === 5, `expected 5 table columns, got ${originalShape.columns}`);
    invariant(!chat.opened.blocks.some((block) => block.text.includes("\uFFFD")), "replacement characters found in DOCX index");
    const translationBlock = chat.opened.blocks.find((block) =>
      block.kind !== "table" && /[A-Za-z]{4}/.test(block.text) && block.text.length > 32,
    ) ?? chat.opened.blocks.find((block) => block.kind !== "table" && /[\u3400-\u9fff]{8}/.test(block.text));
    invariant(translationBlock, "could not find a text block for selection translation");
    const translationMatch = /[A-Za-z][A-Za-z\s,.'()\-]{24,72}/.exec(translationBlock.text)
      ?? /[\u3400-\u9fff，。；：、“”]{10,32}/.exec(translationBlock.text);
    invariant(translationMatch?.[0]?.trim(), "could not derive a stable translation selection");
    const translationSelection = translationMatch[0].trim();
    const formattingBlock = chat.opened.blocks.find((block) => {
      const bodyIndex = Number(/^ooxml-p-(\d+)-/.exec(block.id)?.[1]);
      return block.id !== translationBlock.id && safeFormattingIndexes.has(bodyIndex) && stableBlockSelection(block);
    });
    invariant(formattingBlock, "could not find an unprotected paragraph for formatting save");
    const formattingSelection = stableBlockSelection(formattingBlock);
    invariant(formattingSelection, "could not derive a stable formatting selection");

    browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForOffice(page);
    await closeSettings(page);
    const settingsScreenshot = await verifyLlmSetupFlow(page);
    const extensionsScreenshot = await verifyWorkspaceSkillLifecycle(page);
    await verifyStopControl(page);
    const editorState = await page.locator(".office-editor").evaluate((element) => {
      return Reflect.get(element, "__marginOfficeDiagnostics")?.() ?? { elements: 0, text: 0 };
    });
    invariant(editorState.elements > 0 && editorState.text > 0, `editor model is empty: ${JSON.stringify(editorState)}`);
    invariant(
      editorState.backingRatios?.some((ratio) => ratio > 0) &&
        editorState.backingRatios.filter((ratio) => ratio > 0).every((ratio) => ratio >= 1.8),
      `Office canvas backing resolution is too low: ${JSON.stringify(editorState.backingRatios)}`,
    );
    const ink = await canvasInk(page);
    invariant(ink.canvases > 0 && ink.ink > 150, `Office canvas is blank: ${JSON.stringify(ink)}`);
    const pageWidthBeforeReview = await page.locator('.office-editor canvas[data-index="0"]').evaluate((canvas) => canvas.getBoundingClientRect().width);
    await page.getByTitle("专注文稿").click();
    await waitForVisualStability(page, ".office-workspace");
    const focusPageOffset = await page.locator('.office-editor canvas[data-index="0"]').evaluate((canvas) => {
      const scroll = canvas.closest(".office-canvas-scroll");
      if (!scroll) return Number.POSITIVE_INFINITY;
      const page = canvas.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      return Math.abs(page.left + page.width / 2 - (viewport.left + viewport.width / 2));
    });
    invariant(focusPageOffset < 2, `focus view did not center the Word page (${focusPageOffset}px)`);
    const selectedRange = await page.locator(".office-editor").evaluate((element, selection) => {
      return Reflect.get(element, "__marginOfficeTestSelect")?.(selection, 0) ?? null;
    }, translationSelection);
    invariant(selectedRange, `could not select translation sample: ${translationSelection}`);
    await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
    const bubbleLabels = (await page.locator(".sel-bubble button").allTextContents()).map((label) => label.trim());
    invariant(
      bubbleLabels.includes("改写") && bubbleLabels.includes("讨论") && bubbleLabels.includes("更多") &&
        bubbleLabels.some((label) => /^译[中英]$/.test(label)),
      `selection bubble did not converge to anchored-thread actions: ${JSON.stringify(bubbleLabels)}`,
    );
    // Translation is a writing aid shown inside the thread window — it must
    // never enter the proposal pipeline or touch the document.
    await page.locator(".sel-bubble button").filter({ hasText: /^译[中英]$/ }).click();
    await page.locator(".thread-popover").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator('.thread-popover .thread-message[data-role="user"]').filter({ hasText: "译成" })
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForFunction(() => {
      const composer = document.querySelector(".thread-popover .thread-composer textarea");
      const replies = [...document.querySelectorAll('.thread-popover .thread-message[data-role="assistant"]')];
      const reply = replies.at(-1);
      return Boolean(
        composer && !composer.disabled && reply?.textContent &&
          reply.textContent.trim().length > 2 && reply.textContent.trim() !== "…",
      );
    }, undefined, { timeout: 30_000 });
    const proposalsAfterTranslate = await apiJson(baseUrl, token, `/api/v1/documents/${chat.opened.document.id}/proposals?status=proposed`);
    invariant(
      !proposalsAfterTranslate.proposals.some((proposal) => proposal.operation?.kind === "translate"),
      "assist translation leaked into the proposal pipeline",
    );
    const blocksAfterTranslate = await apiJson(baseUrl, token, `/api/v1/documents/${chat.opened.document.id}/blocks`);
    invariant(
      blocksAfterTranslate.blocks.find((block) => block.id === translationBlock.id)?.text === translationBlock.text,
      "assist translation changed the document",
    );
    await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
    await page.locator(".thread-popover").waitFor({ state: "detached", timeout: 5_000 });
    // Rewrite keeps the structured-proposal path: accept + idempotent replay coverage stays.
    const rewriteRange = await page.locator(".office-editor").evaluate((element, selection) => {
      return Reflect.get(element, "__marginOfficeTestSelect")?.(selection, 0) ?? null;
    }, translationSelection);
    invariant(rewriteRange, `could not reselect rewrite sample: ${translationSelection}`);
    await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".sel-bubble button").filter({ hasText: "改写" }).click();
    await page.locator(".thread-popover").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".thread-popover .review-fragment.before del").waitFor({ state: "visible", timeout: 30_000 });
    const reviewedSource = (await page.locator(".thread-popover .review-fragment.before del").textContent())?.trim();
    invariant(reviewedSource === translationSelection, `review did not isolate selected source: ${JSON.stringify({ translationSelection, reviewedSource })}`);
    invariant((await page.locator(".thread-popover .review-heading strong").textContent())?.trim() === "改写", "selection operation was not preserved as rewrite");
    const reviewedReplacement = (await page.locator(".thread-popover .review-fragment.after ins").textContent())?.trim() ?? "";
    invariant(reviewedReplacement.length > 0, "review replacement is empty");
    invariant(reviewedReplacement !== translationBlock.text, "review rendered the full mixed-language block as the replacement");
    const blocksBeforeAccept = await apiJson(baseUrl, token, `/api/v1/documents/${chat.opened.document.id}/blocks`);
    const proposalsBeforeAccept = await apiJson(baseUrl, token, `/api/v1/documents/${chat.opened.document.id}/proposals?status=proposed`);
    const translationProposal = proposalsBeforeAccept.proposals.find((proposal) => proposal.operation?.kind === "rewrite");
    invariant(translationProposal, "structured rewrite proposal was not persisted");
    invariant(translationProposal.blockId === translationBlock.id, "selection was attached to the wrong OOXML block");
    invariant(
      blocksBeforeAccept.blocks.find((block) => block.id === translationBlock.id)?.text === translationBlock.text,
      "rewrite proposal changed the document before Accept",
    );
    invariant(await page.locator(".office-review-rail").count() === 0, "legacy Office review rail is still mounted");
    const pageWidthDuringReview = await page.locator('.office-editor canvas[data-index="0"]').evaluate((canvas) => canvas.getBoundingClientRect().width);
    invariant(Math.abs(pageWidthBeforeReview - pageWidthDuringReview) < 1, "review activity changed the Word page scale");
    await page.locator(".thread-popover .review-actions button.primary").filter({ hasText: "接受" }).click();
    await page.locator(".thread-popover").waitFor({ state: "detached", timeout: 30_000 });
    await waitForOffice(page);
    const dirtyDiagnostics = await page.locator(".office-editor").evaluate((element) =>
      Reflect.get(element, "__marginOfficeDiagnostics")?.() ?? {},
    );
    invariant(
      await page.locator(".doc-dirty").count() === 0,
      `accepted Agent proposal left the document marked unsaved: ${JSON.stringify(dirtyDiagnostics)}`,
    );
    const replayedResolve = await apiJson(baseUrl, token, `/api/v1/proposals/${translationProposal.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({
        kind: "Y",
        documentId: chat.opened.document.id,
        expectedRevision: chat.opened.document.revision,
        expectedHash: chat.opened.document.contentHash,
      }),
    });
    invariant(replayedResolve.ok && replayedResolve.replayed, "proposal resolve is not idempotent after a lost response");
    const blocksAfterAccept = await apiJson(baseUrl, token, `/api/v1/documents/${chat.opened.document.id}/blocks`);
    const acceptedBlock = blocksAfterAccept.blocks.find((block) => block.id === translationBlock.id);
    const selectionStart = translationBlock.text.indexOf(translationSelection);
    invariant(selectionStart >= 0 && translationBlock.text.indexOf(translationSelection, selectionStart + translationSelection.length) < 0, "translation sample was not unique inside its block");
    const acceptedExpected = `${translationBlock.text.slice(0, selectionStart)}${reviewedReplacement}${translationBlock.text.slice(selectionStart + translationSelection.length)}`;
    invariant(acceptedBlock?.text === acceptedExpected, "Accept changed text outside the selected span");
    console.log("OFFICE_GATE_STAGE anchored-thread-discussion");
    const discussionRange = await page.locator(".office-editor").evaluate((element, selection) => {
      return Reflect.get(element, "__marginOfficeTestSelect")?.(selection, 0) ?? null;
    }, formattingSelection);
    invariant(discussionRange, "could not reselect text for discussion thread");
    await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".sel-bubble button").filter({ hasText: "讨论" }).click();
    await page.locator(".thread-popover").waitFor({ state: "visible", timeout: 10_000 });
    const threadComposer = page.locator(".thread-popover .thread-composer textarea");
    invariant(
      await threadComposer.evaluate((element) => document.activeElement === element),
      "thread composer was not focused when the discussion thread opened",
    );
    await threadComposer.fill("这段的论证风险是什么？");
    await page.locator(".thread-popover .thread-send").click();
    await page.locator('.thread-popover .thread-message[data-role="user"]').filter({ hasText: "论证风险" })
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForFunction(() => {
      const composer = document.querySelector(".thread-popover .thread-composer textarea");
      const replies = [...document.querySelectorAll('.thread-popover .thread-message[data-role="assistant"]')];
      const reply = replies.at(-1);
      return Boolean(
        composer && !composer.disabled && reply?.textContent &&
          reply.textContent.trim().length > 2 && reply.textContent.trim() !== "…",
      );
    }, undefined, { timeout: 30_000 });
    await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
    await page.locator(".thread-popover").waitFor({ state: "detached", timeout: 5_000 });
    const railDots = page.locator(".anchor-rail .anchor-dot");
    invariant(await railDots.count() >= 2, "collapsed threads did not leave margin anchors");
    await railDots.last().click();
    await page.locator(".thread-popover").waitFor({ state: "visible", timeout: 5_000 });
    await page.locator('.thread-popover .thread-message[data-role="user"]').filter({ hasText: "论证风险" })
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
    await page.locator(".thread-popover").waitFor({ state: "detached", timeout: 5_000 });
    if (await page.locator(".sidecar-launcher").count() === 0) {
      await page.getByTitle("专注文稿").click();
    }
    await page.locator(".sidecar-launcher").waitFor({ state: "visible", timeout: 5_000 });
    await waitForVisualStability(page, ".office-workspace");
    const desktop = path.join(artifactDir, "office-desktop.png");
    await page.screenshot({ path: desktop, fullPage: true });
    const tablePage = await findTablePage(page);
    invariant(tablePage.page >= 0 && tablePage.lines >= 2, `table grid was not rendered: ${JSON.stringify(tablePage)}`);
    await page.locator(`.office-editor canvas[data-index="${tablePage.page}"]`).scrollIntoViewIfNeeded();
    await waitForVisualStability(page, ".office-workspace");
    const tableScreenshot = path.join(artifactDir, "office-table.png");
    await page.screenshot({ path: tableScreenshot, fullPage: true });

    const marker = `MarginNativeEdit${Date.now()}`;
    const formattingOccurrence = chat.opened.blocks
      .filter((block) => block.order < formattingBlock.order)
      .reduce((count, block) => count + (block.text.includes(formattingSelection) ? 1 : 0), 0);
    const cursorRange = await page.locator(".office-editor").evaluate((element, target) => {
      return Reflect.get(element, "__marginOfficeTestCursorAfter")?.(target.query, target.occurrence) ?? null;
    }, { query: formattingSelection, occurrence: formattingOccurrence });
    invariant(cursorRange, "could not place a model cursor in an unprotected body paragraph");
    const input = page.locator(".office-editor .ce-inputarea");
    await input.focus();
    invariant(await input.evaluate((element) => document.activeElement === element), "editor input proxy did not receive focus");
    await page.keyboard.type(marker, { delay: 5 });
    await page.waitForTimeout(250);
    let inputFallback = false;
    let markerRange = await page.locator(".office-editor").evaluate((element, selection) => {
      return Reflect.get(element, "__marginOfficeTestSelect")?.(selection, 0) ?? null;
    }, marker);
    if (!markerRange) {
      inputFallback = true;
      await input.evaluate((element, text) => {
        element.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          data: text,
          inputType: "insertText",
        }));
      }, marker);
      markerRange = await page.locator(".office-editor").evaluate((element, selection) => {
        return Reflect.get(element, "__marginOfficeTestSelect")?.(selection, 0) ?? null;
      }, marker);
    }
    invariant(markerRange, "could not reselect typed text for formatting");
    await page.getByTitle("加粗").click();
    await page.waitForFunction(() => {
      const button = document.querySelector(".office-save");
      return button && !button.disabled && button.textContent?.includes("保存");
    }, undefined, { timeout: 10_000 });
    let rebuildDialogSeen = false;
    let rebuildDialogMessage = "";
    let resolveRebuild;
    const rebuildRequested = new Promise((resolve) => { resolveRebuild = resolve; });
    const rejectUnexpectedRebuild = async (dialog) => {
      rebuildDialogSeen = true;
      rebuildDialogMessage = dialog.message();
      resolveRebuild("rebuild");
      await dialog.dismiss();
    };
    page.once("dialog", rejectUnexpectedRebuild);
    await page.locator(".office-save").click();
    const savedOrRebuild = await Promise.race([
      page.waitForFunction(() => document.querySelector(".office-save")?.textContent?.includes("已保存"), undefined, { timeout: 30_000 })
        .then(() => "saved"),
      rebuildRequested,
    ]);
    if (savedOrRebuild === "rebuild") {
      const diagnostics = await page.locator(".office-editor").evaluate((element) =>
        Reflect.get(element, "__marginOfficeDiagnostics")?.() ?? {},
      );
      throw new Error(`text + formatting requested rebuild (${rebuildDialogMessage}): ${JSON.stringify({ formattingBlockId: formattingBlock.id, formattingSelection, diagnostics })}`);
    }
    page.off("dialog", rejectUnexpectedRebuild);
    invariant(!rebuildDialogSeen, "plain text save unexpectedly requested a DOCX rebuild");
    const saveDiagnostics = await page.locator(".office-editor").evaluate((element) => {
      return Reflect.get(element, "__marginOfficeDiagnostics")?.() ?? {};
    });
    invariant(saveDiagnostics.lastSaveMode === "ooxml_patch", `text + formatting save rebuilt DOCX instead of patching OOXML: ${JSON.stringify(saveDiagnostics)}`);

    const blocksAfterSave = await apiJson(
      baseUrl,
      token,
      `/api/v1/documents/${chat.opened.document.id}/blocks`,
    );
    invariant(blocksAfterSave.blocks.some((block) => block.text.includes(marker)), "typed text was not saved into DOCX OOXML");
    const savedTable = blocksAfterSave.blocks.find((block) => block.kind === "table");
    invariant(savedTable, "table disappeared after direct human save");
    const savedShape = tableShape(savedTable.text);
    invariant(savedShape.rows === 31, `save changed table row count to ${savedShape.rows}`);
    invariant(savedShape.columns === 5, `save changed table column count to ${savedShape.columns}`);
    invariant(!blocksAfterSave.blocks.some((block) => block.text.includes("\uFFFD")), "save introduced replacement characters");

    const currentDocument = await apiJson(baseUrl, token, `/api/v1/documents/${chat.opened.document.id}`);
    const firstTableCell = savedTable.text.split("\n")[0]?.split("\t")[0] ?? "";
    invariant(firstTableCell, "could not derive a stable table cell for review");
    console.log("OFFICE_GATE_STAGE table-cell-proposal");
    const cellRun = await apiJson(baseUrl, token, `/api/v1/documents/${chat.opened.document.id}/proposal-runs`, {
      method: "POST",
      body: JSON.stringify({
        blockIds: [savedTable.id],
        instruction: "Polish this cell without adding facts.",
        operation: "polish",
        selectionText: firstTableCell,
        selectionStart: 0,
        tableCell: { row: 1, column: 1, address: "A1", before: firstTableCell },
        preferSimple: true,
      }),
    });
    let cellRunState;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      cellRunState = await apiJson(baseUrl, token, `/api/v1/proposal-runs/${cellRun.runId}`);
      if (cellRunState.status === "done") break;
      if (cellRunState.status === "error") throw new Error(cellRunState.error || "table cell proposal failed");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    invariant(cellRunState?.status === "done" && cellRunState.proposalIds?.length === 1, "table cell proposal did not finish");
    console.log("OFFICE_GATE_STAGE table-cell-review");
    const cellProposals = await apiJson(baseUrl, token, `/api/v1/documents/${chat.opened.document.id}/proposals?status=proposed`);
    const cellProposal = cellProposals.proposals.find((proposal) => proposal.id === cellRunState.proposalIds[0]);
    invariant(cellProposal?.tableCell?.address === "A1", "table cell proposal lost its exact address");
    invariant(cellProposal.before === firstTableCell, "table cell proposal changed the source before review");
    const editedCell = `${firstTableCell} [E]`;
    const cellResolve = await apiJson(baseUrl, token, `/api/v1/proposals/${cellProposal.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({
        kind: "E",
        editedText: editedCell,
        documentId: chat.opened.document.id,
        expectedRevision: currentDocument.document.revision,
        expectedHash: currentDocument.document.contentHash,
      }),
    });
    invariant(cellResolve.ok, "table cell E decision did not apply");
    const blocksAfterCellEdit = await apiJson(baseUrl, token, `/api/v1/documents/${chat.opened.document.id}/blocks`);
    const tableAfterCellEdit = blocksAfterCellEdit.blocks.find((block) => block.kind === "table");
    invariant(tableAfterCellEdit?.text.split("\n")[0]?.split("\t")[0] === editedCell, "table cell E decision changed the wrong value");
    invariant(tableShape(tableAfterCellEdit.text).rows === 31 && tableShape(tableAfterCellEdit.text).columns === 5, "table cell proposal changed table topology");
    const workingDocx = path.join(workspace, chat.opened.document.relativePath);
    const savedProtectedShape = await docxProtectedShape(workingDocx);
    invariant(
      JSON.stringify(savedProtectedShape) === JSON.stringify(originalProtectedShape),
      `protected OOXML shape changed: ${JSON.stringify({ originalProtectedShape, savedProtectedShape })}`,
    );
    console.log("OFFICE_GATE_STAGE reload");

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForOffice(page);
    await closeSettings(page);
    invariant((await canvasInk(page)).ink > 150, "reloaded Office canvas is blank");
    await page.locator(".sidecar-launcher").waitFor({ state: "visible", timeout: 5_000 });
    invariant(pageErrors.length === 0, `browser errors: ${pageErrors.join(" | ")}`);

    console.log(`OFFICE_NATIVE_GATE_OK ${JSON.stringify({
      source: sourceDocx,
      table: savedShape,
      blocks: blocksAfterSave.blocks.length,
      pages: ink.canvases,
      ink: ink.ink,
      tablePage,
      inputFallback,
      tableCell: { address: "A1", decision: "E", value: editedCell },
      protectedShape: savedProtectedShape,
      desktop,
      extensionsScreenshot,
      settingsScreenshot,
      tableScreenshot,
    })}`);
  } finally {
    await Promise.race([
      browser?.close().catch(() => undefined) ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await stopCli(server.child);
    if (!keepArtifacts && workspace.startsWith(`${repoRoot}${path.sep}.tmp-office-e2e-`)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
