import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { ApiFormat } from "./provider-presets.js";
import { PROVIDER_PRESETS } from "./provider-presets.js";

export type { ApiFormat } from "./provider-presets.js";
export { PROVIDER_PRESETS } from "./provider-presets.js";

export type AuthStyle = "bearer" | "apikey";

export type ReasoningMode = "auto" | "fast" | "standard" | "deep";

function normalizeReasoningMode(value: unknown): ReasoningMode | undefined {
  return value === "auto" || value === "fast" || value === "standard" || value === "deep"
    ? value
    : undefined;
}

export const AGENT_TIMEOUT_MIN_MS = 1_000;
export const AGENT_TIMEOUT_MAX_MS = 1_800_000;
export const RETRY_ATTEMPTS_MIN = 1;
export const RETRY_ATTEMPTS_MAX = 10;
export const RETRY_DELAY_MIN_MS = 0;
export const RETRY_DELAY_MAX_MS = 300_000;

function normalizeAgentTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= AGENT_TIMEOUT_MIN_MS &&
    value <= AGENT_TIMEOUT_MAX_MS
    ? value
    : undefined;
}

function normalizeRetryAttempts(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RETRY_ATTEMPTS_MIN &&
    value <= RETRY_ATTEMPTS_MAX
    ? value
    : undefined;
}

function normalizeRetryDelayMs(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RETRY_DELAY_MIN_MS &&
    value <= RETRY_DELAY_MAX_MS
    ? value
    : undefined;
}

export const SELECTION_CONTEXT_MIN_CHARS = 1_000;
export const SELECTION_CONTEXT_MAX_CHARS = 100_000;

function normalizeSelectionContextChars(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= SELECTION_CONTEXT_MIN_CHARS &&
    value <= SELECTION_CONTEXT_MAX_CHARS
    ? value
    : undefined;
}

export type ContextTier = "eco" | "standard" | "max";

function normalizeContextTier(value: unknown): ContextTier | undefined {
  return value === "eco" || value === "standard" || value === "max" ? value : undefined;
}

