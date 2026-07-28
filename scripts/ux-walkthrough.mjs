// User-perspective E2E walkthrough: open app -> open docx -> selection rewrite
// -> cross-paragraph rewrite -> review -> commands -> theme/layout -> mobile.
// Usage: node scripts/ux-walkthrough.mjs "E:\path\to\file.docx"
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// jszip 只在 workspace 包（apps/cli）里声明，这里借它的解析路径加载来解 docx。
const requireFromCli = createRequire(path.join(repoRoot, "apps", "cli", "package.json"));
const JSZip = requireFromCli("jszip");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sourceDocx = process.argv[2];
if (!sourceDocx || !fs.existsSync(sourceDocx)) {
  console.error("usage: node scripts/ux-walkthrough.mjs <docx>");
  process.exit(2);
}
const outDir = path.join(repoRoot, ".tmp-visual", "ux");
fs.mkdirSync(outDir, { recursive: true });

const notes = [];
const note = (text) => {
  notes.push(text);
  console.log(`  [note] ${text}`);
};
const step = (text) => console.log(`\n== ${text}`);

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// docx（zip）里 word/document.xml 的删除线 run 数量——修订标记泄漏检测用。
async function countStrikeRuns(docxBuffer) {
  const zip = await JSZip.loadAsync(Buffer.from(docxBuffer));
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("docx 缺少 word/document.xml");
  const xml = await file.async("string");
  return (xml.match(/<w:strike[\s/>]/g) ?? []).length;
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

const port = await freePort();
// Clean up workspaces left behind by previous runs of this script.
for (const entry of fs.readdirSync(repoRoot)) {
  if (entry.startsWith(".tmp-ux-ws-")) {
    fs.rmSync(path.join(repoRoot, entry), { recursive: true, force: true });
  }
}
const workspace = fs.mkdtempSync(path.join(repoRoot, ".tmp-ux-ws-"));
fs.copyFileSync(sourceDocx, path.join(workspace, path.basename(sourceDocx)));
// Fixture source file so the SourcePicker has something to attach (mixed attention step).
const fixtureSource = path.join(repoRoot, "fixtures", "agent-chapter.md");
if (fs.existsSync(fixtureSource)) {
  fs.copyFileSync(fixtureSource, path.join(workspace, "agent-chapter.md"));
}
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
  const api = async (route, init = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    return response.json();
  };

  browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(30_000);

  step("1. Landing");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".landing-stage").waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "01-landing.png") });

  step("2. Open document via composer command");
  const composer = page.locator(".composer-card textarea").first();
  await composer.fill(`"${path.join(workspace, path.basename(sourceDocx))}"`);
  await page.keyboard.press("Enter");
  await page.locator(".office-workspace").waitFor({ state: "visible", timeout: 45_000 });
  await page.locator(".office-loading").waitFor({ state: "detached", timeout: 45_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(outDir, "02-doc-open.png") });
  const strip = await page.locator(".attention-strip").textContent().catch(() => "");
  if (!strip?.includes("全文")) {
    throw new Error(`global 态注意力条缺“全文” chip: ${strip}`);
  }
  if (strip?.includes("选区：")) {
    throw new Error(`global 态注意力条仍渲染“选区：”文本（Task 4 回归）: ${strip}`);
  }

  const session = await api("/api/v1/session");
  const blocks = session.opened.blocks;
  const paragraphs = blocks.filter((b) => b.kind !== "table" && b.text.trim().length > 40);
  if (paragraphs.length < 2) throw new Error("not enough paragraphs for walkthrough");

  const selectText = (query) => page.locator(".office-editor").evaluate(
    (element, target) => Reflect.get(element, "__marginOfficeTestSelect")?.(target, 0) ?? null,
    query,
  );
  const selectRange = (start, end) => page.locator(".office-editor").evaluate(
    (element, args) => Reflect.get(element, "__marginOfficeTestRange")?.(args[0], args[1]) ?? null,
    [start, end],
  );
  // Programmatic range selection does not scroll the canvas; bring the active
  // range into the viewport so the selection bubble becomes clickable/visible.
  const scrollSelectionIntoView = () => page.locator(".office-editor").evaluate((host) => {
    const diag = Reflect.get(host, "__marginOfficeDiagnostics")?.();
    const rects = diag?.context?.rangeRects;
    const rect = rects?.[rects.length - 1];
    const scroll = document.querySelector(".office-canvas-scroll");
    if (!rect || !scroll) return;
    const hostRect = host.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const absolute = scroll.scrollTop + (hostRect.top - scrollRect.top) + rect.y;
    scroll.scrollTop = Math.max(0, absolute - scroll.clientHeight / 2);
  });
  const listProposed = async () =>
    (await api(`/api/v1/documents/${session.opened.document.id}/proposals?status=proposed`)).proposals;
  const proposalCount = async () => (await listProposed()).length;
  const keywordOf = (text) => {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.slice(Math.min(8, Math.floor(compact.length / 4)), Math.min(8, Math.floor(compact.length / 4)) + 12);
  };
  // Injects a canned markdown table turn into the chat for visual verification.
  const injectMdDemo = () => page.locator(".messages").evaluate((container) => {
    const turn = document.createElement("div");
    turn.className = "turn assistant ux-md-demo";
    turn.innerHTML = `<div class="turn-meta">Margin</div><div class="bubble assistant"><div class="md">` +
      `<h4>初稿完成度评估：约 <strong>30–35%</strong></h4>` +
      `<div class="md-table-wrap"><table><thead><tr><th>部分</th><th>状态</th></tr></thead>` +
      `<tbody><tr><td><strong>标题</strong></td><td>好，问题意识明确</td></tr>` +
      `<tr><td><strong>摘要</strong></td><td>只有标题，无内容</td></tr>` +
      `<tr><td><strong>结果</strong></td><td>完全空白</td></tr></tbody></table></div>` +
      `<ul><li>补摘要（一句话定全篇）</li><li>写假设（3–4 条可检验命题）</li></ul>` +
      `</div></div>`;
    container.appendChild(turn);
    turn.scrollIntoView({ block: "center" });
  });
  const removeMdDemo = () => page.locator(".ux-md-demo").evaluate((node) => node.remove());
  // 修订标记只读探针（OfficeCanvas 的 __marginOfficeGetMarks 测试钩子）。
  const officeState = () => page.locator(".office-editor").evaluate(
    (element) => Reflect.get(element, "__marginOfficeGetMarks")?.() ?? null,
  );
  const waitMarks = (present) => page.waitForFunction((want) => {
    const host = document.querySelector(".office-editor");
    const state = host ? Reflect.get(host, "__marginOfficeGetMarks")?.() : null;
    return state ? (want ? state.marks.length > 0 : state.marks.length === 0) : false;
  }, present, { timeout: 15_000 });
  const waitCanvasReady = () => page.waitForFunction(() => {
    const host = document.querySelector(".office-editor");
    const diag = host ? Reflect.get(host, "__marginOfficeDiagnostics")?.() : null;
    return Boolean(diag?.initialized) && !document.querySelector(".office-loading");
  }, null, { timeout: 45_000 });
  const nativeDocxBuffer = async () => {
    const response = await fetch(`${baseUrl}/api/v1/documents/${session.opened.document.id}/native-docx`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`native-docx 拉取失败: ${response.status}`);
    return response.arrayBuffer();
  };
  const assertMdTableFits = async () => {
    const demoTable = page.locator(".ux-md-demo table");
    if (!(await demoTable.isVisible())) throw new Error("markdown table is not visible in chat");
    const tableBox = await demoTable.boundingBox();
    const bubbleBox = await page.locator(".ux-md-demo .bubble").boundingBox();
    if (!tableBox || !bubbleBox || tableBox.width > bubbleBox.width + 2) {
      note("md 表格宽度超过气泡宽度，存在横向溢出");
    }
  };

  step("3. Single-paragraph selection -> bubble -> rewrite -> proposal");
  const first = paragraphs[0];
  const rangeA = await selectText(keywordOf(first.text));
  if (!rangeA) throw new Error("test hook could not select first paragraph text");
  await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
  if (await page.locator(".sel-bubble .selection-limit").count()) {
    throw new Error("single-paragraph selection is still flagged as unsafe to edit");
  }
  const stripWithSelection = await page.locator(".attention-strip").textContent();
  if (!stripWithSelection?.includes("选区")) note("选中文字后注意力条未显示“选区” chip");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "03-selection-bubble.png") });
  await page.locator(".sel-bubble button", { hasText: "改写" }).first().click();
  await page.locator(".thread-popover").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(async () => true);
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    if ((await proposalCount()) > 0) break;
    await page.waitForTimeout(500);
  }
  if ((await proposalCount()) !== 1) throw new Error(`expected 1 proposal, got ${await proposalCount()}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "04-proposal-thread.png") });

  step("3b. Revision marks on canvas (pending proposal)");
  const firstProposal = (await listProposed())[0];
  await waitMarks(true);
  const pendingMarks = (await officeState()).marks
    .filter((mark) => mark.proposalId === firstProposal.id);
  if (!pendingMarks.length) throw new Error("提案 pending 后画布上未出现该提案的 marginMark 修订标记");
  const hasStrike = pendingMarks.some((mark) => mark.strikeout);
  const hasUnderline = pendingMarks.some((mark) => mark.underline);
  if (!hasStrike && !hasUnderline) throw new Error("marginMark 缺少 strikeout/underline 修订样式");
  if (!hasStrike || !hasUnderline) {
    note(`修订标记只有${hasStrike ? "删除线" : "下划线"}一种样式（纯插入/纯删除提案，可接受）`);
  }
  // 关掉 popover 再截图，标记不被遮挡；接受改走审阅 tab。
  if (await page.locator(".thread-backdrop").count()) {
    await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: path.join(outDir, "17-revision-marks.png") });

  step("4. Accept proposal");
  const revisionBefore = (await api("/api/v1/session")).opened.document.revision;
  await page.getByRole("tab", { name: /审阅/ }).click();
  await page.waitForTimeout(400);
  await page.locator(".review-panel button", { hasText: "Y 接受" }).first().click();
  await page.getByRole("tab", { name: /对话/ }).click();
  await page.waitForTimeout(1500);
  const revisionAfter = (await api("/api/v1/session")).opened.document.revision;
  if (revisionAfter <= revisionBefore) throw new Error("accept did not bump document revision");
  if ((await proposalCount()) !== 0) note("接受后仍有残留提案未清理");
  await waitCanvasReady();
  const acceptedState = await officeState();
  if (acceptedState.marks.length) throw new Error("接受后画布仍残留 marginMark 修订标记");
  const compactAcceptedText = acceptedState.text.replace(/\s+/g, "");
  if (!compactAcceptedText.includes(firstProposal.after.replace(/\s+/g, "").slice(0, 30))) {
    throw new Error("接受后正文未更新为提案 after 文本");
  }
  await page.screenshot({ path: path.join(outDir, "05-accepted.png") });

  step("4b. Save fallback strips marks; N 拒绝 restores text");
  const secondParas = (await api("/api/v1/session")).opened.blocks
    .filter((b) => b.kind !== "table" && b.text.trim().length > 40);
  const secondBlock = secondParas[1] ?? secondParas[0];
  if (!secondBlock) {
    note("无第二段可用，跳过保存兜底/N 拒绝场景");
  } else {
    if (!(await selectText(keywordOf(secondBlock.text)))) throw new Error("4b 无法选中第二段文本");
    await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".sel-bubble button", { hasText: "改写" }).first().click();
    await page.locator(".thread-popover").waitFor({ state: "visible", timeout: 15_000 });
    const t4b = Date.now();
    while (Date.now() - t4b < 60_000) {
      if ((await proposalCount()) > 0) break;
      await page.waitForTimeout(500);
    }
    if ((await proposalCount()) !== 1) throw new Error(`4b expected 1 proposal, got ${await proposalCount()}`);
    const secondProposal = (await listProposed())[0];
    await waitMarks(true);
    if (!(await officeState()).marks.some((mark) => mark.proposalId === secondProposal.id)) {
      throw new Error("4b 第二条提案未注入修订标记");
    }

    // 保存兜底：标记 pending 时做一次真实正文编辑使画布 dirty，再走完整保存链路。
    const strikeBaseline = await countStrikeRuns(await nativeDocxBuffer());
    if (await page.locator(".thread-backdrop").count()) {
      await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
      await page.waitForTimeout(300);
    }
    // 光标放到另一段末尾输入，避免触发标记篡改检测。
    const editTarget = secondParas.find((b) => b.id !== secondBlock.id) ?? secondParas[0];
    const cursor = await page.locator(".office-editor").evaluate(
      (element, target) => Reflect.get(element, "__marginOfficeTestCursorAfter")?.(target, 0) ?? null,
      keywordOf(editTarget.text),
    );
    if (!cursor) throw new Error("4b 无法定位保存兜底的输入光标");
    const marker = "走查保存兜底";
    const input = page.locator(".office-editor .ce-inputarea");
    await input.focus();
    await page.keyboard.type(marker, { delay: 5 });
    await page.waitForTimeout(300);
    if (!(await officeState()).text.includes(marker)) {
      await input.evaluate((element, text) => {
        element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      }, marker);
      await page.waitForTimeout(300);
    }
    if (!(await officeState()).text.includes(marker)) {
      throw new Error("4b 未能向画布输入文本（无法触发 dirty）");
    }
    await page.waitForFunction(() => {
      const button = document.querySelector(".office-save");
      return button && !button.disabled && button.textContent?.includes("保存");
    }, null, { timeout: 10_000 });
    // 保存前确认（Task 2/5）：第一次点击先取消——断言确认对话出现且文案含
    // "待审提案"，取消后标记仍在、提案仍 pending、文档未保存（零副作用）。
    const cancelledDialogs = [];
    const onCancelDialog = async (dialog) => {
      cancelledDialogs.push(dialog.message());
      await dialog.dismiss();
    };
    page.on("dialog", onCancelDialog);
    await page.locator(".office-save").click();
    await page.waitForTimeout(1000);
    page.off("dialog", onCancelDialog);
    if (!cancelledDialogs.length) throw new Error("pending 提案时保存未弹出保存前确认对话");
    if (!cancelledDialogs.some((message) => message.includes("待审提案"))) {
      throw new Error(`保存前确认文案缺少"待审提案": ${cancelledDialogs[0]?.slice(0, 80)}`);
    }
    if (!(await officeState()).marks.some((mark) => mark.proposalId === secondProposal.id)) {
      throw new Error("取消保存后修订标记丢失（应保持原样）");
    }
    if ((await proposalCount()) !== 1) throw new Error("取消保存后 pending 提案数发生变化");
    if ((await page.locator(".office-save").textContent())?.includes("已保存")) {
      throw new Error("取消保存后文档仍被保存");
    }
    await page.screenshot({ path: path.join(outDir, "19-save-confirm.png") });
    // 第二次点击确认保存——走原有 supersede/还原→导出→重注入链路。
    const onSaveDialog = async (dialog) => {
      note(`保存确认对话：${dialog.message().split("\n")[0]}`);
      await dialog.accept();
    };
    page.on("dialog", onSaveDialog);
    await page.locator(".office-save").click();
    await page.waitForFunction(
      () => document.querySelector(".office-save")?.textContent?.includes("已保存"),
      null,
      { timeout: 30_000 },
    );
    page.off("dialog", onSaveDialog);
    // 手动保存会把 pending 提案置为 superseded（finalizeNativeSaveJournal），
    // 客户端 onDocumentSaved 重新拉取后标记不再重注入——断言标记消失、提案清空。
    await waitMarks(false);
    await page.waitForTimeout(800);
    if ((await proposalCount()) !== 0) {
      note("保存后仍有 pending 提案（预期被 supersede）");
    }
    // 导出的 docx 不得多出删除线 run（保存兜底核心断言）。
    const strikeAfterSave = await countStrikeRuns(await nativeDocxBuffer());
    if (strikeAfterSave !== strikeBaseline) {
      throw new Error(`保存后 docx 删除线 run 数异常：baseline=${strikeBaseline}, after=${strikeAfterSave}（修订标记泄漏进文件）`);
    }

    // N 拒绝：直接对最长段落生成提案并断言 marginMark 注入（第 58 轮 1206 字段落
    // 曾因 before 整段逐字命中失败降级 rail，走查被迫"探测可注入段落"；Task 3
    // 片段级锚定后应可注入）。若仍注入失败，记录原因、撤回清理后退回探测兜底。
    const thirdParas = (await api("/api/v1/session")).opened.blocks
      .filter((b) => b.kind !== "table" && b.text.trim().length > 40);
    const longestThird = [...thirdParas]
      .sort((a, b) => b.text.trim().length - a.text.trim().length)[0] ?? null;
    const createProposalOn = async (block) => {
      if (!(await selectText(keywordOf(block.text)))) return null;
      await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
      await page.locator(".sel-bubble button", { hasText: "改写" }).first().click();
      await page.locator(".thread-popover").waitFor({ state: "visible", timeout: 15_000 });
      const t = Date.now();
      while (Date.now() - t < 60_000) {
        if ((await proposalCount()) > 0) break;
        await page.waitForTimeout(500);
      }
      if ((await proposalCount()) !== 1) throw new Error(`4b N 拒绝场景 expected 1 proposal, got ${await proposalCount()}`);
      return (await listProposed())[0];
    };
    const waitMarkInjected = async (proposalId, timeoutMs = 15_000) => {
      const t = Date.now();
      while (Date.now() - t < timeoutMs) {
        if ((await officeState()).marks.some((mark) => mark.proposalId === proposalId)) return true;
        await page.waitForTimeout(300);
      }
      return false;
    };
    // 撤回当前唯一 pending 提案并回到对话 tab（清理用途，不做正文断言）。
    const withdrawPendingQuietly = async () => {
      if (await page.locator(".thread-backdrop").count()) {
        await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
        await page.waitForTimeout(300);
      }
      await page.getByRole("tab", { name: /审阅/ }).click();
      await page.waitForTimeout(400);
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll(".review-panel button")]
          .find((candidate) => candidate.textContent?.includes("N 拒绝"));
        return Boolean(button && !button.disabled);
      }, null, { timeout: 20_000 });
      await page.locator(".review-panel button", { hasText: "N 拒绝" }).first().click();
      await page.waitForTimeout(800);
      await page.getByRole("tab", { name: /对话/ }).click();
      await page.waitForTimeout(300);
    };
    let thirdProposal = null;
    if (longestThird) {
      thirdProposal = await createProposalOn(longestThird);
      const longestLen = longestThird.text.trim().length;
      if (thirdProposal && (await waitMarkInjected(thirdProposal.id))) {
        note(`最长段落（${longestLen} 字）marginMark 注入成功（片段级锚定）`);
      } else {
        note(`最长段落（${longestLen} 字）提案/标记注入失败（降级 rail），清理后退回探测兜底`);
        if (thirdProposal) await withdrawPendingQuietly();
        thirdProposal = null;
        let fallbackBlock = null;
        for (const candidate of thirdParas) {
          if (candidate.id === longestThird.id) continue;
          const found = await page.locator(".office-editor").evaluate(
            (element, text) => Reflect.get(element, "__marginOfficeTestSelect")?.(text, 0) ?? null,
            candidate.text,
          );
          if (found) {
            fallbackBlock = candidate;
            break;
          }
        }
        if (fallbackBlock) {
          thirdProposal = await createProposalOn(fallbackBlock);
          if (thirdProposal && !(await waitMarkInjected(thirdProposal.id))) {
            throw new Error("4b 兜底段落提案未注入修订标记");
          }
        }
      }
    }
    if (!thirdProposal) {
      note("无可用段落，跳过 N 拒绝场景");
    } else {
      if (await page.locator(".thread-backdrop").count()) {
        await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
        await page.waitForTimeout(300);
      }
      await page.getByRole("tab", { name: /审阅/ }).click();
      await page.waitForTimeout(400);
      // 按钮在 busy/dirty/reviewBusy 时禁用——等其可用。
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll(".review-panel button")]
          .find((candidate) => candidate.textContent?.includes("N 拒绝"));
        return Boolean(button && !button.disabled);
      }, null, { timeout: 20_000 });
      await page.locator(".review-panel button", { hasText: "N 拒绝" }).first().click();
      await page.waitForTimeout(800);
      await waitMarks(false);
      const rejectedState = await officeState();
      const compactRejectedText = rejectedState.text.replace(/\s+/g, "");
      if (!compactRejectedText.includes(thirdProposal.before.replace(/\s+/g, "").slice(0, 30))) {
        throw new Error("N 拒绝后原文未还原");
      }
      if (compactRejectedText.includes(thirdProposal.after.replace(/\s+/g, "").slice(0, 30))) {
        throw new Error("N 拒绝后正文仍残留 after 文本");
      }
      if ((await proposalCount()) !== 0) throw new Error("N 拒绝后仍有 pending 提案残留");
      await page.getByRole("tab", { name: /对话/ }).click();
      await page.waitForTimeout(300);
    }
  }

  step("5. Cross-paragraph selection -> multi-block proposals");
  const fresh = (await api("/api/v1/session")).opened.blocks.filter((b) => b.kind !== "table" && b.text.trim().length > 40);
  const [blockA, blockB] = fresh;
  const ra = await selectText(keywordOf(blockA.text));
  const rb = await selectText(keywordOf(blockB.text));
  if (!ra || !rb) throw new Error("could not locate cross-paragraph keywords");
  const rangeText = await selectRange(Math.max(0, ra.startIndex - 1), rb.endIndex);
  if (!rangeText || !rangeText.trim()) throw new Error("cross-paragraph range is empty");
  await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
  const limitText = await page.locator(".sel-bubble .selection-limit").textContent().catch(() => null);
  if (limitText) throw new Error(`cross-paragraph selection still blocked: ${limitText}`);
  const crossStrip = await page.locator(".attention-strip").textContent();
  if (!/段选区/.test(crossStrip ?? "")) note("跨段选区时注意力条未显示“N 段选区” chip");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "06-cross-paragraph.png") });
  await page.locator(".sel-bubble button", { hasText: "改写" }).first().click();
  const t1 = Date.now();
  while (Date.now() - t1 < 90_000) {
    if ((await proposalCount()) >= 2) break;
    await page.waitForTimeout(500);
  }
  const crossCount = await proposalCount();
  if (crossCount < 2) throw new Error(`expected >=2 cross-block proposals, got ${crossCount}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "07-cross-proposals.png") });

  step("5b. Cross-paragraph selection after a table block");
  const allBlocks = (await api("/api/v1/session")).opened.blocks;
  const tableIndex = allBlocks.findIndex((b) => b.kind === "table");
  if (tableIndex === -1) {
    note("整篇文档无表格块，跳过“表格后跨段选区”场景");
  } else {
    // Consecutive paragraph run right after the first table; short heading
    // paragraphs may sit between the table and the first long pair.
    const run = [];
    for (let i = tableIndex + 1; i < allBlocks.length; i += 1) {
      if (allBlocks[i].kind === "table") break;
      run.push(allBlocks[i]);
    }
    let afterTable = [];
    for (let i = 0; i + 1 < run.length; i += 1) {
      if (run[i].text.trim().length > 40 && run[i + 1].text.trim().length > 40) {
        afterTable = [run[i], run[i + 1]];
        break;
      }
    }
    if (!afterTable.length) {
      const longOnes = run.filter((b) => b.text.trim().length > 40);
      if (longOnes.length >= 2) {
        afterTable = longOnes.slice(0, 2);
        note("表格后长段落不相邻，降级选用前两段长段落");
      } else if (longOnes.length === 1) {
        afterTable = longOnes;
      }
    }
    if (afterTable.length === 0) {
      note("第一个表格块之后没有可用的相邻长段落，跳过“表格后跨段选区”场景");
    } else {
      if (afterTable.length < 2) note("表格后相邻长段落不足两段，降级为单段走查");
      if (await page.locator(".thread-backdrop").count()) {
        await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
        await page.waitForTimeout(400);
      }
      const rangeStart = await selectText(keywordOf(afterTable[0].text));
      const rangeEnd = afterTable[1] ? await selectText(keywordOf(afterTable[1].text)) : null;
      if (!rangeStart || (afterTable[1] && !rangeEnd)) {
        throw new Error("could not locate after-table paragraph keywords");
      }
      const afterRange = rangeEnd
        ? [Math.max(0, rangeStart.startIndex - 1), rangeEnd.endIndex]
        : [rangeStart.startIndex, rangeStart.endIndex];
      const afterRangeText = await selectRange(afterRange[0], afterRange[1]);
      if (!afterRangeText || !afterRangeText.trim()) throw new Error("after-table range is empty");
      await page.waitForTimeout(400);
      await scrollSelectionIntoView();
      await page.waitForTimeout(300);
      // Re-apply the range so the bubble anchor recomputes against the scrolled viewport.
      await selectRange(afterRange[0], afterRange[1]);
      await page.waitForTimeout(300);
      await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
      const afterBubble = await page.locator(".sel-bubble").textContent().catch(() => "");
      const afterStrip = await page.locator(".attention-strip").textContent().catch(() => "");
      const chipMatch = /(\d+)\s*段选区/.exec(afterStrip ?? "");
      if (afterTable.length >= 2 && (!chipMatch || Number(chipMatch[1]) < 2)) {
        throw new Error(`表格后跨段选区未出现 N>=2 段选区 chip，strip: ${afterStrip}`);
      }
      if (
        (afterBubble ?? "").includes("无法把选区定位到文档段落")
        || (afterStrip ?? "").includes("无法把选区定位到文档段落")
        || (await page.locator(".sel-bubble .selection-limit").count()) > 0
      ) {
        throw new Error("表格后跨段选区仍被标记为“无法把选区定位到文档段落”");
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, "16-cross-after-table.png") });
      const proposalsBeforeList = await listProposed();
      await page.locator(".sel-bubble button", { hasText: "改写" }).first().click();
      const tAfter = Date.now();
      while (Date.now() - tAfter < 90_000) {
        if ((await proposalCount()) > proposalsBeforeList.length) break;
        await page.waitForTimeout(500);
      }
      const proposalsAfterList = await listProposed();
      if (proposalsAfterList.length <= proposalsBeforeList.length) {
        throw new Error("表格后跨段选区改写未产生新提案");
      }
      // New proposals must target paragraph blocks after the table (not the
      // table itself, not null, not earlier blocks). The editor range can
      // legitimately span one more block than the picked pair ("N 段选区").
      const beforeProposalIds = new Set(proposalsBeforeList.map((p) => p.id));
      const afterTableBlockIds = new Set(
        allBlocks.slice(tableIndex + 1).filter((b) => b.kind !== "table").map((b) => b.id),
      );
      const newProposals = proposalsAfterList.filter((p) => !beforeProposalIds.has(p.id));
      for (const proposal of newProposals) {
        if (!proposal.blockId || !afterTableBlockIds.has(proposal.blockId)) {
          throw new Error(
            `表格后跨段提案落在意外 block: ${proposal.blockId}（期望表格之后的段落）`,
          );
        }
      }
      await page.waitForTimeout(400);
    }
  }

  step("6. Review tab + accept all");
  if (await page.locator(".thread-backdrop").count()) {
    await page.locator(".thread-backdrop").click({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(400);
  }
  await page.getByRole("tab", { name: /审阅/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "08-review-tab.png") });
  await page.getByRole("tab", { name: /对话/ }).click();
  await page.waitForTimeout(300);
  const chatBox = page.locator(".composer-card textarea").first();
  await chatBox.fill("接受全部");
  await page.keyboard.press("Enter");
  const t2 = Date.now();
  while (Date.now() - t2 < 60_000) {
    if ((await proposalCount()) === 0) break;
    await page.waitForTimeout(500);
  }
  if ((await proposalCount()) !== 0) throw new Error("接受全部 did not clear proposals");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "09-accept-all.png") });

  step("6c. Review history view");
  await page.getByRole("tab", { name: /审阅/ }).click();
  await page.waitForTimeout(400);
  await page.locator(".review-sections button", { hasText: "历史" }).click();
  try {
    await page.waitForFunction(
      () => document.querySelectorAll(".review-history li").length > 0,
      null,
      { timeout: 10_000 },
    );
  } catch {
    const empty = await page.locator(".review-history").textContent().catch(() => "");
    throw new Error(`历史视图无条目（接受/拒绝记录缺失）: ${empty?.slice(0, 120)}`);
  }
  const historyText = await page.locator(".review-history").textContent();
  if (!/→\s*Y 接受/.test(historyText ?? "")) {
    throw new Error(`历史视图缺少“操作 → Y 接受”决策记录: ${historyText?.slice(0, 120)}`);
  }
  if (
    (await page.locator(".review-history .review-fragment.before").count()) === 0
    || (await page.locator(".review-history .review-fragment.after").count()) === 0
  ) {
    throw new Error("历史条目缺少 before→after 摘要");
  }
  await page.screenshot({ path: path.join(outDir, "18-history.png") });
  await page.getByRole("tab", { name: /对话/ }).click();
  await page.waitForTimeout(300);

  step("6b. Mixed attention (selection + attached source)");
  const mixedBlocks = (await api("/api/v1/session")).opened.blocks
    .filter((b) => b.kind !== "table" && b.text.trim().length > 40);
  if (!mixedBlocks.length || !fs.existsSync(fixtureSource)) {
    note("无可用段落或 fixture 缺失，跳过 mixed 注意力断言");
  } else {
    if (!(await selectText(keywordOf(mixedBlocks[0].text)))) {
      throw new Error("mixed step could not select a paragraph");
    }
    await page.locator(".sel-bubble").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".source-picker-toggle").click();
    // Wait directly for the fixture entry; the panel renders loading/empty states first.
    const sourceOption = page.locator(".source-picker-list label", { hasText: "agent-chapter.md" });
    const sourceListed = await sourceOption.first()
      .waitFor({ state: "attached", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!sourceListed) {
      note("SourcePicker 未列出 agent-chapter.md，跳过 mixed 注意力断言");
      await page.keyboard.press("Escape");
    } else {
      await sourceOption.first().click();
      await page
        .waitForFunction(
          () => document.querySelector(".attention-strip")?.textContent?.includes("资料 ×"),
          null,
          { timeout: 10_000 },
        )
        .catch(() => null);
      const mixedStrip = await page.locator(".attention-strip").textContent().catch(() => "");
      if (!mixedStrip?.includes("资料 ×")) note("选区 + 附加资料时注意力条未显示“资料 ×N” chip（mixed 态）");
      if (!mixedStrip?.includes("选区")) note("mixed 态下选区 chip 丢失");
      // Cleanup: detach source, close panel, clear selection.
      await sourceOption.first().click();
      await page.waitForTimeout(600);
      await page.keyboard.press("Escape");
      const clearSelection = page.locator(".attention-strip .linkish", { hasText: "清除" });
      if (await clearSelection.count()) await clearSelection.first().click();
      await page.waitForTimeout(400);
    }
  }

  step("7. Chat markdown table rendering (design verification)");
  await injectMdDemo();
  await page.waitForTimeout(300);
  await assertMdTableFits();
  await page.screenshot({ path: path.join(outDir, "10-md-table.png") });
  await removeMdDemo();

  step("8. Export command");
  await chatBox.fill("导出");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  const exportMsg = await page.locator(".chat-activity .bubble.assistant").last().textContent();
  if (!/导出|Word/.test(exportMsg ?? "")) note("“导出”命令后未看到导出确认消息");
  await page.screenshot({ path: path.join(outDir, "11-export.png") });

  step("9. Theme + layout switches");
  // Cycle system -> light -> dark; fresh profiles start at "system", so reaching
  // dark can take two clicks. Assert we actually land on dark (regression: the
  // old check accepted "light" too and never verified dark at all).
  let theme = "";
  for (let attempt = 0; attempt < 3 && theme !== "dark"; attempt += 1) {
    await page.locator(".icon-button.theme-cycle").click();
    await page.waitForTimeout(400);
    theme = await page.evaluate(() => document.documentElement.dataset.theme);
  }
  if (theme !== "dark") throw new Error(`主题切换后 data-theme 必须为 dark，实际: ${theme}`);
  await injectMdDemo();
  await page.waitForTimeout(300);
  await assertMdTableFits();
  await page.screenshot({ path: path.join(outDir, "12-dark.png") });
  await removeMdDemo();
  await page.locator(".icon-button.theme-cycle").click();
  await page.waitForTimeout(300);
  await page.getByTitle("悬浮侧栏").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "13-float.png") });
  await page.getByTitle("停靠侧栏").click();
  await page.waitForTimeout(300);

  step("10. Mobile viewport");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, "14-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(400);

  step("11. Close document via command");
  await chatBox.fill("关闭文档");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  if (await page.locator(".office-workspace").count()) note("“关闭文档”后编辑器仍然挂载");
  await page.screenshot({ path: path.join(outDir, "15-closed.png") });

  console.log("\nUX_WALKTHROUGH_OK", outDir);
  if (notes.length) {
    console.log("\n--- 走查发现的槽点 ---");
    for (const item of notes) console.log(` - ${item}`);
  } else {
    console.log("\n--- 走查未发现新槽点 ---");
  }
} finally {
  await browser?.close().catch(() => undefined);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}
process.exit(0);
