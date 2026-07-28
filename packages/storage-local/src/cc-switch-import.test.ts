import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCcSwitchRoutes, probeCcSwitchHealth } from "./cc-switch-import.js";

const SENTINEL = "sk-sentinel-SECRET";

type ProxyRow = {
  app_type: "claude" | "codex";
  proxy_enabled?: number;
  enabled?: number;
  listen_address?: string | null;
  listen_port?: number | null;
};

function createFixtureDb(
  dbPath: string,
  rows: ProxyRow[],
  opts: { withProviders?: boolean; schemaOnly?: string } = {},
): void {
  const db = new DatabaseSync(dbPath);
  try {
    if (opts.schemaOnly) {
      // Old/incompatible schema: unrelated table, no proxy_config.
      db.exec(opts.schemaOnly);
      return;
    }
    db.exec(
      `CREATE TABLE proxy_config (
         app_type TEXT PRIMARY KEY,
         proxy_enabled INTEGER,
         enabled INTEGER,
         listen_address TEXT,
         listen_port INTEGER
       )`,
    );
    if (opts.withProviders !== false) {
      db.exec(
        `CREATE TABLE providers (
           id TEXT,
           app_type TEXT,
           name TEXT,
           settings_config TEXT,
           is_current INTEGER,
           sort_index INTEGER
         )`,
      );
      db.prepare(
        `INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "p1",
        "claude",
        "Upstream",
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://upstream.example.com",
            ANTHROPIC_AUTH_TOKEN: SENTINEL,
            ANTHROPIC_API_KEY: SENTINEL,
            OPENAI_API_KEY: SENTINEL,
          },
        }),
        1,
        0,
      );
    }
    const insert = db.prepare(
      `INSERT INTO proxy_config (app_type, proxy_enabled, enabled, listen_address, listen_port)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.app_type,
        row.proxy_enabled ?? 0,
        row.enabled ?? 0,
        row.listen_address ?? null,
        row.listen_port ?? null,
      );
    }
  } finally {
    db.close();
  }
}

describe("detectCcSwitchRoutes", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "margin-cc-switch-"));
    dbPath = path.join(dir, "cc-switch.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns no routes when the database file is missing", () => {
    expect(detectCcSwitchRoutes(dbPath)).toEqual({});
  });

  it("returns no routes for an old/incompatible schema", () => {
    createFixtureDb(dbPath, [], { schemaOnly: "CREATE TABLE meta (k TEXT)" });
    expect(detectCcSwitchRoutes(dbPath)).toEqual({});
  });

  it("returns no routes when the file is not a database", () => {
    fs.writeFileSync(dbPath, "not a sqlite database", "utf8");
    expect(detectCcSwitchRoutes(dbPath)).toEqual({});
  });

  it("detects a Claude-only loopback route", () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);
    const routes = detectCcSwitchRoutes(dbPath);
    expect(routes.claude).toEqual({ baseURL: "http://127.0.0.1:15721" });
    expect(routes.codex).toBeUndefined();
  });

  it("detects a Codex-only loopback route", () => {
    createFixtureDb(dbPath, [
      { app_type: "codex", enabled: 1, listen_address: "127.0.0.1", listen_port: 15722 },
    ]);
    const routes = detectCcSwitchRoutes(dbPath);
    expect(routes.codex).toEqual({ baseURL: "http://127.0.0.1:15722" });
    expect(routes.claude).toBeUndefined();
  });

  it("detects both routes when both proxies are enabled", () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
      { app_type: "codex", proxy_enabled: 1, listen_address: "localhost", listen_port: 15723 },
    ]);
    const routes = detectCcSwitchRoutes(dbPath);
    expect(routes.claude?.baseURL).toBe("http://127.0.0.1:15721");
    expect(routes.codex?.baseURL).toBe("http://localhost:15723");
  });

  it("omits routes whose proxy is disabled", () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 0, enabled: 0, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);
    expect(detectCcSwitchRoutes(dbPath)).toEqual({});
  });

  it("defaults the listen address and port when columns are null", () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: null, listen_port: null },
    ]);
    expect(detectCcSwitchRoutes(dbPath).claude?.baseURL).toBe("http://127.0.0.1:15721");
  });

  it("normalizes a wildcard bind address to loopback", () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "0.0.0.0", listen_port: 15721 },
    ]);
    expect(detectCcSwitchRoutes(dbPath).claude?.baseURL).toBe("http://127.0.0.1:15721");
  });

  it("rejects a specific non-loopback listen address", () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "192.168.1.10", listen_port: 15721 },
    ]);
    expect(detectCcSwitchRoutes(dbPath)).toEqual({});
  });

  it("never surfaces upstream tokens from the providers table", () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
      { app_type: "codex", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);
    const routes = detectCcSwitchRoutes(dbPath);
    expect(JSON.stringify(routes)).not.toContain(SENTINEL);
    expect(JSON.stringify(routes)).not.toContain("upstream.example.com");
  });
});

describe("probeCcSwitchHealth", () => {
  it("reports ok on a 2xx health response", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    const result = await probeCcSwitchHealth("http://127.0.0.1:15721", { fetchImpl });
    expect(result.ok).toBe(true);
  });

  it("fails on a non-2xx health response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const result = await probeCcSwitchHealth("http://127.0.0.1:15721", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("503");
  });

  it("fails cleanly when the proxy is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const result = await probeCcSwitchHealth("http://127.0.0.1:15721", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("无法连接");
  });

  it("never fetches a non-loopback target", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const result = await probeCcSwitchHealth("https://evil.example.com", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("maps timeouts to a timeout detail", async () => {
    const fetchImpl = (async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }) as typeof fetch;
    const result = await probeCcSwitchHealth("http://127.0.0.1:15721", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("超时");
  });
});
