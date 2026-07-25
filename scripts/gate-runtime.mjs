import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export function createGateWorkspace(repoRoot, prefix) {
  const runtimeRoot = path.resolve(
    process.env.MARGIN_RUNTIME_ROOT ?? path.join(path.parse(repoRoot).root, "margin-runtime", "gates"),
  );
  fs.mkdirSync(runtimeRoot, { recursive: true });
  return {
    runtimeRoot,
    workspace: fs.mkdtempSync(path.join(runtimeRoot, prefix)),
  };
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a gate port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export function collectCliOutput(child) {
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  return () => output;
}

export async function waitForCliUrl(child, output, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /UI:\s+(http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+)/i.exec(output());
    if (match) return match[1];
    if (child.exitCode != null) throw new Error(`CLI exited with ${child.exitCode}\n${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CLI startup timed out\n${output()}`);
}

export async function stopChild(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

export function removeGateWorkspace(workspace, runtimeRoot) {
  const relative = path.relative(runtimeRoot, workspace);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refused to clean unexpected gate workspace: ${workspace}`);
  }
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

