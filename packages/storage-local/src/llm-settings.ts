import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { ApiFormat } from "./provider-presets.js";
import { PROVIDER_PRESETS } from "./provider-presets.js";

export type { ApiFormat } from "./provider-presets.js";
export { PROVIDER_PRESETS } from "./provider-presets.js";

export type AuthStyle = "bearer" | "apikey";

export type LlmProviderProfile = {
  id: string;
  name: string;
  apiFormat: ApiFormat;
  baseURL: string;
  model: string;
  apiKey?: string;
  authStyle: AuthStyle;
  source?: string;
  websiteUrl?: string;
  currentInCcSwitch?: boolean;
};

export type LlmSettingsStore = {
  activeId: string;
  providers: LlmProviderProfile[];
  /** Selected revision harness; undefined falls back to the default harness. */
  harnessId?: string;
};

/** @deprecated flat shape — migrated on read */
export type LlmSettings = {
  provider: "openai" | "anthropic";
  model: string;
  apiKey?: string;
  baseURL?: string;
};

export type LlmSettingsPublic = {
  activeId: string;
  provider: LlmProviderProfilePublic | null;
  providers: LlmProviderProfilePublic[];
  presets: Array<{
    id: string;
    name: string;
    apiFormat: ApiFormat;
    baseURL: string;
    model: string;
    authStyle: AuthStyle;
    hint?: string;
    websiteUrl?: string;
  }>;
  llmMode: "mock" | "byok";
  harnessId?: string;
  ccSwitch?: {
    detected: boolean;
    proxyBaseURL?: string;
    proxyEnabled?: boolean;
  };
};

export type LlmProviderProfilePublic = {
  id: string;
  name: string;
  apiFormat: ApiFormat;
  baseURL: string;
  model: string;
  authStyle: AuthStyle;
  apiKeySet: boolean;
  apiKeyHint: string;
  source?: string;
  websiteUrl?: string;
  currentInCcSwitch?: boolean;
};

const FILE = "llm-settings.json";

function settingsPath(root: string): string {
  return path.join(root, ".margin", FILE);
}

function maskKey(key: string): string {
  const t = key.trim();
  if (!t) return "";
  if (t === "PROXY_MANAGED") return "PROXY_MANAGED";
  if (t.length <= 8) return "••••••••";
  return `${t.slice(0, 3)}…${t.slice(-4)}`;
}

function hasRuntimeKey(): boolean {
  return !!(
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.MARGIN_API_KEY ||
    process.env.MARGIN_BASE_URL
  );
}

