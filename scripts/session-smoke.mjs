// Live-server smoke for chat-session management:
// turn -> new -> listed -> switch back -> history restored -> delete/clear semantics.
// Usage: node scripts/session-smoke.mjs "E:\path\to\file.docx"
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDocx = process.argv[2];
if (!sourceDocx || !fs.existsSync(sourceDocx)) {
  console.error("usage: node scripts/session-smoke.mjs <docx>");
  process.exit(2);
}

const checks = [];
const check = (name, condition, detail = "") => {
  checks.push({ name, ok: Boolean(condition) });
  console.log(`  ${condition ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForUrl(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`CLI did not print URL. Log:\n${buffer}`)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = /(https?:\/\/\S+#token=\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => {
      buffer += chunk;
    });
  });
}

const port = await freePort();
for (const entry of fs.readdirSync(repoRoot)) {
  if (entry.startsWith(".tmp-session-ws-")) {
    fs.rmSync(path.join(repoRoot, entry), { recursive: true, force: true });
  }
}
const workspace = fs.mkdtempSync(path.join(repoRoot, ".tmp-session-ws-"));
fs.copyFileSync(sourceDocx, path.join(workspace, path.basename(sourceDocx)));

const child = spawn(process.execPath, [path.join(repoRoot, "apps/cli/dist/index.js"), workspace], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MARGIN_PORT: String(port),
    MARGIN_NO_OPEN: "1",
    MARGIN_ENGINE: "simple",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    MARGIN_API_KEY: "",
    MARGIN_BASE_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

try {
  const url = await waitForUrl(child);
  const parsed = new URL(url);
  const token = parsed.hash.replace(/^#token=/, "");
  const baseUrl = parsed.origin;
  const api = async (route, init = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const post = (route, body = {}) => api(route, { method: "POST", body: JSON.stringify(body) });

  console.log("\n== 1. One chat turn (offline docx import) creates a session");
  const docxPath = path.join(workspace, path.basename(sourceDocx));
  const turn = await post("/api/v1/chat", { message: `"${docxPath}"` });
  check("chat turn succeeds", turn.status === 200 && turn.body.opened?.document, turn.body.error ?? "");
  const openedDocumentId = turn.body.opened?.document?.id;

  let sessions = (await api("/api/v1/sessions")).body;
  check("no history yet", sessions.sessions?.length === 0);
  check("current session id present", typeof sessions.currentSessionId === "string");
  const firstSessionId = sessions.currentSessionId;

  console.log("\n== 2. 新会话 archives the current conversation");
  const fresh = await post("/api/v1/sessions/new");
  check("new returns session payload", fresh.status === 200 && fresh.body.chat && "review" in fresh.body);
  check("new session keeps the document open", fresh.body.opened?.document?.id === openedDocumentId);
  check("new session chat is empty", fresh.body.chat?.turns?.length === 0);
  sessions = (await api("/api/v1/sessions")).body;
  check("history lists the archived session", sessions.sessions?.length === 1);
  check(
    "history entry has title + turns",
    sessions.sessions?.[0]?.title?.length > 0 && sessions.sessions?.[0]?.turnCount >= 2,
    sessions.sessions?.[0]?.title,
  );
  check("current moved to a new id", sessions.currentSessionId !== firstSessionId);

  console.log("\n== 3. Switch restores the archived conversation");
  const unknown = await post("/api/v1/sessions/switch", { sessionId: "no-such-session" });
  check("unknown session -> 404", unknown.status === 404);
  const restored = await post("/api/v1/sessions/switch", { sessionId: firstSessionId });
  check("switch returns session payload", restored.status === 200 && restored.body.chat);
  check(
    "switched back to the first session",
    restored.body.chat?.turns?.length >= 2 && restored.body.opened?.document?.id === openedDocumentId,
    `turns=${restored.body.chat?.turns?.length}`,
  );
  sessions = (await api("/api/v1/sessions")).body;
  check("current is the restored session", sessions.currentSessionId === firstSessionId);
  check(
    "empty second session was not archived",
    sessions.sessions?.length === 1 && sessions.sessions?.[0]?.sessionId === firstSessionId,
  );

  console.log("\n== 4. Delete + clear semantics");
  const delCurrent = await api(`/api/v1/sessions/${firstSessionId}`, { method: "DELETE" });
  check("deleting the current session -> 409", delCurrent.status === 409);
  // Archive current again so there is a deletable history row.
  await post("/api/v1/sessions/new");
  sessions = (await api("/api/v1/sessions")).body;
  const historyId = sessions.sessions?.[0]?.sessionId;
  const deleted = await api(`/api/v1/sessions/${historyId}`, { method: "DELETE" });
  check("delete history row ok", deleted.status === 200 && deleted.body?.ok === true);
  sessions = (await api("/api/v1/sessions")).body;
  check("history empty after delete", sessions.sessions?.length === 0);

  // Back on the archived session, clear must remove its history row too.
  await post("/api/v1/sessions/switch", { sessionId: firstSessionId });
  await post("/api/v1/sessions/new"); // re-archive firstSessionId
  await post("/api/v1/sessions/switch", { sessionId: firstSessionId });
  const cleared = await post("/api/v1/chat/clear");
  check("clear ok", cleared.status === 200 && cleared.body?.ok === true);
  sessions = (await api("/api/v1/sessions")).body;
  check("cleared session does not linger in history", sessions.sessions?.length === 0);

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* Windows may briefly retain SQLite handles. */
  }
}
