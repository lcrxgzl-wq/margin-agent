import { createServer } from "node:http";
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

async function startMockGateway(kind) {
  const hits = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    hits.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || "",
      "x-api-key": req.headers["x-api-key"] || "",
      body: Buffer.concat(chunks).toString("utf8"),
    });

    if (kind === "openai" && req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "smoke-model" }] }));
      return;
    }
    if (kind === "openai") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-smoke",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-smoke",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_smoke",
          type: "message",
          role: "assistant",
          content: [],
          model: "smoke-claude",
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n\n`,
    );
    res.write(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`,
    );
    res.write(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "pong" },
      })}\n\n`,
    );
    res.write(
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    );
    res.write(
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      })}\n\n`,
    );
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: gwPort } = server.address();
  return {
    hits,
    baseURL: kind === "openai" ? `http://127.0.0.1:${gwPort}/v1` : `http://127.0.0.1:${gwPort}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function assertBearerChat({ origin, token, workspace, kind, apiKey }) {
  const gw = await startMockGateway(kind);
  try {
    const save = await fetch(`${origin}/api/v1/settings/llm`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: {
          apiFormat: kind,
          authStyle: "bearer",
          baseURL: gw.baseURL,
          model: kind === "openai" ? "smoke-model" : "smoke-claude",
          apiKey,
        },
      }),
    });
    if (!save.ok) {
      throw new Error(`${kind} settings save returned ${save.status}: ${await save.text()}`);
    }

    fs.writeFileSync(path.join(workspace, "note.md"), "# hi\n\nhello\n");
    await fetch(`${origin}/api/v1/documents/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ relativePath: "note.md" }),
    });

    const chat = await fetch(`${origin}/api/v1/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "nihao", chatMode: "direct" }),
    });
    const chatText = await chat.text();

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && gw.hits.filter((h) => h.method === "POST").length === 0) {
      if (/No API key for provider/i.test(chatText)) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    if (/No API key for provider/i.test(chatText)) {
      throw new Error(`${kind} chat hit No API key for provider: ${chatText}`);
    }
    const posts = gw.hits.filter((h) => h.method === "POST");
    if (!posts.length) {
      throw new Error(`${kind} mock received no chat POST: ${chat.status} ${chatText}`);
    }
    const last = posts.at(-1);
    if (last.authorization !== `Bearer ${apiKey}`) {
      throw new Error(`${kind} missing Bearer auth: ${JSON.stringify(last)}`);
    }
    if (kind === "anthropic" && last["x-api-key"]) {
      throw new Error(`${kind} unexpectedly sent x-api-key: ${JSON.stringify(last)}`);
    }
  } finally {
    await gw.close();
  }
}

let child;
try {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("install smoke must run through pnpm");
  run(process.execPath, [pnpmCli, "--filter", "margin-agent", "pack", "--pack-destination", tmp], { cwd: root });

  const tarball = fs.readdirSync(tmp).find((file) => /^margin-agent-.*\.tgz$/.test(file));
  if (!tarball) throw new Error("release tarball was not produced");

  const prefix = path.join(tmp, "prefix");
  runNpm(["install", "-g", "--prefix", prefix, path.join(tmp, tarball)]);

  const pkgDir = [
    path.join(prefix, "node_modules", "margin-agent"),
    path.join(prefix, "lib", "node_modules", "margin-agent"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!pkgDir) throw new Error("npm global install did not create a margin-agent package directory");
  const installedManifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const shim =
    process.platform === "win32"
      ? path.join(prefix, "margin-agent.cmd")
      : path.join(prefix, "bin", "margin-agent");
  for (const required of [shim, path.join(pkgDir, "dist", "index.js")]) {
    if (!fs.existsSync(required)) throw new Error(`installed package is missing ${required}`);
  }

  const workspace = path.join(tmp, "ws");
  child = spawn(process.execPath, [path.join(pkgDir, "dist", "index.js"), workspace], {
    env: { ...process.env, MARGIN_NO_OPEN: "1", MARGIN_PORT: String(port), MARGIN_ENGINE: "pi" },
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
  const urlMatch = /UI:\s+(http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+)/i.exec(serverLog);
  if (!urlMatch) throw new Error(`token URL was not printed\n${serverLog}`);
  const url = new URL(urlMatch[1]);
  const token = url.hash.replace(/^#token=/, "");
  const capabilities = await fetch(`${url.origin}/api/v1/capabilities`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!capabilities.ok) throw new Error(`installed capabilities endpoint returned ${capabilities.status}`);
  const capabilityBody = await capabilities.json();
  if (capabilityBody.version !== installedManifest.version) {
    throw new Error(
      `installed capabilities version ${capabilityBody.version} does not match ${installedManifest.version}`,
    );
  }

  // Exercises write-file-atomic via llm-settings save (needs __filename in ESM bundle).
  const saveSettings = await fetch(`${url.origin}/api/v1/settings/llm`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: {
        apiFormat: "openai",
        authStyle: "bearer",
        baseURL: "https://example.com/v1",
        model: "install-smoke-model",
        apiKey: "sk-install-smoke",
      },
      reasoningOptIn: true,
    }),
  });
  if (!saveSettings.ok) {
    throw new Error(
      `installed llm-settings save returned ${saveSettings.status}: ${await saveSettings.text()}\n${serverLog}`,
    );
  }
  if (!fs.existsSync(path.join(workspace, ".margin", "llm-settings.json"))) {
    throw new Error("installed llm-settings save did not write .margin/llm-settings.json");
  }

  // Live Bearer chat against local mocks — catches "No API key for provider".
  await assertBearerChat({
    origin: url.origin,
    token,
    workspace,
    kind: "openai",
    apiKey: "sk-openai-smoke",
  });
  await assertBearerChat({
    origin: url.origin,
    token,
    workspace,
    kind: "anthropic",
    apiKey: "sk-anthropic-smoke",
  });

  console.log(`RELEASE_INSTALL_SMOKE_OK port=${port} tarball=${tarball}`);
} finally {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
