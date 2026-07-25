import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "apps", "cli");
const output = path.join(root, ".tmp-release-gate");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("release gate must run through pnpm");
execFileSync(process.execPath, [pnpmCli, "--filter", "margin-agent", "pack", "--pack-destination", output], {
  cwd: root,
  stdio: "inherit",
});

const tarball = fs.readdirSync(output).find((file) => /^margin-agent-0\.1\.0\.tgz$/.test(file));
if (!tarball) throw new Error("release tarball was not produced");
const tarballPath = path.join(output, tarball);
const entries = execFileSync("tar", ["--force-local", "-tf", tarballPath], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);

const required = [
  "package/dist/index.js",
  "package/web-dist/index.html",
  "package/skills/source-grounded-writing/SKILL.md",
  "package/LICENSE",
  "package/THIRD_PARTY_NOTICES.md",
];
for (const entry of required) {
  if (!entries.includes(entry)) throw new Error(`release tarball is missing ${entry}`);
}

const forbidden = entries.filter((entry) =>
  /(?:^|\/)(?:src|imports)(?:\/|$)|\.test\.[cm]?[jt]sx?$|\.docx$/i.test(entry),
);
if (forbidden.length) throw new Error(`release tarball contains forbidden files: ${forbidden.join(", ")}`);

const packedManifest = JSON.parse(execFileSync(
  "tar",
  ["--force-local", "-xOf", tarballPath, "package/package.json"],
  { encoding: "utf8" },
));
if (packedManifest.name !== "margin-agent" || packedManifest.version !== "0.1.0") {
  throw new Error("release package identity is incorrect");
}
const runtimeDependencies = Object.keys(packedManifest.dependencies ?? {});
const leakedWorkspaceDependency = [
  ...runtimeDependencies,
  ...Object.keys(packedManifest.devDependencies ?? {}),
].find((name) => name.startsWith("@margin/"));
if (leakedWorkspaceDependency) {
  throw new Error(`release package leaks unpublished dependency ${leakedWorkspaceDependency}`);
}

const bundle = fs.readFileSync(path.join(cli, "dist", "index.js"), "utf8");
if (!bundle.startsWith("#!/usr/bin/env node\n")) throw new Error("release CLI is missing its shebang");
if (bundle.slice(22).startsWith("#!/usr/bin/env node")) throw new Error("release CLI has duplicate shebangs");
if (/from\s+["']@margin\//.test(bundle)) throw new Error("release bundle contains @margin runtime imports");

console.log(`RELEASE_PACKAGE_GATE_OK files=${entries.length} bytes=${fs.statSync(tarballPath).size}`);
