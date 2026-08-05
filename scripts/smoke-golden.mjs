#!/usr/bin/env node
/**
 * Golden-path smoke: temp workspace + local CLI → open → propose → Y → apply → export.
 * Uses MARGIN_ENGINE=simple for deterministic offline CI (pi path covered by unit tests).
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

const { workspace, runtimeRoot } = createGateWorkspace(root, "margin-smoke-");
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
  const url = new URL(await waitForCliUrl(child, output, 20_000));
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

  const caps = await api("/api/v1/capabilities");
  if (caps.preferredEngine !== "pi") throw new Error("preferredEngine must be pi");

  const opened = await api("/api/v1/documents/open", {
    method: "POST",
    body: JSON.stringify({ relativePath: "fixtures/agent-chapter.md" }),
  });
  const { runId } = await api(`/api/v1/documents/${opened.document.id}/proposal-runs`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  let run;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 200));
    run = await api(`/api/v1/proposal-runs/${runId}`);
    if (run.status !== "running") break;
  }
  if (run.status !== "done") throw new Error(JSON.stringify(run));
  if (run.engine !== "simple") throw new Error(`expected simple engine, got ${run.engine}`);
  if (run.commentCount !== 0) throw new Error("automatic heuristic comments must stay disabled");

  const { runs: checklistsBeforeAsk } = await api(
    `/api/v1/documents/${opened.document.id}/checklists`,
  );
  if (checklistsBeforeAsk?.length) {
    throw new Error(`scan must not auto-inject checklists, got ${JSON.stringify(checklistsBeforeAsk)}`);
  }

  await api("/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({ message: "检查引用和语体风格" }),
  });
  let checklists;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const payload = await api(`/api/v1/documents/${opened.document.id}/checklists`);
    checklists = payload.runs;
    if (checklists?.length) break;
  }
  const checkerNames = checklists?.map((entry) => entry.run.checker).sort();
  if (JSON.stringify(checkerNames) !== JSON.stringify(["cite_check", "style_lint"])) {
    throw new Error(`expected cite/style checklists after ask, got ${JSON.stringify(checkerNames)}`);
  }
  const citeRun = checklists.find((entry) => entry.run.checker === "cite_check");
  if (!citeRun?.run.disclaimer.includes("形态学通过 ≠ 文献真实存在")) {
    throw new Error("citation verification boundary is missing");
  }

  const { proposals } = await api(
    `/api/v1/documents/${opened.document.id}/proposals?status=proposed`,
  );
  if (!proposals?.length) throw new Error("no proposals");
  await api(`/api/v1/proposals/${proposals[0].id}/decision`, {
    method: "PATCH",
    body: JSON.stringify({ kind: "Y" }),
  });
  await api(`/api/v1/documents/${opened.document.id}/apply`, {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: opened.document.revision,
      expectedHash: opened.document.contentHash,
      proposalIds: [proposals[0].id],
    }),
  });
  const { runs: activeAfterApply } = await api(
    `/api/v1/documents/${opened.document.id}/checklists`,
  );
  if (activeAfterApply.length) throw new Error("applied document change must supersede checklists");
  await api(`/api/v1/documents/${opened.document.id}/exports`);
  console.log("GOLDEN_PATH_OK");
} finally {
  await stopChild(child);
  try {
    removeGateWorkspace(workspace, runtimeRoot);
  } catch {
    /* ignore */
  }
}
