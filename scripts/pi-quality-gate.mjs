#!/usr/bin/env node
/**
 * Real pi quality gate. Requires API key.
 * Exit 0 = pass; exit 2 = skipped (no key); exit 1 = fail.
 *
 *   OPENAI_API_KEY=... pnpm gate:pi
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

/** Load BYOK from the repo workspace settings when env is empty (no secrets printed). */
function hydrateKeyFromWorkspaceSettings() {
  if (
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.MARGIN_API_KEY ||
    process.env.MARGIN_BASE_URL
  ) {
    return false;
  }
  const settingsPath = path.join(root, ".margin", "llm-settings.json");
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const store = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const active =
      (store.providers || []).find((p) => p.id === store.activeId) ||
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
        if (process.env.MARGIN_AUTH_STYLE === "bearer") {
          process.env.ANTHROPIC_AUTH_TOKEN = key;
        } else {
          process.env.ANTHROPIC_API_KEY = key;
        }
      } else {
        process.env.OPENAI_API_KEY = key;
      }
    }
    return true;
  } catch {
    return false;
  }
}

const hydratedFromWorkspace = hydrateKeyFromWorkspaceSettings();

const hasKey = !!(
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.MARGIN_API_KEY ||
  process.env.MARGIN_BASE_URL
);

if (!hasKey) {
  console.log("PI_GATE_SKIP: no API key (set OPENAI_API_KEY / ANTHROPIC_API_KEY / MARGIN_API_KEY)");
  process.exit(2);
}

const port = String(await freePort());
const { workspace, runtimeRoot } = createGateWorkspace(root, "margin-pi-gate-");
fs.mkdirSync(path.join(workspace, "fixtures"), { recursive: true });
fs.mkdirSync(path.join(workspace, ".margin"), { recursive: true });
fs.copyFileSync(
  path.join(root, "fixtures/agent-chapter.md"),
  path.join(workspace, "fixtures/agent-chapter.md"),
);
const repoSettings = path.join(root, ".margin", "llm-settings.json");
if (hydratedFromWorkspace && fs.existsSync(repoSettings)) {
  fs.copyFileSync(repoSettings, path.join(workspace, ".margin", "llm-settings.json"));
}

const child = spawn(
  process.execPath,
  [path.join(root, "apps/cli/dist/index.js"), workspace],
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
  const blockIds = opened.blocks.slice(0, 6).map((b) => b.id);
  const { runId } = await api(`/api/v1/documents/${opened.document.id}/proposal-runs`, {
    method: "POST",
    body: JSON.stringify({
      blockIds,
      instruction:
        "请至少选择其中两段提出实质性改写提案，每块最多一份；不要只写侧注。完成后立即 finish_turn。",
    }),
  });

  let run;
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    run = await api(`/api/v1/proposal-runs/${runId}`);
    if (run.status !== "running") break;
  }
  if (run?.status !== "done") {
    throw new Error(`run not done: ${JSON.stringify(run)}`);
  }
  if (run.engine !== "pi") {
    throw new Error(`expected engine=pi, got ${run.engine} (a started Pi run must not fall back)`);
  }
  if (!run.proposalIds?.length) {
    throw new Error(
      `pi produced zero proposals notes=${JSON.stringify(run.notes ?? [])} phase=${run.phase} steps=${JSON.stringify(run.steps ?? [])}`,
    );
  }

  const { proposals } = await api(
    `/api/v1/documents/${opened.document.id}/proposals?status=proposed`,
  );
  const risks = new Set(["language", "structure", "argument", "fact"]);
  for (const p of proposals) {
    if (!p.baseHash || !p.blockId || !p.after?.trim() || !p.rationale?.trim()) {
      throw new Error(`invalid proposal shape: ${p.id}`);
    }
    if (p.rationale.trim().length < 8) {
      throw new Error(`rationale too short on ${p.blockId}`);
    }
    if (p.risk && !risks.has(p.risk)) {
      throw new Error(`invalid risk on ${p.blockId}: ${p.risk}`);
    }
    if (p.after.trim() === p.before.trim()) {
      throw new Error(`noop proposal on ${p.blockId}`);
    }
    // Reject trivial punctuation-only edits
    const a = p.after.replace(/\s+/g, "");
    const b = p.before.replace(/\s+/g, "");
    if (a.length > 20 && Math.abs(a.length - b.length) < 2 && a.slice(0, 40) === b.slice(0, 40)) {
      throw new Error(`near-noop proposal on ${p.blockId}`);
    }
  }

  if (!Array.isArray(run.steps) || run.steps.length < 2) {
    throw new Error("pi run missing progress steps");
  }
  if (!run.phase) {
    throw new Error("pi run missing phase");
  }

  const { comments } = await api(`/api/v1/documents/${opened.document.id}/comments`);
  console.log(
    `PI_GATE_OK proposals=${proposals.length} comments=${comments.length} engine=${run.engine} steps=${run.steps.length}`,
  );
} catch (e) {
  console.error("PI_GATE_FAIL:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await stopChild(child);
  try {
    removeGateWorkspace(workspace, runtimeRoot);
  } catch {
    /* ignore */
  }
}