function defaultStore(): LlmSettingsStore {
  const apiFormat: ApiFormat =
    (process.env.MARGIN_API_FORMAT || process.env.MARGIN_PROVIDER || "").toLowerCase() ===
    "anthropic"
      ? "anthropic"
      : "openai";
  const model =
    process.env.MARGIN_MODEL?.trim() ||
    (apiFormat === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini");
  return {
    activeId: "custom",
    providers: [
      {
        id: "custom",
        name: "自定义",
        apiFormat,
        baseURL: process.env.MARGIN_BASE_URL?.trim() || "",
        model,
        authStyle:
          apiFormat === "openai" || process.env.MARGIN_AUTH_STYLE === "bearer"
            ? "bearer"
            : "apikey",
        source: "environment",
      },
    ],
  };
}

function migrateFlat(raw: Record<string, unknown>): LlmSettingsStore | null {
  if (Array.isArray(raw.providers)) return null;
  const provider = raw.provider === "anthropic" ? "anthropic" : "openai";
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "gpt-4o-mini";
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : undefined;
  const baseURL = typeof raw.baseURL === "string" ? raw.baseURL.trim() : "";
  const id = "migrated";
  return {
    activeId: id,
    providers: [
      {
        id,
        name: provider === "anthropic" ? "Anthropic" : "OpenAI",
        apiFormat: provider,
        baseURL,
        model,
        apiKey,
        authStyle:
          provider === "openai" || (provider === "anthropic" && baseURL)
            ? "bearer"
            : "apikey",
        source: "migrated",
      },
    ],
  };
}

function normalizeProfile(p: Partial<LlmProviderProfile>, i: number): LlmProviderProfile {
  const apiFormat: ApiFormat = p.apiFormat === "anthropic" ? "anthropic" : "openai";
  return {
    id: (p.id || `p-${i}`).trim(),
    name: (p.name || p.id || `Provider ${i + 1}`).trim(),
    apiFormat,
    baseURL: (p.baseURL || "").trim(),
    model: (p.model || (apiFormat === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini")).trim(),
    apiKey: typeof p.apiKey === "string" ? p.apiKey : undefined,
    authStyle:
      apiFormat === "openai" || p.authStyle === "bearer" ? "bearer" : "apikey",
    source: p.source,
    websiteUrl: p.websiteUrl,
    currentInCcSwitch: p.currentInCcSwitch,
  };
}

function normalizedProviderTarget(baseURL: string, apiFormat: ApiFormat): string {
  const trimmed = baseURL.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    let pathname = url.pathname
      .replace(/\/+$/, "")
      .replace(/\/(?:v1\/messages|chat\/completions|responses|models|messages)$/i, "")
      .replace(/\/+$/, "");
    if (apiFormat === "anthropic" || apiFormat === "openai") {
      pathname = pathname.replace(/\/v1$/i, "");
    }
    url.pathname = pathname || "/";
    return pathname ? url.toString().replace(/\/$/, "") : url.origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function validateProviderBaseURL(baseURL: string): void {
  const trimmed = baseURL.trim();
  if (!trimmed) return;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Base URL 格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL 仅支持 http(s)");
  }
  if (url.username || url.password) {
    throw new Error("Base URL 不得包含用户名或密码");
  }
  if (url.search || url.hash) {
    throw new Error("Base URL 不得包含查询参数或片段");
  }
}

export function readLlmSettingsStore(root: string): LlmSettingsStore {
  const abs = settingsPath(root);
  if (!fs.existsSync(abs)) return defaultStore();
  try {
    const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
    const migrated = migrateFlat(raw);
    if (migrated) return migrated;
    const providers = (Array.isArray(raw.providers) ? raw.providers : [])
      .map((p, i) => normalizeProfile(p as Partial<LlmProviderProfile>, i))
      .filter((p) => p.id);
    if (!providers.length) return defaultStore();
    const activeId =
      typeof raw.activeId === "string" && providers.some((p) => p.id === raw.activeId)
        ? raw.activeId
        : providers[0].id;
    const harnessId =
      typeof raw.harnessId === "string" && raw.harnessId.trim()
        ? raw.harnessId.trim()
        : undefined;
    return { activeId, providers, harnessId };
  } catch {
    return defaultStore();
  }
}

/** Back-compat: active profile as flat settings. */
export function readLlmSettings(root: string): LlmSettings {
  const store = readLlmSettingsStore(root);
  const active = store.providers.find((p) => p.id === store.activeId) ?? store.providers[0];
  return {
    provider: active.apiFormat,
    model: active.model,
    apiKey: active.apiKey,
    baseURL: active.baseURL || undefined,
  };
}

export function activeProfile(store: LlmSettingsStore): LlmProviderProfile {
  return store.providers.find((p) => p.id === store.activeId) ?? store.providers[0];
}

export function applyLlmSettings(settings: LlmSettings): void {
  applyProfile({
    id: "flat",
    name: "flat",
    apiFormat: settings.provider,
    baseURL: settings.baseURL ?? "",
    model: settings.model,
    apiKey: settings.apiKey,
    authStyle:
      settings.provider === "openai" || settings.baseURL ? "bearer" : "apikey",
  });
}

export function applyProfile(profile: LlmProviderProfile): void {
  process.env.MARGIN_PROVIDER = profile.apiFormat;
  process.env.MARGIN_API_FORMAT = profile.apiFormat;
  process.env.MARGIN_MODEL = profile.model;
  process.env.MARGIN_AUTH_STYLE = profile.authStyle;

  if (profile.baseURL.trim()) {
    process.env.MARGIN_BASE_URL = profile.baseURL.trim();
  } else {
    delete process.env.MARGIN_BASE_URL;
  }

  delete process.env.MARGIN_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  const key = profile.apiKey?.trim();
  if (key) {
    process.env.MARGIN_API_KEY = key;
    if (profile.apiFormat === "anthropic") {
      process.env.ANTHROPIC_API_KEY = key;
      if (profile.authStyle === "bearer") {
        process.env.ANTHROPIC_AUTH_TOKEN = key;
      }
    } else {
      process.env.OPENAI_API_KEY = key;
    }
  }
}

function profilePublic(p: LlmProviderProfile): LlmProviderProfilePublic {
  const key = p.apiKey?.trim() ?? "";
  return {
    id: p.id,
    name: p.name,
    apiFormat: p.apiFormat,
    baseURL: p.baseURL,
    model: p.model,
    authStyle: p.authStyle,
    apiKeySet: !!key,
    apiKeyHint: key ? maskKey(key) : "",
    source: p.source,
    websiteUrl: p.websiteUrl,
    currentInCcSwitch: p.currentInCcSwitch,
  };
}

export function publicLlmSettings(
  store: LlmSettingsStore,
  ccSwitch?: LlmSettingsPublic["ccSwitch"],
): LlmSettingsPublic {
  const active = activeProfile(store);
  const keySet = !!active.apiKey?.trim() || !!active.baseURL.trim() || hasRuntimeKey();
  return {
    activeId: store.activeId,
    provider: profilePublic(active),
    providers: store.providers.map(profilePublic),
    presets: PROVIDER_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      apiFormat: p.apiFormat,
      baseURL: p.baseURL,
      model: p.model,
      authStyle: p.authStyle,
      hint: p.hint,
      websiteUrl: p.websiteUrl,
    })),
    llmMode: keySet ? "byok" : "mock",
    harnessId: store.harnessId,
    ccSwitch,
  };
}

