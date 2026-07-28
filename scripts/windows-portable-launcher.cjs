const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

function defaultWorkspace() {
  if (process.env.MARGIN_PORTABLE_WORKSPACE) {
    return path.resolve(process.env.MARGIN_PORTABLE_WORKSPACE);
  }
  const documentRoots = [
    process.env.OneDriveCommercial && path.join(process.env.OneDriveCommercial, "Documents"),
    process.env.OneDrive && path.join(process.env.OneDrive, "Documents"),
    path.join(os.homedir(), "Documents"),
  ].filter(Boolean);
  const documents = documentRoots.find((candidate) => fs.existsSync(candidate)) ?? documentRoots.at(-1);
  return path.join(documents, "Margin");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a local port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function main() {
  const input = process.argv[2]?.trim();
  const workspace = path.resolve(input || defaultWorkspace());
  if (fs.existsSync(workspace) && !fs.statSync(workspace).isDirectory()) {
    throw new Error(`workspace must be a folder: ${workspace}`);
  }
  fs.mkdirSync(workspace, { recursive: true });

  const configuredPort = process.env.MARGIN_PORT;
  const port = configuredPort === undefined ? await freePort() : Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid MARGIN_PORT: ${configuredPort}`);
  }

  const entry = path.join(__dirname, "app", "node_modules", "margin-agent", "dist", "index.js");
  if (!fs.existsSync(entry)) throw new Error(`Margin runtime is incomplete: ${entry}`);

  const child = spawn(process.execPath, [entry, workspace], {
    env: { ...process.env, MARGIN_PORT: String(port) },
    stdio: "inherit",
  });
  const forward = (signal) => {
    if (child.exitCode === null) child.kill(signal);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
