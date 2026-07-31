#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectCliOutput,
  freePort,
  stopChild,
  waitForCliUrl,
} from "./gate-runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const cliManifest = JSON.parse(fs.readFileSync(path.join(root, "apps", "cli", "package.json"), "utf8"));
const bundleName = `margin-agent-win-x64-v${cliManifest.version}`;
const zipPath = path.join(root, "release", `${bundleName}.zip`);
const checksumPath = `${zipPath}.sha256`;
const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
const archiveTool = path.join(systemRoot, "System32", "tar.exe");
const whereTool = path.join(systemRoot, "System32", "where.exe");
const MAX_ZIP_BYTES = 75 * 1024 * 1024;

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function findDevelopmentArtifact(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findDevelopmentArtifact(target);
      if (nested) return nested;
    } else if (entry.isFile() && (/\.map$/i.test(entry.name) || /\.d\.(?:ts|mts|cts)$/i.test(entry.name))) {
      return target;
    }
  }
  return undefined;
}

function simplePdf(text) {
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

function isolatedEnvironment(port) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["path", "node_options", "node_path"].includes(key.toLowerCase()),
  ));
  return {
    ...env,
    PATH: path.join(systemRoot, "System32"),
    MARGIN_PORT: String(port),
    MARGIN_NO_OPEN: "1",
    MARGIN_ENGINE: "simple",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    MARGIN_API_KEY: "",
    MARGIN_BASE_URL: "",
  };
}

