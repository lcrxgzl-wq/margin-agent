#!/usr/bin/env node
/**
 * DOCX corpus gate — no API key required.
 * Expects: pnpm build already done OR run via `pnpm gate:docx`.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@margin/storage-local", "exec", "vitest", "run", "src/corpus.test.ts"],
  { cwd: root, stdio: "inherit", shell: true },
);
if (r.status !== 0) {
  console.error("DOCX_CORPUS_FAIL");
  process.exit(r.status ?? 1);
}
console.log("DOCX_CORPUS_OK");
