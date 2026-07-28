/**
 * Read-only CC Switch detection (same machine).
 *
 * Margin connects THROUGH the CC Switch loopback proxy so users can use their
 * CC Switch subscription without Margin ever seeing upstream tokens. This
 * module therefore:
 *  - reads ONLY the `proxy_config` table (never the `providers` table, whose
 *    settings_config env blob carries upstream tokens);
 *  - returns ONLY loopback targets (127.0.0.0/8, localhost, ::1); wildcard
 *    bind addresses (0.0.0.0 / ::) are normalized to 127.0.0.1 and any other
 *    non-loopback listen address rejects the route;
 *  - probes <loopback>/health with a short timeout before a route is saved.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isLoopbackBaseURL } from "./llm-settings.js";

export type CcSwitchRoute = {
  /** Guaranteed loopback http(s) base URL, e.g. http://127.0.0.1:15721 */
  baseURL: string;
  /** Model name only when it lives outside the provider env blob; usually undefined. */
  model?: string;
};

export type CcSwitchRoutes = {
  claude?: CcSwitchRoute;
  codex?: CcSwitchRoute;
};

export type CcSwitchHealthResult = {
  ok: boolean;
  detail: string;
};

const DEFAULT_DB_PATH = () => path.join(os.homedir(), ".cc-switch", "cc-switch.db");
const HEALTH_TIMEOUT_MS = 5_000;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isWildcardHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "0.0.0.0" || host === "::" || host === "";
}

/**
 * Normalize a CC Switch listen address/port to a loopback base URL.
 * Returns undefined for listen addresses that are neither loopback nor a
 * wildcard bind (a specific non-loopback address means the proxy is not
 * reachable via loopback — the route must not be offered).
 */
function loopbackBaseURL(
  listenAddress: string | null | undefined,
  listenPort: number | null | undefined,
): string | undefined {
  const port = Number(listenPort) || 15721;
  if (port <= 0 || port > 65535) return undefined;
  const address = (listenAddress ?? "").trim();
  if (!address || isWildcardHost(address)) return `http://127.0.0.1:${port}`;
  if (!isLoopbackHost(address)) return undefined;
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  const printable = host.includes(":") ? `[${host}]` : host;
  return `http://${printable}:${port}`;
}

type ProxyConfigRow = {
  proxy_enabled: number | null;
  enabled: number | null;
  listen_address: string | null;
  listen_port: number | null;
};

function readRoute(db: DatabaseSync, appType: "claude" | "codex"): CcSwitchRoute | undefined {
  const row = db
    .prepare(
      "SELECT proxy_enabled, enabled, listen_address, listen_port FROM proxy_config WHERE app_type = ? LIMIT 1",
    )
    .get(appType) as ProxyConfigRow | undefined;
  if (!row) return undefined;
  if (!(row.proxy_enabled || row.enabled)) return undefined;
  const baseURL = loopbackBaseURL(row.listen_address, row.listen_port);
  if (!baseURL) return undefined;
  return { baseURL };
}

/**
 * Detect available CC Switch routes from the local database.
 * Missing file, old/incompatible schema, or disabled proxies all yield an
 * empty/partial result — never a throw, never any credential material.
 */
export function detectCcSwitchRoutes(dbPath: string = DEFAULT_DB_PATH()): CcSwitchRoutes {
  if (!fs.existsSync(dbPath)) return {};
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return {};
  }
  try {
    const routes: CcSwitchRoutes = {};
    const claude = readRoute(db, "claude");
    if (claude) routes.claude = claude;
    const codex = readRoute(db, "codex");
    if (codex) routes.codex = codex;
    return routes;
  } catch {
    // Old/incompatible schema (missing table/columns) — treat as undetected.
    return {};
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Probe the CC Switch loopback proxy health endpoint. Never fetches a
 * non-loopback target, so an in-memory placeholder credential can never be
 * sent off-machine by this path.
 */
export async function probeCcSwitchHealth(
  baseURL: string,
  opts: {
    fetchImpl?: typeof fetch;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<CcSwitchHealthResult> {
  if (!isLoopbackBaseURL(baseURL)) {
    return { ok: false, detail: "CC Switch 代理地址必须是回环地址" };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const target = `${baseURL.replace(/\/+$/, "")}/health`;
  try {
    const res = await fetchImpl(target, {
      method: "GET",
      redirect: "manual",
      headers: opts.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain a bounded amount so the socket can be reused/closed cleanly.
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore body errors */
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, detail: `健康检查通过（HTTP ${res.status}）` };
    }
    return { ok: false, detail: `健康检查失败（HTTP ${res.status}）` };
  } catch (e) {
    if (
      e instanceof Error &&
      (e.name === "AbortError" || e.name === "TimeoutError")
    ) {
      return { ok: false, detail: `健康检查超时（${timeoutMs}ms）` };
    }
    return { ok: false, detail: "无法连接 CC Switch 本地代理" };
  }
}