function normalizeCompactionAuto(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeUnlimitedRead(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

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
  /** Explicit opt-in to reasoning controls for a custom (non-builtin) provider. */
  reasoningOptIn?: boolean;
};

export type LlmSettingsStore = {
  activeId: string;
  providers: LlmProviderProfile[];
  /** Selected revision harness; undefined falls back to the default harness. */
  harnessId?: string;
  /** Product-level reasoning mode; default auto omits provider reasoning controls. */
  reasoningMode?: ReasoningMode;
  /** User-configured pi session timeout (ms); undefined falls back to env/profile. */
  agentTimeoutMs?: number;
  /** Total attempts for transient model transport/provider errors. */
  retryAttempts?: number;
  /** Fixed delay between transient model retries (ms). */
  retryDelayMs?: number;
  /** Custom inline selection cap (chars); undefined follows the context tier. */
  selectionContextChars?: number;
  /** Context budget tier; undefined falls back to the standard preset. */
  contextTier?: ContextTier;
  /** Automatic context compaction; undefined falls back to true (on). */
  compactionAuto?: boolean;
  /** Allow absolute-path reads outside the workspace; absent/undefined defaults ON. Writes stay closed. */
  unlimitedRead?: boolean;
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
  reasoningMode: ReasoningMode;
  /** Present only when the user configured an explicit pi session timeout. */
  agentTimeoutMs?: number;
  /** Present only when the user configured a transient-error attempt count. */
  retryAttempts?: number;
  /** Present only when the user configured a transient-error delay. */
  retryDelayMs?: number;
  /** Present only when the user configured a custom inline selection cap. */
  selectionContextChars?: number;
  /** Present only when the user configured an explicit context tier. */
  contextTier?: ContextTier;
  /** Present only when the user toggled automatic context compaction. */
  compactionAuto?: boolean;
  /** Present when toggled; absent means default ON. */
  unlimitedRead?: boolean;
  /** True when the process was started with --unlimited / MARGIN_UNLIMITED=1. */
  unlimitedReadFromEnv?: boolean;
  ccSwitch?: {
    detected: boolean;
    proxyBaseURL?: string;
    proxyEnabled?: boolean;
    routes?: {
      claude?: { baseURL: string; model?: string };
      codex?: { baseURL: string; model?: string };
    };
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
  reasoningOptIn?: boolean;
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
  if (
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.MARGIN_API_KEY
  ) {
    return true;
  }
  // Remote Base URLs alone are not credentials. Loopback may use a proxy placeholder.
  const base = process.env.MARGIN_BASE_URL?.trim();
  return !!(base && isLoopbackBaseURL(base));
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
  const baseURL = (p.baseURL || "").trim();
  // CC Switch placeholder semantics are loopback-only. A remote URL means the
  // user is talking to a real provider and must keep a persisted API key.
  const source =
    p.source === "cc-switch" && baseURL && !isLoopbackBaseURL(baseURL)
      ? "local"
      : p.source;
  return {
    id: (p.id || `p-${i}`).trim(),
    name: (p.name || p.id || `Provider ${i + 1}`).trim(),
    apiFormat,
    baseURL,
    model: (p.model || (apiFormat === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini")).trim(),
    // Loopback CC Switch routes never persist key material; placeholder is memory-only.
    apiKey:
      source === "cc-switch"
        ? undefined
        : typeof p.apiKey === "string"
          ? p.apiKey
          : undefined,
    authStyle:
      apiFormat === "openai" || p.authStyle === "bearer" ? "bearer" : "apikey",
    source,
    websiteUrl: p.websiteUrl,
    currentInCcSwitch: p.currentInCcSwitch,
    reasoningOptIn: p.reasoningOptIn === true ? true : undefined,
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

/** Placeholder credential for CC Switch routes: memory-only, loopback-only. */
export const CC_SWITCH_PLACEHOLDER_KEY = "PROXY_MANAGED";

/** True when baseURL points at a loopback host (127.0.0.0/8, localhost, ::1). */
export function isLoopbackBaseURL(baseURL: string): boolean {
  try {
    const url = new URL(baseURL.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1") return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
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
    const reasoningMode = normalizeReasoningMode(raw.reasoningMode);
    const agentTimeoutMs = normalizeAgentTimeoutMs(raw.agentTimeoutMs);
    const retryAttempts = normalizeRetryAttempts(raw.retryAttempts);
    const retryDelayMs = normalizeRetryDelayMs(raw.retryDelayMs);
    const selectionContextChars = normalizeSelectionContextChars(raw.selectionContextChars);
    const contextTier = normalizeContextTier(raw.contextTier);
    const compactionAuto = normalizeCompactionAuto(raw.compactionAuto);
    const unlimitedRead = normalizeUnlimitedRead(raw.unlimitedRead);
    return {
      activeId,
      providers,
      harnessId,
      reasoningMode,
      agentTimeoutMs,
      retryAttempts,
      retryDelayMs,
      selectionContextChars,
      contextTier,
      compactionAuto,
      unlimitedRead,
    };
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

  // CC Switch profiles carry no persisted key; inject the placeholder in
  // memory only when the target is loopback (defense in depth).
  const key =
    profile.source === "cc-switch"
      ? isLoopbackBaseURL(profile.baseURL)
        ? CC_SWITCH_PLACEHOLDER_KEY
        : undefined
      : profile.apiKey?.trim();
  if (key) {
    process.env.MARGIN_API_KEY = key;
    if (profile.apiFormat === "anthropic") {
      // Bearer proxies authenticate via Authorization only. Setting
      // ANTHROPIC_API_KEY would make the SDK also emit x-api-key.
      if (profile.authStyle === "bearer") {
        process.env.ANTHROPIC_AUTH_TOKEN = key;
      } else {
        process.env.ANTHROPIC_API_KEY = key;
      }
    } else {
      process.env.OPENAI_API_KEY = key;
    }
  }
}

function profilePublic(p: LlmProviderProfile): LlmProviderProfilePublic {
  const key = p.apiKey?.trim() ?? "";
  const proxyManaged = p.source === "cc-switch" && isLoopbackBaseURL(p.baseURL);
  return {
    id: p.id,
    name: p.name,
    apiFormat: p.apiFormat,
    baseURL: p.baseURL,
    model: p.model,
    authStyle: p.authStyle,
    apiKeySet: !!key || proxyManaged,
    apiKeyHint: key ? maskKey(key) : proxyManaged ? "由 CC Switch 代理管理" : "",
    source: p.source,
    websiteUrl: p.websiteUrl,
    currentInCcSwitch: p.currentInCcSwitch,
    reasoningOptIn: p.reasoningOptIn === true ? true : undefined,
  };
}

export function publicLlmSettings(
  store: LlmSettingsStore,
  ccSwitch?: LlmSettingsPublic["ccSwitch"],
): LlmSettingsPublic {
  const active = activeProfile(store);
  const keySet =
    !!active.apiKey?.trim() ||
    (active.source === "cc-switch" && isLoopbackBaseURL(active.baseURL)) ||
    hasRuntimeKey();
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
    reasoningMode: store.reasoningMode ?? "auto",
    agentTimeoutMs: store.agentTimeoutMs,
    retryAttempts: store.retryAttempts,
    retryDelayMs: store.retryDelayMs,
    selectionContextChars: store.selectionContextChars,
    contextTier: store.contextTier,
    compactionAuto: store.compactionAuto,
    unlimitedRead: store.unlimitedRead,
    unlimitedReadFromEnv: process.env.MARGIN_UNLIMITED === "1",
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
  /** Set the product reasoning mode; null/unknown resets to auto. */
  reasoningMode?: ReasoningMode | null;
  /** Set the pi session timeout in ms (1000-1800000); null clears back to default. */
  agentTimeoutMs?: number | null;
  /** Set total transient-error attempts (1-10); null clears back to 5. */
  retryAttempts?: number | null;
  /** Set retry delay in ms (0-300000); null clears back to 30000. */
  retryDelayMs?: number | null;
  /** Set the inline selection cap in chars (1000-100000); null follows the context tier. */
  selectionContextChars?: number | null;
  /** Set the context tier (eco/standard/max); null clears back to the default. */
  contextTier?: ContextTier | null;
  /** Set automatic context compaction; null clears back to the default (on). */
  compactionAuto?: boolean | null;
  /** Set unlimited external reads; null clears back to the default (off). */
  unlimitedRead?: boolean | null;
};

export async function writeLlmSettingsStore(
  root: string,
  store: LlmSettingsStore,
): Promise<LlmSettingsStore> {
  const abs = settingsPath(root);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const retryAttempts = normalizeRetryAttempts(store.retryAttempts);
  if (store.retryAttempts !== undefined && retryAttempts === undefined) {
    throw new Error("retryAttempts 必须是 1–10 之间的整数");
  }
  const retryDelayMs = normalizeRetryDelayMs(store.retryDelayMs);
  if (store.retryDelayMs !== undefined && retryDelayMs === undefined) {
    throw new Error("retryDelayMs 必须是 0–300000 之间的整数毫秒");
  }
  const normalized: LlmSettingsStore = {
    activeId: store.activeId,
    harnessId: store.harnessId,
    reasoningMode: store.reasoningMode,
    agentTimeoutMs: store.agentTimeoutMs,
    retryAttempts,
    retryDelayMs,
    selectionContextChars: store.selectionContextChars,
    contextTier: store.contextTier,
    compactionAuto: store.compactionAuto,
    unlimitedRead: store.unlimitedRead,
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
    if (
      next.baseURL &&
      !isLoopbackBaseURL(next.baseURL) &&
      !next.apiKey?.trim()
    ) {
      const explicitlyCleared = input.clearApiKey === true || patch.apiKey === "";
      if (!explicitlyCleared) {
        throw new Error("远程 API 地址必须填写并保存 API Key。CC Switch 占位密钥仅用于本机 127.0.0.1 代理。");
      }
    }

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

  if (input.reasoningMode !== undefined) {
    store = { ...store, reasoningMode: normalizeReasoningMode(input.reasoningMode) };
  }

  if (input.agentTimeoutMs !== undefined) {
    if (input.agentTimeoutMs === null) {
      store = { ...store, agentTimeoutMs: undefined };
    } else {
      const agentTimeoutMs = normalizeAgentTimeoutMs(input.agentTimeoutMs);
      if (agentTimeoutMs === undefined) {
        throw new Error("agentTimeoutMs 必须是 1000–1800000 之间的整数毫秒");
      }
      store = { ...store, agentTimeoutMs };
    }
  }

  if (input.retryAttempts !== undefined) {
    if (input.retryAttempts === null) {
      store = { ...store, retryAttempts: undefined };
    } else {
      const retryAttempts = normalizeRetryAttempts(input.retryAttempts);
      if (retryAttempts === undefined) {
        throw new Error("retryAttempts 必须是 1–10 之间的整数");
      }
      store = { ...store, retryAttempts };
    }
  }

  if (input.retryDelayMs !== undefined) {
    if (input.retryDelayMs === null) {
      store = { ...store, retryDelayMs: undefined };
    } else {
      const retryDelayMs = normalizeRetryDelayMs(input.retryDelayMs);
      if (retryDelayMs === undefined) {
        throw new Error("retryDelayMs 必须是 0–300000 之间的整数毫秒");
      }
      store = { ...store, retryDelayMs };
    }
  }

  if (input.selectionContextChars !== undefined) {
    if (input.selectionContextChars === null) {
      store = { ...store, selectionContextChars: undefined };
    } else {
      const selectionContextChars = normalizeSelectionContextChars(input.selectionContextChars);
      if (selectionContextChars === undefined) {
        throw new Error("selectionContextChars 必须是 1000–100000 之间的整数");
      }
      store = { ...store, selectionContextChars };
    }
  }

  if (input.contextTier !== undefined) {
    if (input.contextTier === null) {
      store = { ...store, contextTier: undefined };
    } else {
      const contextTier = normalizeContextTier(input.contextTier);
      if (contextTier === undefined) {
        throw new Error("contextTier 必须是 eco / standard / max");
      }
      store = { ...store, contextTier };
    }
  }

  if (input.compactionAuto !== undefined) {
    if (input.compactionAuto === null) {
      store = { ...store, compactionAuto: undefined };
    } else {
      const compactionAuto = normalizeCompactionAuto(input.compactionAuto);
      if (compactionAuto === undefined) {
        throw new Error("compactionAuto 必须是布尔值");
      }
      store = { ...store, compactionAuto };
    }
  }

  if (input.unlimitedRead !== undefined) {
    if (input.unlimitedRead === null) {
      store = { ...store, unlimitedRead: undefined };
    } else {
      const unlimitedRead = normalizeUnlimitedRead(input.unlimitedRead);
      if (unlimitedRead === undefined) {
        throw new Error("unlimitedRead 必须是布尔值");
      }
      store = { ...store, unlimitedRead };
    }
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
      source: preset.id === "cc-switch-proxy" ? "cc-switch" : "preset",
      apiKey:
        apiKey?.trim() ||
        (preset.id === "cc-switch-proxy" ? undefined : existing?.apiKey),
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

/** Effective unlimited-read gate. Default ON; settings or MARGIN_UNLIMITED=0 can turn it off. Writes stay closed. */
export function isUnlimitedReadEnabled(root: string): boolean {
  if (process.env.MARGIN_UNLIMITED === "0") return false;
  if (process.env.MARGIN_UNLIMITED === "1") return true;
  return readLlmSettingsStore(root).unlimitedRead !== false;
}

export function defaultLlmSettings(): LlmSettings {
  return { provider: "openai", model: "gpt-4o-mini" };
}
