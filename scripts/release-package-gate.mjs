import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "apps", "cli");
const output = path.join(root, ".tmp-release-gate");
const sourceManifest = JSON.parse(fs.readFileSync(path.join(cli, "package.json"), "utf8"));
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

let tarVersion = "";
try {
  tarVersion = execFileSync("tar", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  // Some BSD tar variants do not implement --version; only GNU needs --force-local.
}
const tarArgs = (args) => process.platform === "win32" && /\(GNU tar\)/.test(tarVersion)
  ? ["--force-local", ...args]
  : args;

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("release gate must run through pnpm");
execFileSync(process.execPath, [pnpmCli, "--filter", "margin-agent", "pack", "--pack-destination", output], {
  cwd: root,
  stdio: "inherit",
});

const tarballs = fs.readdirSync(output).filter((file) => file.endsWith(".tgz"));
if (tarballs.length !== 1) throw new Error("release gate expected exactly one tarball");
const tarball = tarballs[0];
const tarballPath = path.join(output, tarball);
const entries = execFileSync("tar", tarArgs(["-tf", tarballPath]), { encoding: "utf8" })
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
  tarArgs(["-xOf", tarballPath, "package/package.json"]),
  { encoding: "utf8" },
));
if (
  sourceManifest.name !== "margin-agent" ||
  packedManifest.name !== sourceManifest.name ||
  packedManifest.version !== sourceManifest.version
) {
  throw new Error("release package identity is incorrect");
}
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== `v${packedManifest.version}`
) {
  throw new Error(
    `release tag ${process.env.GITHUB_REF_NAME} does not match package version ${packedManifest.version}`,
  );
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
