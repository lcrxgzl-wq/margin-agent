#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const NODE_VERSION = "22.23.1";
const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_ARCHIVE_SHA256 = "7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "apps", "cli");
const releaseDir = path.join(root, "release");
const tmp = path.join(root, ".tmp-windows-portable");
const archiveTool = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "tar.exe");
const manifest = JSON.parse(fs.readFileSync(path.join(cli, "package.json"), "utf8"));
const bundleName = `margin-agent-win-x64-v${manifest.version}`;
const zipPath = path.join(releaseDir, `${bundleName}.zip`);
const checksumPath = `${zipPath}.sha256`;

function assertExpectedPath(candidate, expectedParent) {
  const relative = path.relative(expectedParent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing unexpected output path: ${candidate}`);
  }
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
}

function runNpm(args) {
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(npmCli)) throw new Error(`npm CLI not found beside Node.js: ${npmCli}`);
  run(process.execPath, [npmCli, ...args]);
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function directoryBytes(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

function removeDevelopmentArtifacts(directory) {
  let removedBytes = 0;
  let removedFiles = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const removed = removeDevelopmentArtifacts(target);
      removedBytes += removed.bytes;
      removedFiles += removed.files;
    } else if (entry.isFile() && (/\.map$/i.test(entry.name) || /\.d\.(?:ts|mts|cts)$/i.test(entry.name))) {
      removedBytes += fs.statSync(target).size;
      fs.rmSync(target);
      removedFiles += 1;
    }
  }
  return { bytes: removedBytes, files: removedFiles };
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows portable packages must be built on Windows x64");
}
if (!fs.existsSync(archiveTool)) throw new Error(`Windows archive tool not found: ${archiveTool}`);
const archiveVersion = execFileSync(archiveTool, ["--version"], { encoding: "utf8" });
if (!/bsdtar/i.test(archiveVersion)) throw new Error("Windows portable packaging requires the system bsdtar");
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${manifest.version}`) {
  throw new Error(`release tag ${process.env.GITHUB_REF_NAME} does not match package version ${manifest.version}`);
}

assertExpectedPath(tmp, root);
assertExpectedPath(zipPath, releaseDir);
assertExpectedPath(checksumPath, releaseDir);
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(releaseDir, { recursive: true });

try {
  const packDir = path.join(tmp, "pack");
  fs.mkdirSync(packDir, { recursive: true });
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("portable packaging must run through pnpm");
  run(process.execPath, [pnpmCli, "--filter", "margin-agent", "pack", "--pack-destination", packDir]);
  const tarballs = fs.readdirSync(packDir).filter((file) => /^margin-agent-.*\.tgz$/.test(file));
  if (tarballs.length !== 1) throw new Error("portable packaging expected one Margin tarball");

  const payloadDir = path.join(tmp, "payload");
  const bundleDir = path.join(payloadDir, bundleName);
  const appDir = path.join(bundleDir, "app");
  const runtimeDir = path.join(bundleDir, "runtime");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  runNpm([
    "install",
    path.join(packDir, tarballs[0]),
    "--prefix", appDir,
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--os=win32",
    "--cpu=x64",
  ]);
  for (const generated of ["package.json", "package-lock.json"]) {
    fs.rmSync(path.join(appDir, generated), { force: true });
  }
  fs.rmSync(path.join(appDir, "node_modules", ".package-lock.json"), { force: true });

  const pruned = removeDevelopmentArtifacts(path.join(appDir, "node_modules"));
  console.log(`Removed ${pruned.files} development artifacts (${pruned.bytes} bytes)`);

  const installedManifestPath = path.join(appDir, "node_modules", "margin-agent", "package.json");
  const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8"));
  if (installedManifest.version !== manifest.version) {
    throw new Error(`installed Margin version ${installedManifest.version} does not match ${manifest.version}`);
  }

  const nodeArchiveUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`;
  const nodeArchive = await download(nodeArchiveUrl);
  const actualNodeHash = sha256(nodeArchive);
  if (actualNodeHash !== NODE_ARCHIVE_SHA256) {
    throw new Error(`Node.js archive checksum mismatch: ${actualNodeHash}`);
  }
  const nodeArchivePath = path.join(tmp, NODE_ARCHIVE);
  const nodeExtractDir = path.join(tmp, "node-runtime");
  fs.writeFileSync(nodeArchivePath, nodeArchive);
  fs.mkdirSync(nodeExtractDir, { recursive: true });
  run(archiveTool, ["-xf", nodeArchivePath, "-C", nodeExtractDir]);
  const nodeSourceDir = path.join(nodeExtractDir, `node-v${NODE_VERSION}-win-x64`);
  fs.copyFileSync(path.join(nodeSourceDir, "node.exe"), path.join(runtimeDir, "node.exe"));
  fs.copyFileSync(path.join(nodeSourceDir, "LICENSE"), path.join(runtimeDir, "NODE_LICENSE.txt"));
  fs.writeFileSync(
    path.join(runtimeDir, "NODE_RUNTIME.txt"),
    `Node.js v${NODE_VERSION} win-x64\nSource: ${nodeArchiveUrl}\nSHA-256: ${NODE_ARCHIVE_SHA256}\n`,
    "utf8",
  );
  const embeddedNodeVersion = execFileSync(path.join(runtimeDir, "node.exe"), ["--version"], { encoding: "utf8" }).trim();
  if (embeddedNodeVersion !== `v${NODE_VERSION}`) {
    throw new Error(`embedded Node.js version mismatch: ${embeddedNodeVersion}`);
  }

  fs.copyFileSync(path.join(root, "scripts", "windows-portable-launcher.cjs"), path.join(bundleDir, "launcher.cjs"));
  const cmd = [
    "@echo off",
    "setlocal",
    "title Margin Agent",
    "if \"%~1\"==\"\" (",
    "  \"%~dp0runtime\\node.exe\" \"%~dp0launcher.cjs\"",
    ") else (",
    "  \"%~dp0runtime\\node.exe\" \"%~dp0launcher.cjs\" \"%~1\"",
    ")",
    "if errorlevel 1 (",
    "  echo.",
    "  echo Margin could not start. See the message above.",
    "  pause",
    ")",
    "endlocal",
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(bundleDir, "启动 Margin.cmd"), cmd, "utf8");

  const readme = `Margin ${manifest.version} Windows x64 便携版\r\n\r\n` +
    `1. 双击“启动 Margin.cmd”。首次启动会创建“文档\\Margin”工作区。\r\n` +
    `2. 也可以把一个论文文件夹拖到“启动 Margin.cmd”上，以该文件夹作为工作区。\r\n` +
    `3. 浏览器会自动打开。运行期间请保留终端窗口，关闭窗口即可停止 Margin。\r\n` +
    `4. 更新时替换本程序目录即可；工作区、文稿和 .margin 记录保存在程序目录之外。\r\n\r\n` +
    `Margin 只监听 127.0.0.1。调用模型时，选区和必要上下文会发送到你配置的模型服务商。\r\n` +
    `项目：https://github.com/lcrxgzl-wq/margin-agent\r\n` +
    `许可：MIT\r\n`;
  fs.writeFileSync(path.join(bundleDir, "使用说明.txt"), readme, "utf8");
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(bundleDir, "MARGIN_LICENSE.txt"));
  fs.copyFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(bundleDir, "THIRD_PARTY_NOTICES.md"));
  fs.writeFileSync(path.join(bundleDir, "PORTABLE_MANIFEST.json"), `${JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    platform: "win32",
    arch: "x64",
    node: NODE_VERSION,
  }, null, 2)}\n`, "utf8");

  fs.rmSync(zipPath, { force: true });
  fs.rmSync(checksumPath, { force: true });
  run(archiveTool, ["--format", "zip", "-cf", zipPath, "-C", payloadDir, bundleName]);
  for (const required of [
    `${bundleName}/启动 Margin.cmd`,
    `${bundleName}/runtime/node.exe`,
    `${bundleName}/app/node_modules/margin-agent/dist/index.js`,
  ]) {
    try {
      execFileSync(archiveTool, ["-tf", zipPath, required], { stdio: "ignore" });
    } catch {
      throw new Error(`portable ZIP is missing ${required}`);
    }
  }
  const archiveHash = sha256(fs.readFileSync(zipPath));
  fs.writeFileSync(checksumPath, `${archiveHash}  ${path.basename(zipPath)}\n`, "ascii");
  console.log(
    `WINDOWS_PORTABLE_BUILD_OK version=${manifest.version} node=${NODE_VERSION} ` +
    `zipBytes=${fs.statSync(zipPath).size} unpackedBytes=${directoryBytes(bundleDir)}`,
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
