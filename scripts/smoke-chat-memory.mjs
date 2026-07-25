#!/usr/bin/env node
/**
 * Offline chat short-memory smoke (no API key).
 * Exit 0 = CHAT_MEMORY_OK
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectCliOutput,
  createGateWorkspace,
  freePort,
  removeGateWorkspace,
  stopChild,
  waitForCliUrl,
} from "./gate-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = String(await freePort());
const { workspace, runtimeRoot } = createGateWorkspace(root, "margin-chat-mem-");
fs.mkdirSync(path.join(workspace, "fixtures"), { recursive: true });
fs.copyFileSync(
  path.join(root, "fixtures/agent-chapter.md"),
  path.join(workspace, "fixtures/agent-chapter.md"),
);

const child = spawn(
  process.execPath,
  [path.join(root, "apps/cli/dist/index.js"), workspace],
  {
    cwd: root,
    env: {
      ...process.env,
      MARGIN_PORT: port,
      MARGIN_NO_OPEN: "1",
      MARGIN_ENGINE: "simple",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const output = collectCliOutput(child);

try {
  const url = new URL(await waitForCliUrl(child, output));
  const base = url.origin;
  const token = url.hash.replace(/^#token=/, "");
  const api = async (p, opts = {}) => {
    const r = await fetch(`${base}${p}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(opts.headers || {}),
      },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p} ${JSON.stringify(data)}`);
    return data;
  };

  const opened = await api("/api/v1/documents/open", {
    method: "POST",
    body: JSON.stringify({ relativePath: "fixtures/agent-chapter.md" }),
  });

  const first = await api("/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({
      message: "讨论：文献对话太薄，点名多于对话",
      documentId: opened.document.id,
      selectionText: "既有研究较少讨论执行张力",
    }),
  });
  if (!/文献对话|问题意识|材料/i.test(first.reply)) {
    throw new Error(`unexpected first reply: ${first.reply.slice(0, 120)}`);
  }

  const who = await api("/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({ message: "你是谁" }),
  });
  if (!/Margin|边注/i.test(who.reply) || /请先打开一篇文章/i.test(who.reply)) {
    throw new Error(`identity not agent-like: ${who.reply.slice(0, 160)}`);
  }

  const second = await api("/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({
      message: "展开刚才那点，怎么落到材料上",
      documentId: opened.document.id,
    }),
  });
  if (!/文献对话太薄|结合刚才/i.test(second.reply)) {
    throw new Error(`memory not used: ${second.reply.slice(0, 160)}`);
  }

  const hist = await api("/api/v1/chat/history");
  if (!hist.turns?.length || hist.turns.length < 2) {
    throw new Error("history empty");
  }

  await api("/api/v1/chat/clear", { method: "POST", body: "{}" });
  const cleared = await api("/api/v1/chat/history");
  if (cleared.turns?.length) throw new Error("clear failed");

  console.log("CHAT_MEMORY_OK");
} catch (e) {
  console.error("CHAT_MEMORY_FAIL:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await stopChild(child);
  try {
    removeGateWorkspace(workspace, runtimeRoot);
  } catch {
    /* ignore */
  }
}
