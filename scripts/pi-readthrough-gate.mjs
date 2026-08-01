#!/usr/bin/env node
/**
 * Real Pi read-through gate. Requires API credentials and a built CLI.
 * Exit 0 = pass; exit 2 = skipped (no key); exit 1 = fail.
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
const sourceDocument = path.join(root, "imports", "sport value.docx");
const repoSettings = path.join(root, ".margin", "llm-settings.json");

function hydrateKeyFromWorkspaceSettings() {
  if (
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.MARGIN_API_KEY ||
    process.env.MARGIN_BASE_URL
  ) return false;
  if (!fs.existsSync(repoSettings)) return false;
  try {
    const store = JSON.parse(fs.readFileSync(repoSettings, "utf8"));
    const active =
      (store.providers || []).find((provider) => provider.id === store.activeId) ||
      (store.providers || [])[0];
    if (!active) return false;
    const key = typeof active.apiKey === "string" ? active.apiKey.trim() : "";
    const base = typeof active.baseURL === "string" ? active.baseURL.trim() : "";
    const format = active.apiFormat === "anthropic" ? "anthropic" : "openai";
    process.env.MARGIN_PROVIDER = format;
    process.env.MARGIN_API_FORMAT = format;
    if (active.model) process.env.MARGIN_MODEL = String(active.model);
    if (base) process.env.MARGIN_BASE_URL = base;
    process.env.MARGIN_AUTH_STYLE =
      format === "anthropic" && base ? "bearer" : active.authStyle || "apikey";
    if (key) {
      process.env.MARGIN_API_KEY = key;
      if (format === "anthropic") {
        if (process.env.MARGIN_AUTH_STYLE === "bearer") process.env.ANTHROPIC_AUTH_TOKEN = key;
        else process.env.ANTHROPIC_API_KEY = key;
      } else {
        process.env.OPENAI_API_KEY = key;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function simulatedNextCursor(blocks, cursor, rawLimit) {
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (!match) throw new Error(`invalid audited cursor: ${cursor}`);
  let blockIndex = Number(match[1]);
  let textStart = Number(match[2]);
  const limit = Number(rawLimit ?? 12);
  let chunks = 0;
  let usedChars = 0;
  while (blockIndex < blocks.length && chunks < limit && usedChars < 24_000) {
    const block = blocks[blockIndex];
    const available = 24_000 - usedChars;
    const textEnd = Math.min(block.text.length, textStart + available);
    usedChars += textEnd - textStart;
    chunks += 1;
    if (textEnd < block.text.length) {
      textStart = textEnd;
      break;
    }
    blockIndex += 1;
    textStart = 0;
  }
  return blockIndex < blocks.length ? `${blockIndex}:${textStart}` : null;
}

const hydratedFromWorkspace = hydrateKeyFromWorkspaceSettings();
const hasKey = Boolean(
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.MARGIN_API_KEY ||
  process.env.MARGIN_BASE_URL,
);
if (!hasKey) {
  console.log("PI_READTHROUGH_SKIP: no API key");
  process.exit(2);
}
if (!fs.existsSync(sourceDocument)) {
  console.error("PI_READTHROUGH_FAIL: imports/sport value.docx is missing");
  process.exit(1);
}

const port = String(await freePort());
const { workspace, runtimeRoot } = createGateWorkspace(root, "margin-readthrough-gate-");
fs.mkdirSync(path.join(workspace, "imports"), { recursive: true });
fs.mkdirSync(path.join(workspace, ".margin"), { recursive: true });
fs.copyFileSync(sourceDocument, path.join(workspace, "imports", "sport value.docx"));
if (hydratedFromWorkspace && fs.existsSync(repoSettings)) {
  fs.copyFileSync(repoSettings, path.join(workspace, ".margin", "llm-settings.json"));
}

const child = spawn(
  process.execPath,
  [path.join(root, "apps", "cli", "dist", "index.js"), workspace],
  {
    cwd: root,
    env: {
      ...process.env,
      MARGIN_PORT: port,
      MARGIN_NO_OPEN: "1",
      MARGIN_ENGINE: "pi",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const output = collectCliOutput(child);

try {
  const url = new URL(await waitForCliUrl(child, output));
  const base = url.origin;
  const token = url.hash.replace(/^#token=/, "");
  const api = async (route, init = {}) => {
    const response = await fetch(`${base}${route}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${route} ${JSON.stringify(data)}`);
    return data;
  };

  const opened = await api("/api/v1/documents/open", {
    method: "POST",
    body: JSON.stringify({ relativePath: "imports/sport value.docx" }),
  });
  if (!opened.blocks?.length) throw new Error("long DOCX opened with zero blocks");
  const result = await api("/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({
      documentId: opened.document.id,
      message: "请从头到尾读一遍这篇文稿，完整覆盖后概括结构与核心论点；不要抽样，不要改稿。",
    }),
  });
  if (result.engine !== "pi") throw new Error(`expected engine=pi, got ${result.engine}`);
  if (!result.reply?.trim() || result.reply.trim().length < 120) {
    throw new Error(`read-through reply is missing or too short: ${JSON.stringify(result.reply)}`);
  }
  if (/pi session aborted|stopped after \d+ turns/i.test(result.reply)) {
    throw new Error(`read-through surfaced a hard abort: ${result.reply.slice(-300)}`);
  }

  const transcripts = await api("/api/v1/chat/transcripts?limit=1");
  const payload = transcripts.transcripts?.[0]?.payload ?? {};
  const audit = Array.isArray(payload.toolAudit) ? payload.toolAudit : [];
  const names = audit.map((event) => event.toolName);
  if (!names.includes("get_document_outline")) {
    throw new Error(`outline tool missing: ${JSON.stringify(names)}`);
  }
  if (names.includes("read_workspace_file")) {
    throw new Error("opened document was paged through read_workspace_file");
  }
  const reads = audit.filter((event) => event.toolName === "read_document_blocks");
  if (!reads.length) throw new Error(`read_document_blocks missing: ${JSON.stringify(names)}`);
  if (reads.some((event) => event.status !== "completed")) {
    throw new Error(`read_document_blocks did not complete: ${JSON.stringify(reads)}`);
  }

  const cursors = reads.map((event) => String(event.args?.cursor ?? "0:0"));
  if (cursors[0] !== "0:0") throw new Error(`read-through did not start at 0:0: ${cursors[0]}`);
  if (new Set(cursors).size !== cursors.length) {
    throw new Error(`read-through repeated a cursor: ${JSON.stringify(cursors)}`);
  }
  for (let index = 0; index < reads.length; index += 1) {
    const expectedNext = simulatedNextCursor(
      opened.blocks,
      cursors[index],
      reads[index].args?.limit,
    );
    const actualNext = cursors[index + 1] ?? null;
    if (expectedNext !== actualNext) {
      throw new Error(
        `cursor chain broke after ${cursors[index]}: expected ${expectedNext}, got ${actualNext}`,
      );
    }
  }
  if (!names.includes("finish_turn")) {
    throw new Error(`finish_turn missing: ${JSON.stringify(names)}`);
  }
  if ((payload.notes ?? []).some((note) => /stopped after/i.test(note))) {
    throw new Error(`read-through stopped early: ${JSON.stringify(payload.notes)}`);
  }

  console.log(
    `PI_READTHROUGH_OK blocks=${opened.blocks.length} reads=${reads.length} cursors=${cursors.join(" -> ")} replyChars=${result.reply.length}`,
  );
} catch (error) {
  console.error("PI_READTHROUGH_FAIL:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await stopChild(child);
  try {
    removeGateWorkspace(workspace, runtimeRoot);
  } catch {
    /* ignore */
  }
}
