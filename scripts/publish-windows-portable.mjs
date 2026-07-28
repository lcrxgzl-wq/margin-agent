#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "apps", "cli", "package.json"), "utf8"));
const tag = `v${manifest.version}`;
const bundleName = `margin-agent-win-x64-${tag}`;
const zipPath = path.join(root, "release", `${bundleName}.zip`);
const checksumPath = `${zipPath}.sha256`;
const gh = process.platform === "win32" ? "gh.exe" : "gh";

if (process.env.GITHUB_REF_TYPE !== "tag" || process.env.GITHUB_REF_NAME !== tag) {
  throw new Error(`portable release requires tag ${tag}; got ${process.env.GITHUB_REF_NAME ?? "no tag"}`);
}
if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required to publish portable assets");
for (const asset of [zipPath, checksumPath]) {
  if (!fs.existsSync(asset)) throw new Error(`portable release asset is missing: ${asset}`);
}
const actualHash = createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
const recordedHash = fs.readFileSync(checksumPath, "ascii").trim().split(/\s+/, 1)[0];
if (actualHash !== recordedHash) throw new Error("portable release checksum does not match the ZIP");

const runGh = (args, options = {}) => execFileSync(gh, args, {
  cwd: root,
  stdio: "inherit",
  ...options,
});

let releaseExists = true;
try {
  runGh(["release", "view", tag], { stdio: "ignore" });
} catch {
  releaseExists = false;
}

if (releaseExists) {
  runGh(["release", "upload", tag, zipPath, checksumPath, "--clobber"]);
} else {
  runGh([
    "release", "create", tag, zipPath, checksumPath,
    "--verify-tag",
    "--generate-notes",
    "--title", `Margin ${manifest.version}`,
  ]);
}

console.log(`WINDOWS_PORTABLE_RELEASE_OK tag=${tag} zip=${path.basename(zipPath)}`);
