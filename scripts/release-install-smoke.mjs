import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "margin-install-smoke-"));
const port = 12000 + Math.floor(Math.random() * 20000);

const npmCliJs = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const runNpm = (args) => {
  if (fs.existsSync(npmCliJs)) return run(process.execPath, [npmCliJs, ...args]);
  // fallback: npm shim needs a shell on Windows (.cmd)
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
};

let child;
try {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("install smoke must run through pnpm");
  run(process.execPath, [pnpmCli, "--filter", "margin-agent", "pack", "--pack-destination", tmp], { cwd: root });

  const tarball = fs.readdirSync(tmp).find((file) => /^margin-agent-.*\.tgz$/.test(file));
  if (!tarball) throw new Error("release tarball was not produced");

  const prefix = path.join(tmp, "prefix");
  runNpm(["install", "-g", "--prefix", prefix, path.join(tmp, tarball)]);

  const pkgDir = path.join(prefix, "node_modules", "margin-agent");
  const shim =
    process.platform === "win32"
      ? path.join(prefix, "margin-agent.cmd")
      : path.join(prefix, "bin", "margin-agent");
  for (const required of [shim, path.join(pkgDir, "dist", "index.js")]) {
    if (!fs.existsSync(required)) throw new Error(`installed package is missing ${required}`);
  }

  const workspace = path.join(tmp, "ws");
  child = spawn(process.execPath, [path.join(pkgDir, "dist", "index.js"), workspace], {
    env: { ...process.env, MARGIN_NO_OPEN: "1", MARGIN_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (chunk) => (serverLog += chunk));
  child.stderr.on("data", (chunk) => (serverLog += chunk));

  const deadline = Date.now() + 30_000;
  let body = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 200) {
        body = await res.text();
        break;
      }
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!body) throw new Error(`installed server did not respond 200 within 30s\n${serverLog}`);
  if (!body.includes("<html")) throw new Error("installed server did not serve the UI");
  if (!/#token=/.test(serverLog)) throw new Error(`token URL was not printed\n${serverLog}`);

  console.log(`RELEASE_INSTALL_SMOKE_OK port=${port} tarball=${tarball}`);
} finally {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