export type SaveLlmSettingsInput = {
  activeId?: string;
  provider?: Partial<LlmProviderProfile> & { id?: string };
  /** Replace entire provider list (e.g. after CC Switch import). */
  providers?: LlmProviderProfile[];
  clearApiKey?: boolean;
  /** Set to a harness id, or null/"" to clear back to the default harness. */
  harnessId?: string | null;
};

export async function writeLlmSettingsStore(
  root: string,
  store: LlmSettingsStore,
): Promise<LlmSettingsStore> {
  const abs = settingsPath(root);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const normalized: LlmSettingsStore = {
    activeId: store.activeId,
    harnessId: store.harnessId,
    providers: store.providers.map((p, i) => {
      validateProviderBaseURL(p.baseURL || "");
      return normalizeProfile(p, i);
    }),
  };
  if (!normalized.providers.some((p) => p.id === normalized.activeId)) {
    normalized.activeId = normalized.providers[0]?.id ?? "custom";
  }
  await writeFileAtomic(abs, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  applyProfile(activeProfile(normalized));
  return normalized;
}

export async function saveLlmSettings(
  root: string,
  input: SaveLlmSettingsInput,
): Promise<LlmSettingsStore> {
  let store = readLlmSettingsStore(root);

  if (input.providers?.length) {
    store = { ...store,
      activeId: input.activeId || input.providers[0].id,
      providers: input.providers.map((p, i) => {
        validateProviderBaseURL(p.baseURL || "");
        return normalizeProfile(p, i);
      }),
    };
  }

  if (input.provider || input.clearApiKey) {
    const patch = input.provider ?? {};
    const id = (patch.id || store.activeId || "custom").trim();
    const idx = store.providers.findIndex((p) => p.id === id);
    const prev =
      idx >= 0
        ? store.providers[idx]
        : {
            id,
            name: patch.name || id,
            apiFormat: "openai" as ApiFormat,
            baseURL: "",
            model: "gpt-4o-mini",
            authStyle: "bearer" as AuthStyle,
            source: "local",
          };

    if (patch.baseURL !== undefined) validateProviderBaseURL(patch.baseURL);

    let apiKey = prev.apiKey;
    const targetChanged =
      (patch.apiFormat ?? prev.apiFormat) !== prev.apiFormat ||
      (patch.authStyle ?? prev.authStyle) !== prev.authStyle ||
      normalizedProviderTarget(
        patch.baseURL ?? prev.baseURL,
        patch.apiFormat ?? prev.apiFormat,
      ) !== normalizedProviderTarget(prev.baseURL, prev.apiFormat);
    if (targetChanged && prev.apiKey && typeof patch.apiKey !== "string") {
      throw new Error("更换 API 地址或协议时，必须输入新 Key 或明确移除旧 Key");
    }
    if (input.clearApiKey || patch.apiKey === "") {
      apiKey = undefined;
    } else if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
      apiKey = patch.apiKey.trim();
    }

    const next = normalizeProfile(
      {
        ...prev,
        ...patch,
        id,
        apiKey,
        baseURL: patch.baseURL !== undefined ? patch.baseURL : prev.baseURL,
      },
      idx >= 0 ? idx : store.providers.length,
    );

    if (idx >= 0) store.providers[idx] = next;
    else store.providers.push(next);
    store.activeId = id;
  }

  if (input.activeId && store.providers.some((p) => p.id === input.activeId)) {
    store.activeId = input.activeId;
  }

  if (input.harnessId !== undefined) {
    const harnessId =
      typeof input.harnessId === "string" && input.harnessId.trim()
        ? input.harnessId.trim()
        : undefined;
    store = { ...store, harnessId };
  }

  return writeLlmSettingsStore(root, store);
}

/** Apply preset fields onto active/custom provider (does not invent keys). */
export async function applyPreset(
  root: string,
  presetId: string,
  apiKey?: string,
): Promise<LlmSettingsStore> {
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown preset: ${presetId}`);
  const store = readLlmSettingsStore(root);
  const id = preset.id === "custom" ? store.activeId || "custom" : preset.id;
  const existing = store.providers.find((p) => p.id === id);
  return saveLlmSettings(root, {
    provider: {
      id,
      name: preset.name,
      apiFormat: preset.apiFormat,
      baseURL: preset.baseURL,
      model: preset.model,
      authStyle: preset.authStyle,
      source: "preset",
      apiKey:
        apiKey?.trim() ||
        (preset.id === "cc-switch-proxy" ? "PROXY_MANAGED" : existing?.apiKey),
    },
  });
}

export function loadAndApplyLlmSettings(root: string): LlmSettingsStore {
  const hasSettingsFile = fs.existsSync(settingsPath(root));
  const store = readLlmSettingsStore(root);
  if (!hasSettingsFile) return store;
  const active = activeProfile(store);
  applyProfile(active);
  return store;
}

export function defaultLlmSettings(): LlmSettings {
  return { provider: "openai", model: "gpt-4o-mini" };
}
