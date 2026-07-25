/**
 * Read-only import from local CC Switch (same machine).
 * Pattern: Claude tools → http://127.0.0.1:<port> proxy → switched upstream.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApiFormat } from "./provider-presets.js";
import type { LlmProviderProfile } from "./llm-settings.js";

export type CcSwitchProxyInfo = {
  enabled: boolean;
  listenAddress: string;
  listenPort: number;
  baseURL: string;
};

export type CcSwitchImportResult = {
  proxy?: CcSwitchProxyInfo;
  claudeModel?: string;
  providers: LlmProviderProfile[];
  source: string;
};

function home(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

function redactKey(key: string | undefined): string | undefined {
  const t = key?.trim();
  return t || undefined;
}

function parseClaudeEnv(settingsConfig: string): {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  authStyle: "bearer" | "apikey";
} {
  let cfg: { env?: Record<string, string> } = {};
  try {
    cfg = JSON.parse(settingsConfig || "{}");
  } catch {
    return { authStyle: "bearer" };
  }
  const env = cfg.env ?? {};
  const bearer = env.ANTHROPIC_AUTH_TOKEN?.trim();
  const apikey = env.ANTHROPIC_API_KEY?.trim();
  return {
    baseURL: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    apiKey: redactKey(bearer || apikey),
    model:
      env.ANTHROPIC_MODEL?.trim() ||
      env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() ||
      undefined,
    authStyle: bearer ? "bearer" : "apikey",
  };
}

export function detectCcSwitchProxy(): CcSwitchProxyInfo | undefined {
  const dbPath = home(".cc-switch", "cc-switch.db");
  if (!fs.existsSync(dbPath)) return undefined;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT proxy_enabled, enabled, listen_address, listen_port FROM proxy_config WHERE app_type = 'claude' LIMIT 1",
        )
        .get() as
        | {
            proxy_enabled: number;
            enabled: number;
            listen_address: string;
            listen_port: number;
          }
        | undefined;
      if (!row) return undefined;
      const enabled = !!(row.proxy_enabled || row.enabled);
      const listenAddress = row.listen_address || "127.0.0.1";
      const listenPort = Number(row.listen_port) || 15721;
      return {
        enabled,
        listenAddress,
        listenPort,
        baseURL: `http://${listenAddress}:${listenPort}`,
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** Import Claude-side providers + optional local proxy profile (CC Switch style). */
export function importFromCcSwitch(): CcSwitchImportResult {
  const dbPath = home(".cc-switch", "cc-switch.db");
  const claudeSettingsPath = home(".claude", "settings.json");
  const providers: LlmProviderProfile[] = [];
  let claudeModel: string | undefined;
  const proxy = detectCcSwitchProxy();

  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8")) as {
        model?: string;
        env?: Record<string, string>;
      };
      claudeModel =
        raw.env?.ANTHROPIC_DEFAULT_SONNET_MODEL ||
        raw.env?.ANTHROPIC_MODEL ||
        (typeof raw.model === "string" ? raw.model : undefined);
    } catch {
      /* ignore */
    }
  }

  if (proxy?.enabled) {
    providers.push({
      id: "cc-switch-proxy",
      name: "CC Switch 本地代理",
      apiFormat: "anthropic" satisfies ApiFormat,
      baseURL: proxy.baseURL,
      model: claudeModel || "claude-sonnet-4-6",
      apiKey: "PROXY_MANAGED",
      authStyle: "bearer",
      source: "cc-switch-proxy",
    });
  }

  if (!fs.existsSync(dbPath)) {
    return {
      proxy,
      claudeModel,
      providers,
      source: home(".cc-switch"),
    };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, name, settings_config, is_current, website_url
         FROM providers
         WHERE app_type = 'claude'
         ORDER BY is_current DESC, sort_index ASC`,
      )
      .all() as Array<{
      id: string;
      name: string;
      settings_config: string;
      is_current: number;
      website_url: string | null;
    }>;

    for (const row of rows) {
      const env = parseClaudeEnv(row.settings_config);
      if (!env.baseURL && !env.apiKey) continue;
      // Skip duplicate of proxy loopback
      if (
        env.baseURL &&
        /127\.0\.0\.1|localhost/i.test(env.baseURL) &&
        providers.some((p) => p.id === "cc-switch-proxy")
      ) {
        continue;
      }
      providers.push({
        id: `cc-${row.id}`,
        name: row.name || row.id,
        apiFormat: "anthropic",
        baseURL: env.baseURL || "",
        model: env.model || claudeModel || "claude-sonnet-4-6",
        apiKey: env.apiKey,
        authStyle: env.authStyle,
        source: "cc-switch",
        websiteUrl: row.website_url || undefined,
        currentInCcSwitch: !!row.is_current,
      });
    }
  } finally {
    db.close();
  }

  return {
    proxy,
    claudeModel,
    providers,
    source: dbPath,
  };
}