function startPortable(bundleDir, workspace, port) {
  const embeddedNode = path.join(bundleDir, "runtime", "node.exe");
  const entry = path.join(bundleDir, "app", "node_modules", "margin-agent", "dist", "index.js");
  const child = spawn(embeddedNode, [entry, workspace], {
    cwd: bundleDir,
    env: isolatedEnvironment(port),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return { child, output: collectCliOutput(child) };
}

function apiFor(url) {
  const parsed = new URL(url);
  const token = parsed.hash.replace(/^#token=/, "");
  return async (route, init = {}) => {
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
}

async function stopPortable(server) {
  await stopChild(server.child);
  invariant(
    server.child.exitCode != null || server.child.signalCode != null,
    "portable CLI did not stop",
  );
  // Windows termination cannot run proper-lockfile's shutdown hook.
  await new Promise((resolve) => setTimeout(resolve, 5_250));
}

async function main() {
  invariant(process.platform === "win32" && process.arch === "x64", "portable gate requires Windows x64");
  invariant(fs.existsSync(archiveTool), `Windows archive tool not found: ${archiveTool}`);
  execFileSync(process.execPath, [path.join(root, "scripts", "build-windows-portable.mjs")], {
    cwd: root,
    stdio: "inherit",
  });

  invariant(fs.existsSync(zipPath), `portable ZIP was not produced: ${zipPath}`);
  invariant(fs.existsSync(checksumPath), `portable checksum was not produced: ${checksumPath}`);
  invariant(
    fs.statSync(zipPath).size <= MAX_ZIP_BYTES,
    `portable ZIP exceeds 75 MiB: ${fs.statSync(zipPath).size} bytes`,
  );
  const checksum = fs.readFileSync(checksumPath, "ascii").trim().split(/\s+/, 1)[0];
  invariant(checksum === sha256(zipPath), "portable ZIP checksum does not match");

  const tempParent = path.join(os.tmpdir(), "Margin 便携门禁");
  fs.mkdirSync(tempParent, { recursive: true });
  const extractionRoot = fs.mkdtempSync(path.join(tempParent, " 含空格 "));
  let server;
  try {
    // bsdtar receives argv in the system ANSI codepage on Windows; a Unicode
    // extraction path degrades to '?' on non-CJK locales (CI runners). chdir
    // instead: CreateProcessW handles the Unicode cwd, argv stays ASCII.
    execFileSync(archiveTool, ["-xf", zipPath], { cwd: extractionRoot, stdio: "inherit" });
    const bundleDir = path.join(extractionRoot, bundleName);
    const embeddedNode = path.join(bundleDir, "runtime", "node.exe");
    const launcher = path.join(bundleDir, "launcher.cjs");
    const commandFile = path.join(bundleDir, "Start Margin.cmd");
    const appManifestPath = path.join(bundleDir, "app", "node_modules", "margin-agent", "package.json");
    for (const required of [
      embeddedNode,
      path.join(bundleDir, "runtime", "NODE_LICENSE.txt"),
      path.join(bundleDir, "MARGIN_LICENSE.txt"),
      path.join(bundleDir, "THIRD_PARTY_NOTICES.md"),
      launcher,
      commandFile,
      appManifestPath,
    ]) {
      invariant(fs.existsSync(required), `extracted portable package is missing ${required}`);
    }
    const developmentArtifact = findDevelopmentArtifact(bundleDir);
    invariant(!developmentArtifact, `portable package contains development artifact ${developmentArtifact}`);
    invariant(
      !fs.existsSync(path.join(bundleDir, "app", "node_modules", ".package-lock.json")),
      "portable package contains npm's generated install lock",
    );
    const portableManifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "PORTABLE_MANIFEST.json"), "utf8"));
    invariant(portableManifest.version === cliManifest.version, "portable manifest version does not match");
    const installedManifest = JSON.parse(fs.readFileSync(appManifestPath, "utf8"));
    invariant(installedManifest.version === cliManifest.version, "installed package version does not match");
    invariant(
      execFileSync(embeddedNode, ["--version"], { encoding: "utf8" }).trim() === `v${portableManifest.node}`,
      "embedded Node.js version does not match the portable manifest",
    );
    execFileSync(embeddedNode, ["--check", launcher], { stdio: "inherit" });
    const commandText = fs.readFileSync(commandFile, "utf8");
    invariant(commandText.includes("%~dp0runtime\\node.exe"), "CMD launcher does not use the embedded Node.js runtime");

    const isolatedEnv = isolatedEnvironment(await freePort());
    let foundSystemNode = false;
    try {
      execFileSync(whereTool, ["node"], { env: isolatedEnv, stdio: "ignore" });
      foundSystemNode = true;
    } catch {
      // Expected: the test PATH contains only Windows system tools.
    }
    invariant(!foundSystemNode, "portable gate PATH unexpectedly exposes a system Node.js installation");

    const workspace = path.join(extractionRoot, "用户文稿 工作区");
    fs.mkdirSync(workspace, { recursive: true });
    // Create the fixture DOCX from the monorepo — the published package is a
    // single-file bundle with empty dependencies (no nested node_modules/docx).
    const requireFromCli = createRequire(path.join(root, "apps", "cli", "package.json"));
    const { Document, Packer, Paragraph } = requireFromCli("docx");
    const docxText = "Portable DOCX evidence survives restart.";
    const docxBuffer = await Packer.toBuffer(new Document({
      sections: [{ children: [new Paragraph(docxText)] }],
    }));
    fs.writeFileSync(path.join(workspace, "论文 样本.docx"), docxBuffer);
    const pdfText = "Portable PDF evidence from the bundled parser.";
    fs.writeFileSync(path.join(workspace, "资料 样本.pdf"), simplePdf(pdfText));

    server = startPortable(bundleDir, workspace, await freePort());
    const firstUrl = await waitForCliUrl(server.child, server.output, 30_000);
    const firstParsed = new URL(firstUrl);
    const home = await fetch(firstParsed.origin);
    invariant(home.status === 200 && (await home.text()).includes("<html"), "portable UI did not return HTML");
    const firstApi = apiFor(firstUrl);
    const capabilities = await firstApi("/api/v1/capabilities");
    invariant(capabilities.version === cliManifest.version, "portable capabilities version does not match");
    const opened = await firstApi("/api/v1/documents/open", {
      method: "POST",
      body: JSON.stringify({ relativePath: "论文 样本.docx" }),
    });
    invariant(opened.blocks?.some((block) => block.text?.includes(docxText)), "portable runtime could not read the DOCX");
    const source = await firstApi("/api/v1/workspace/source-chunk", {
      method: "POST",
      body: JSON.stringify({ sourceRef: "资料 样本.pdf#chars=0-8" }),
    });
    invariant(source.excerpt?.includes(pdfText), "portable runtime could not extract the PDF text layer");
    const documentId = opened.document.id;

    await stopPortable(server);
    server = undefined;
    server = startPortable(bundleDir, workspace, await freePort());
    const secondUrl = await waitForCliUrl(server.child, server.output, 30_000);
    const restored = await apiFor(secondUrl)("/api/v1/session");
    invariant(restored.opened?.document?.id === documentId, "portable restart lost the registered document");
    invariant(restored.opened?.blocks?.some((block) => block.text?.includes(docxText)), "portable restart lost DOCX content");

    console.log(
      `WINDOWS_PORTABLE_GATE_OK version=${cliManifest.version} zipBytes=${fs.statSync(zipPath).size} ` +
      `workspace=${JSON.stringify(workspace)}`,
    );
  } finally {
    if (server) await stopPortable(server).catch(() => undefined);
    fs.rmSync(extractionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    try { fs.rmdirSync(tempParent); } catch { /* shared or non-empty temp parent */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
