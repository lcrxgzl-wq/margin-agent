import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeProfile,
  publicLlmSettings,
  readLlmSettingsStore,
  saveLlmSettings,
} from "@margin/storage-local";
import {
  ccSwitchDetectionSummary,
  ccSwitchPublicInfo,
  connectCcSwitchRoute,
} from "./cc-switch-connect.js";

const SENTINEL = "sk-sentinel-SECRET";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "MARGIN_API_KEY",
  "MARGIN_BASE_URL",
  "MARGIN_PROVIDER",
  "MARGIN_MODEL",
  "MARGIN_AUTH_STYLE",
  "MARGIN_API_FORMAT",
] as const;

type ProxyRow = {
  app_type: "claude" | "codex";
  proxy_enabled?: number;
  enabled?: number;
  listen_address?: string | null;
  listen_port?: number | null;
};

function createFixtureDb(dbPath: string, rows: ProxyRow[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      `CREATE TABLE proxy_config (
         app_type TEXT PRIMARY KEY,
         proxy_enabled INTEGER,
         enabled INTEGER,
         listen_address TEXT,
         listen_port INTEGER
       )`,
    );
    db.exec(
      `CREATE TABLE providers (
         id TEXT, app_type TEXT, name TEXT, settings_config TEXT,
         is_current INTEGER, sort_index INTEGER
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
          ANTHROPIC_AUTH_TOKEN: SENTINEL,
          ANTHROPIC_API_KEY: SENTINEL,
          OPENAI_API_KEY: SENTINEL,
        },
      }),
      1,
      0,
    );
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

const okFetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
const failingFetch = (async () =>
  new Response("unavailable", { status: 503 })) as typeof fetch;

describe("cc-switch connect flow", () => {
  let root: string;
  let dir: string;
  let dbPath: string;
  const prev = { ...process.env };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-cc-connect-root-"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "margin-cc-connect-db-"));
    dbPath = path.join(dir, "cc-switch.db");
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const settingsFile = () => path.join(root, ".margin", "llm-settings.json");

  it("summarizes detection without any secret material", () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);
    const summary = ccSwitchDetectionSummary(dbPath);
    expect(summary.detected).toBe(true);
    expect(summary.routes.claude?.baseURL).toBe("http://127.0.0.1:15721");
    expect(summary.routes.codex).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain(SENTINEL);

    const info = ccSwitchPublicInfo(dbPath);
    expect(info.proxyBaseURL).toBe("http://127.0.0.1:15721");
    expect(info.proxyEnabled).toBe(true);
    expect(JSON.stringify(info)).not.toContain(SENTINEL);
  });

  it("connects the Claude route and persists only source/protocol/model/endpoint", async () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);

    const profile = await connectCcSwitchRoute(root, "claude", { dbPath, fetchImpl: okFetch });

    expect(profile).toMatchObject({
      id: "cc-switch-claude",
      apiFormat: "anthropic",
      baseURL: "http://127.0.0.1:15721",
      model: "claude-sonnet-4-6",
      authStyle: "bearer",
      source: "cc-switch",
    });
    expect(profile.apiKey).toBeUndefined();

    const store = readLlmSettingsStore(root);
    expect(store.activeId).toBe("cc-switch-claude");
    expect(activeProfile(store).apiKey).toBeUndefined();

    // Secret sentinel must appear in no persisted file and no public payload.
    const fileText = fs.readFileSync(settingsFile(), "utf8");
    expect(fileText).not.toContain(SENTINEL);
    expect(fileText).not.toContain("PROXY_MANAGED");
    expect(JSON.stringify(publicLlmSettings(store))).not.toContain(SENTINEL);
    expect(JSON.stringify(profile)).not.toContain(SENTINEL);

    // Placeholder exists in memory after loopback validation.
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("PROXY_MANAGED");
    expect(process.env.MARGIN_BASE_URL).toBe("http://127.0.0.1:15721");
  });

  it("connects the Codex route over the OpenAI chat bridge format", async () => {
    createFixtureDb(dbPath, [
      { app_type: "codex", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);

    const profile = await connectCcSwitchRoute(root, "codex", { dbPath, fetchImpl: okFetch });

    expect(profile.apiFormat).toBe("openai");
    expect(profile.source).toBe("cc-switch");
    expect(profile.apiKey).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBe("PROXY_MANAGED");
    expect(fs.readFileSync(settingsFile(), "utf8")).not.toContain(SENTINEL);
  });

  it("leaves store and env untouched when the health probe fails", async () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);
    await saveLlmSettings(root, {
      provider: {
        id: "custom",
        apiFormat: "openai",
        baseURL: "https://working.example.com/v1",
        model: "model-a",
        authStyle: "bearer",
        apiKey: "working-key",
      },
    });
    const beforeText = fs.readFileSync(settingsFile(), "utf8");
    expect(process.env.OPENAI_API_KEY).toBe("working-key");

    await expect(
      connectCcSwitchRoute(root, "claude", { dbPath, fetchImpl: failingFetch }),
    ).rejects.toThrow(/健康检查/);

    expect(fs.readFileSync(settingsFile(), "utf8")).toBe(beforeText);
    expect(readLlmSettingsStore(root).activeId).toBe("custom");
    expect(process.env.OPENAI_API_KEY).toBe("working-key");
    expect(process.env.MARGIN_BASE_URL).toBe("https://working.example.com/v1");
  });

  it("rejects connecting a route the database does not offer", async () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);

    await expect(
      connectCcSwitchRoute(root, "codex", { dbPath, fetchImpl: okFetch }),
    ).rejects.toThrow(/未检测到/);
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.MARGIN_API_KEY).toBeUndefined();
  });

  it("rejects a non-loopback listen address instead of connecting to it", async () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "192.168.1.10", listen_port: 15721 },
    ]);
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await expect(
      connectCcSwitchRoute(root, "claude", { dbPath, fetchImpl }),
    ).rejects.toThrow(/未检测到/);
    expect(fetched).toBe(false);
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it("re-reads the database fresh instead of trusting earlier detection", async () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);
    expect(ccSwitchDetectionSummary(dbPath).detected).toBe(true);

    // CC Switch gets disabled between detection and connect.
    fs.rmSync(dbPath, { force: true });
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 0, enabled: 0, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);

    await expect(
      connectCcSwitchRoute(root, "claude", { dbPath, fetchImpl: okFetch }),
    ).rejects.toThrow(/未检测到/);
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it("sends the shared request-policy headers on the health probe", async () => {
    createFixtureDb(dbPath, [
      { app_type: "claude", proxy_enabled: 1, listen_address: "127.0.0.1", listen_port: 15721 },
    ]);
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seenHeaders = init?.headers;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await connectCcSwitchRoute(root, "claude", { dbPath, fetchImpl });

    expect(seenHeaders?.["User-Agent"]).toMatch(/^margin-agent\//);
    expect(seenHeaders?.["X-Client-Request-Id"]).toBeTruthy();
  });
});
