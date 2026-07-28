import {
  detectCcSwitchRoutes,
  isLoopbackBaseURL,
  probeCcSwitchHealth,
  saveLlmSettings,
  type CcSwitchRoutes,
  type LlmProviderProfile,
} from "@margin/storage-local";
import { marginRequestHeaders } from "@margin/llm";

export type CcSwitchRouteId = "claude" | "codex";

export type CcSwitchConnectDeps = {
  /** Override the CC Switch database path (tests). */
  dbPath?: string;
  /** Override fetch for the /health probe (tests). */
  fetchImpl?: typeof fetch;
};

export type CcSwitchDetectionSummary = {
  detected: boolean;
  routes: CcSwitchRoutes;
};

const ROUTE_LABEL: Record<CcSwitchRouteId, string> = {
  claude: "Claude",
  codex: "Codex",
};

const ROUTE_DEFAULT_MODEL: Record<CcSwitchRouteId, string> = {
  claude: "claude-sonnet-4-6",
  codex: "gpt-5-codex",
};

/** Detection summary for GET routes / settings payloads. Never carries secrets. */
export function ccSwitchDetectionSummary(dbPath?: string): CcSwitchDetectionSummary {
  const routes = detectCcSwitchRoutes(dbPath);
  return { detected: !!(routes.claude || routes.codex), routes };
}

/** Shape used for LlmSettingsPublic.ccSwitch. */
export function ccSwitchPublicInfo(dbPath?: string) {
  const { detected, routes } = ccSwitchDetectionSummary(dbPath);
  return {
    detected,
    proxyBaseURL: routes.claude?.baseURL ?? routes.codex?.baseURL,
    proxyEnabled: detected,
    routes: detected ? routes : undefined,
  };
}

function buildRouteProfile(route: CcSwitchRouteId, baseURL: string, model?: string): LlmProviderProfile {
  return {
    id: `cc-switch-${route}`,
    name: `CC Switch 本地代理（${ROUTE_LABEL[route]}）`,
    apiFormat: route === "claude" ? "anthropic" : "openai",
    baseURL,
    model: model?.trim() || ROUTE_DEFAULT_MODEL[route],
    authStyle: "bearer",
    source: "cc-switch",
    // No apiKey: the placeholder exists in memory only, after loopback validation.
  };
}

/**
 * Connect a CC Switch route transactionally: re-read the local database fresh
 * (never trusting a client-supplied detection payload), validate the loopback
 * target, probe /health, and only then persist the profile and make it active.
 * On any failure the existing settings store and process.env stay untouched.
 */
export async function connectCcSwitchRoute(
  root: string,
  route: CcSwitchRouteId,
  deps: CcSwitchConnectDeps = {},
): Promise<LlmProviderProfile> {
  const routes = detectCcSwitchRoutes(deps.dbPath);
  const detected = routes[route];
  if (!detected) {
    throw new Error(`未检测到可用的 CC Switch ${ROUTE_LABEL[route]} 路由`);
  }
  if (!isLoopbackBaseURL(detected.baseURL)) {
    throw new Error("CC Switch 代理地址不是回环地址，已拒绝连接");
  }
  const health = await probeCcSwitchHealth(detected.baseURL, {
    fetchImpl: deps.fetchImpl,
    headers: marginRequestHeaders(),
  });
  if (!health.ok) {
    throw new Error(`CC Switch 代理健康检查未通过：${health.detail}`);
  }
  const profile = buildRouteProfile(route, detected.baseURL, detected.model);
  const store = await saveLlmSettings(root, {
    provider: { ...profile, apiKey: "" },
  });
  return store.providers.find((p) => p.id === profile.id) ?? profile;
}
