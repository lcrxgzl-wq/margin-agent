import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  collectCliOutput,
  createGateWorkspace,
  freePort,
  removeGateWorkspace,
  stopChild,
  waitForCliUrl,
} from "./gate-runtime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceArgument = process.argv.slice(2).find((argument) => argument !== "--");
const sourceInput = sourceArgument ?? process.env.MARGIN_OFFICE_DOCX;
const sourceDocx = sourceInput ? path.resolve(sourceInput) : undefined;
const edgePath = process.env.MARGIN_EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const keepArtifacts = process.env.MARGIN_KEEP_THREAD_E2E === "1";

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function startCli(workspace, port) {
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
  return { child, output: collectCliOutput(child) };
}

async function stopCli(child) {
  await stopChild(child);
  if (child.exitCode == null && child.signalCode == null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  invariant(
    child.exitCode != null || child.signalCode != null,
    "CLI process did not exit during restart",
  );
  // child.kill("SIGTERM") force-terminates on Windows, so proper-lockfile's
  // shutdown hook cannot run. Wait for the configured 5s stale window.
  await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 5_250 : 250));
}

function apiFor(url) {
  const parsed = new URL(url);
  const token = parsed.hash.replace(/^#token=/, "");
  const request = async (route, init = {}) => {
    const response = await fetch(`${parsed.origin}${route}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${route} ${response.status}: ${JSON.stringify(data)}`);
    return data;
  };
  return { request, token };
}

async function waitFor(check, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForOffice(page) {
  await page.locator(".office-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".office-loading").waitFor({ state: "detached", timeout: 30_000 });
  await page.waitForTimeout(500);
}

async function selectOfficeText(page, selection) {
  const range = await page.locator(".office-editor").evaluate((element, query) =>
    Reflect.get(element, "__marginOfficeTestSelect")?.(query, 0) ?? null, selection);
  invariant(range, "could not select the restart-gate text in the Office canvas");
}

async function main() {
  invariant(
    sourceDocx && fs.existsSync(sourceDocx) && fs.statSync(sourceDocx).isFile(),
    `DOCX fixture not found: ${sourceDocx ?? "pass a DOCX path or set MARGIN_OFFICE_DOCX"}`,
  );
  invariant(fs.existsSync(edgePath), `Edge executable not found: ${edgePath}`);
  const { workspace, runtimeRoot } = createGateWorkspace(repoRoot, "margin-thread-restart-");
  const copiedDocx = path.join(workspace, path.basename(sourceDocx));

  let browser;
  let server;
  const pageErrors = [];
  try {
    fs.copyFileSync(sourceDocx, copiedDocx);
    server = startCli(workspace, await freePort());
    const firstUrl = await waitForCliUrl(server.child, server.output);
    const firstApi = apiFor(firstUrl);
    const opened = await firstApi.request("/api/v1/chat", {
      method: "POST",
      body: JSON.stringify({ message: `"${copiedDocx}"` }),
    });
    invariant(opened.opened?.document, "first CLI did not open the DOCX");
    const block = opened.opened.blocks.find((candidate) =>
      candidate.kind !== "table" && /[A-Za-z]{4}/.test(candidate.text) && candidate.text.length > 32,
    );
    invariant(block, "DOCX has no stable body block for a review thread");
    const selection = /[A-Za-z][A-Za-z\s,.'()\-]{24,72}/.exec(block.text)?.[0]?.trim();
    invariant(selection, "DOCX has no stable English selection for a review thread");

    browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const firstPage = await context.newPage();
    firstPage.on("pageerror", (error) => pageErrors.push(error.message));
    await firstPage.goto(firstUrl, { waitUntil: "domcontentloaded" });
    await waitForOffice(firstPage);
    await selectOfficeText(firstPage, selection);
    await firstPage.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
    await firstPage.locator(".sel-bubble button").filter({ hasText: "讨论" }).click();

    const question = "这段的论证风险是什么？";
    const composer = firstPage.locator(".thread-popover .thread-composer textarea");
    await composer.fill(question);
    await firstPage.locator(".thread-popover .thread-send").click();
    await firstPage.waitForFunction(() => {
      const input = document.querySelector(".thread-popover .thread-composer textarea");
      const reply = [...document.querySelectorAll('.thread-popover .thread-message[data-role="assistant"]')].at(-1);
      return Boolean(input && !input.disabled && reply?.textContent?.trim());
    }, undefined, { timeout: 30_000 });
    const firstAnswer = (await firstPage
      .locator('.thread-popover .thread-message[data-role="assistant"]')
      .last().textContent())?.trim();
    invariant(firstAnswer, "thread discussion did not produce an answer");

    await composer.fill("译成英文");
    await firstPage.locator(".thread-popover .thread-send").click();
    await firstPage.locator(".thread-popover .review-fragment.before del")
      .waitFor({ state: "visible", timeout: 60_000 });
    await firstPage.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
    await firstPage.locator(".thread-popover").waitFor({ state: "detached", timeout: 5_000 });

    const persisted = await waitFor(async () => {
      const session = await firstApi.request("/api/v1/session");
      const thread = session.review?.threads?.find((candidate) =>
        candidate.anchor?.selectionText === selection,
      );
      const turns = session.chat?.turns ?? [];
      return thread &&
          turns.some((turn) => turn.threadId === thread.id && turn.role === "user" && turn.text === question) &&
          turns.some((turn) => turn.threadId === thread.id && turn.role === "assistant")
        ? { session, thread }
        : null;
    }, "thread did not reach the persisted session envelope");
    const pendingBeforeRestart = await firstApi.request(
      `/api/v1/documents/${opened.opened.document.id}/proposals?status=proposed`,
    );
    invariant(pendingBeforeRestart.proposals?.length === 1, "pending proposal was not stored before restart");

    await firstPage.close();
    await stopCli(server.child);
    server = undefined;

    server = startCli(workspace, await freePort());
    const secondUrl = await waitForCliUrl(server.child, server.output);
    const secondApi = apiFor(secondUrl);
    invariant(firstApi.token !== secondApi.token, "CLI restart reused the previous auth token");
    const restoredSession = await secondApi.request("/api/v1/session");
    invariant(restoredSession.opened?.document?.id === opened.opened.document.id, "restart lost the open document");
    invariant(
      restoredSession.review?.threads?.some((thread) => thread.id === persisted.thread.id),
      "restart lost the review thread",
    );

    const secondPage = await context.newPage();
    secondPage.on("pageerror", (error) => pageErrors.push(error.message));
    await secondPage.goto(secondUrl, { waitUntil: "domcontentloaded" });
    await waitForOffice(secondPage);
    const dockButton = secondPage.getByTitle("停靠侧栏");
    if (await dockButton.count()) await dockButton.click();
    await secondPage.getByRole("tab", { name: /审阅/ }).click();
    const inboxThread = secondPage.locator(".review-thread-item").filter({ hasText: selection.slice(0, 18) });
    await inboxThread.waitFor({ state: "visible", timeout: 10_000 });
    await inboxThread.click();
    await secondPage.locator(".thread-popover").waitFor({ state: "visible", timeout: 10_000 });
    const restoredCanvasState = await secondPage.locator(".office-editor").evaluate((element) =>
      Reflect.get(element, "__marginOfficeDiagnostics")?.() ?? null);
    invariant(
      restoredCanvasState && restoredCanvasState.dirty === false,
      `restoring pending marks dirtied the canvas: ${JSON.stringify(restoredCanvasState)}`,
    );

    invariant(
      await secondPage.locator('.thread-popover .thread-message[data-role="user"]', { hasText: question }).count() === 1,
      "restored thread did not contain the original question exactly once",
    );
    invariant(
      await secondPage.locator('.thread-popover .thread-message[data-role="assistant"]', { hasText: firstAnswer }).count() === 1,
      "restored thread did not contain the original answer exactly once",
    );
    invariant(
      await secondPage.locator(".chat-activity .turn", { hasText: question }).count() === 0,
      "restored thread messages leaked into global chat",
    );
    await secondPage.locator(".thread-popover .review-fragment.before del")
      .waitFor({ state: "visible", timeout: 10_000 });

    const continuedQuestion = "请再具体说明一句";
    const restoredComposer = secondPage.locator(".thread-popover .thread-composer textarea");
    const assistantCount = await secondPage.locator('.thread-popover .thread-message[data-role="assistant"]').count();
    await restoredComposer.fill(continuedQuestion);
    const restoredSend = secondPage.locator(".thread-popover .thread-send");
    invariant(!(await restoredSend.isDisabled()), "restored thread send button stayed disabled after input");
    const preSendCanvasState = await secondPage.locator(".office-editor").evaluate((element) =>
      Reflect.get(element, "__marginOfficeDiagnostics")?.() ?? null);
    invariant(
      preSendCanvasState && preSendCanvasState.dirty === false,
      `restored canvas became dirty before thread send: ${JSON.stringify(preSendCanvasState)}`,
    );
    const dialogs = [];
    const onDialog = async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    };
    secondPage.on("dialog", onDialog);
    await restoredSend.click();
    try {
      await secondPage.locator('.thread-popover .thread-message[data-role="user"]', { hasText: continuedQuestion })
        .waitFor({ state: "visible", timeout: 5_000 });
      await secondPage.waitForFunction((count) => {
        const input = document.querySelector(".thread-popover .thread-composer textarea");
        return Boolean(input && !input.disabled &&
          document.querySelectorAll('.thread-popover .thread-message[data-role="assistant"]').length > count);
      }, assistantCount, { timeout: 30_000 });
    } catch (error) {
      const popoverPresent = await secondPage.locator(".thread-popover").count() > 0;
      const diagnostics = {
        popoverPresent,
        composerDisabled: popoverPresent ? await restoredComposer.isDisabled() : null,
        threadText: await secondPage.locator(".thread-popover").textContent().catch(() => null),
        globalLast: await secondPage.locator(".chat-activity .bubble.assistant").last().textContent().catch(() => null),
        railDots: await secondPage.locator(".anchor-rail .anchor-dot").count(),
        inboxThreads: await secondPage.locator(".review-thread-item").count(),
        dialogs,
        canvas: await secondPage.locator(".office-editor").evaluate((element) =>
          Reflect.get(element, "__marginOfficeDiagnostics")?.() ?? null).catch(() => null),
        cli: server.output(),
      };
      throw new Error(`continued thread reply timed out: ${JSON.stringify(diagnostics)}`, { cause: error });
    } finally {
      secondPage.off("dialog", onDialog);
    }

    await secondPage.locator(".thread-popover .review-actions button").filter({ hasText: "N 拒绝" }).click();
    await secondPage.locator(".thread-popover").waitFor({ state: "detached", timeout: 30_000 });
    await waitFor(async () => {
      const pending = await secondApi.request(
        `/api/v1/documents/${opened.opened.document.id}/proposals?status=proposed`,
      );
      return pending.proposals?.length === 0;
    }, "restored proposal could not be reviewed after restart");
    const finalSession = await secondApi.request("/api/v1/session");
    invariant(
      finalSession.chat?.turns?.some((turn) =>
        turn.threadId === persisted.thread.id && turn.role === "user" && turn.text === continuedQuestion),
      "continued discussion was not persisted against the restored thread",
    );
    invariant(pageErrors.length === 0, `browser errors: ${pageErrors.join(" | ")}`);

    console.log(`THREAD_RESTART_GATE_OK ${JSON.stringify({
      documentId: opened.opened.document.id,
      threadId: persisted.thread.id,
      question,
      continued: true,
      decision: "N",
    })}`);
  } finally {
    await browser?.close().catch(() => undefined);
    if (server) await stopCli(server.child).catch(() => undefined);
    if (!keepArtifacts) removeGateWorkspace(workspace, runtimeRoot);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
