export type LlmApiFormat = "openai" | "anthropic";
export type LlmAuthStyle = "bearer" | "apikey";

export type LlmProviderProbeInput = {
  apiFormat: LlmApiFormat;
  baseURL: string;
  apiKey?: string;
  authStyle?: LlmAuthStyle;
};

export type LlmModelProbeInput = LlmProviderProbeInput & {
  model: string;
};

export type LlmModelOption = {
  id: string;
  name: string;
};

export type LlmProbeResult = {
  ok: boolean;
  models: LlmModelOption[];
  latencyMs: number;
  detail: string;
  /** Canonical API base that handled the successful request. */
  resolvedBaseURL?: string;
};

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 500;
const MAX_MODEL_ID_LENGTH = 200;
const TIMEOUT_MS = 10_000;

class SafeProbeError extends Error {}

class HttpProbeError extends SafeProbeError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function elapsed(started: number): number {
  return Math.max(0, Date.now() - started);
}

function failure(started: number, detail: string): LlmProbeResult {
  return { ok: false, models: [], latencyMs: elapsed(started), detail };
}

function safeFailure(started: number, error: unknown): LlmProbeResult {
  if (error instanceof SafeProbeError) return failure(started, error.message);
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return failure(started, `请求超时（${TIMEOUT_MS}ms）`);
  }
  return failure(started, "无法连接 API 端点");
}

function parseBaseURL(raw: string): URL {
  const value = raw.trim();
  if (!value) throw new SafeProbeError("请填写 Base URL");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeProbeError("Base URL 格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeProbeError("Base URL 仅支持 http(s)");
  }
  if (url.username || url.password) {
    throw new SafeProbeError("Base URL 不得包含用户名或密码");
  }
  if (url.search || url.hash) {
    throw new SafeProbeError("Base URL 不得包含查询参数或片段");
  }
  return url;
}

export function canonicalizeProviderBaseURL(
  baseURL: string,
  apiFormat: LlmApiFormat,
): string {
  const url = parseBaseURL(baseURL);
  let path = url.pathname.replace(/\/+$/, "");

  path = path.replace(/\/(?:models|chat\/completions|responses)$/i, "");
  if (apiFormat === "anthropic") {
    path = path.replace(/\/v1\/messages$/i, "");
    path = path.replace(/\/messages$/i, "");
    path = path.replace(/\/v1$/i, "");
  }
  path = path.replace(/\/+$/, "");
  url.pathname = path || "/";

  return path ? url.toString().replace(/\/$/, "") : url.origin;
}

function endpointURL(
  input: LlmProviderProbeInput,
  operation: "models" | "messages" | "chat/completions",
): string {
  const url = new URL(canonicalizeProviderBaseURL(input.baseURL, input.apiFormat));
  const path = url.pathname.replace(/\/+$/, "");
  const suffix = `/${operation}`;

  if (path.endsWith(suffix)) {
    url.pathname = path;
  } else if (input.apiFormat === "anthropic" && !path.endsWith("/v1")) {
    url.pathname = `${path}/v1${suffix}`;
  } else {
    url.pathname = `${path}${suffix}`;
  }
  return url.toString();
}

function openAIV1FallbackURL(
  input: LlmProviderProbeInput,
  operation: "models" | "chat/completions",
): string | undefined {
  const url = new URL(canonicalizeProviderBaseURL(input.baseURL, input.apiFormat));
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1") || path.endsWith(`/${operation}`)) return undefined;
  url.pathname = `${path}/v1/${operation}`;
  return url.toString();
}

function requestHeaders(input: LlmProviderProbeInput): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = input.apiKey?.trim();

  if (input.apiFormat === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) {
      if (input.authStyle === "bearer") headers.Authorization = `Bearer ${key}`;
      else headers["x-api-key"] = key;
    }
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new SafeProbeError("API 响应超过 1MiB 限制");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new SafeProbeError("API 响应超过 1MiB 限制");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const text = await readLimitedText(response);
  if (!text) throw new SafeProbeError("API 返回了空响应");
  try {
    return JSON.parse(text);
  } catch {
    throw new SafeProbeError("API 未返回有效 JSON");
  }
}

function redactRemoteDetail(value: string, apiKey?: string): string {
  let detail = value.replace(/[\r\n\t]+/g, " ").trim();
  const key = apiKey?.trim();
  if (key) detail = detail.split(key).join("[redacted]");
  detail = detail.replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]");
  return detail.slice(0, 320);
}

function remoteErrorSummary(payload: unknown, apiKey?: string): string | undefined {
  const root = asRecord(payload);
  const nested = asRecord(root?.error);
  const rawMessage =
    nested?.message ??
    (typeof root?.error === "string" ? root.error : undefined) ??
    root?.message;
  const rawCode = nested?.code ?? root?.code;
  const message =
    typeof rawMessage === "string" ? redactRemoteDetail(rawMessage, apiKey) : "";
  const code =
    typeof rawCode === "string" || typeof rawCode === "number"
      ? redactRemoteDetail(String(rawCode), apiKey)
      : "";
  return [code, message].filter(Boolean).join(" · ") || undefined;
}

async function readRemoteError(response: Response, apiKey?: string): Promise<string | undefined> {
  const text = await readLimitedText(response);
  if (!text.trim()) return undefined;
  try {
    return remoteErrorSummary(JSON.parse(text), apiKey);
  } catch {
    return undefined;
  }
}

function statusFailure(
  format: LlmApiFormat,
  status: number,
  endpoint: string,
  remoteDetail?: string,
): SafeProbeError {
  const provider = format === "anthropic" ? "Anthropic" : "OpenAI";
  const pathname = new URL(endpoint).pathname;
  const suffix = remoteDetail ? `：${remoteDetail}` : "";
  return new HttpProbeError(
    `${provider} 请求失败（HTTP ${status} · ${pathname}）${suffix}`,
    status,
  );
}

type ProviderJsonResult = {
  payload: unknown;
  resolvedBaseURL: string;
};

async function requestJson(
  input: LlmProviderProbeInput,
  url: string,
  init: Omit<RequestInit, "headers" | "signal" | "redirect">,
  signal: AbortSignal,
): Promise<ProviderJsonResult> {
  const headers = requestHeaders(input);
  if (init.body) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "manual",
    signal,
  });
  if (!response.ok) {
    const remoteDetail = await readRemoteError(response, input.apiKey);
    throw statusFailure(input.apiFormat, response.status, url, remoteDetail);
  }
  return {
    payload: await readLimitedJson(response),
    resolvedBaseURL: canonicalizeProviderBaseURL(url, input.apiFormat),
  };
}

async function requestProviderJson(
  input: LlmProviderProbeInput,
  operation: "models" | "messages" | "chat/completions",
  init: Omit<RequestInit, "headers" | "signal" | "redirect">,
  signal: AbortSignal,
): Promise<ProviderJsonResult> {
  try {
    return await requestJson(input, endpointURL(input, operation), init, signal);
  } catch (error) {
    const fallbackURL =
      input.apiFormat === "openai" && operation !== "messages"
        ? openAIV1FallbackURL(input, operation)
        : undefined;
    if (
      !(error instanceof HttpProbeError) ||
      (error.status !== 404 && error.status !== 405) ||
      !fallbackURL
    ) {
      throw error;
    }
    return requestJson(input, fallbackURL, init, signal);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseModels(payload: unknown): LlmModelOption[] {
  const root = asRecord(payload);
  const candidates = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models)
      ? root.models
      : Array.isArray(payload)
        ? payload
        : [];
  const seen = new Set<string>();
  const models: LlmModelOption[] = [];

  for (const candidate of candidates) {
    const record = asRecord(candidate);
    const rawId = typeof candidate === "string" ? candidate : record?.id;
    if (typeof rawId !== "string") continue;
    const id = rawId.trim();
    if (!id || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    const rawName = record?.display_name ?? record?.name;
    const name =
      typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 200) : id;
    seen.add(id);
    models.push({ id, name });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

export async function discoverLlmModels(
  input: LlmProviderProbeInput,
): Promise<LlmProbeResult> {
  const started = Date.now();
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await requestProviderJson(input, "models", { method: "GET" }, signal);
    const models = parseModels(response.payload);
    if (!models.length) return failure(started, "API 未返回可用模型");
    return {
      ok: true,
      models,
      latencyMs: elapsed(started),
      detail: `已发现 ${models.length} 个模型`,
      resolvedBaseURL: response.resolvedBaseURL,
    };
  } catch (error) {
    return safeFailure(started, error);
  }
}

function hasOpenAICompletion(payload: unknown): boolean {
  const choices = asRecord(payload)?.choices;
  if (!Array.isArray(choices) || !choices.length) return false;
  return choices.some((choice) => {
    const record = asRecord(choice);
    if (!record) return false;
    if (typeof record.text === "string" && record.text.trim()) return true;
    const content = asRecord(record.message)?.content;
    if (typeof content === "string") return !!content.trim();
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      const item = asRecord(part);
      return (
        !!item &&
        (item.type === undefined || item.type === "text" || item.type === "output_text") &&
        typeof item.text === "string" &&
        !!item.text.trim()
      );
    });
  });
}

function hasAnthropicContent(payload: unknown): boolean {
  const content = asRecord(payload)?.content;
  return (
    Array.isArray(content) &&
    content.some((part) => {
      const item = asRecord(part);
      return item?.type === "text" && typeof item.text === "string" && !!item.text.trim();
    })
  );
}

export async function testLlmModelConnection(
  input: LlmModelProbeInput,
): Promise<LlmProbeResult> {
  const started = Date.now();
  const model = input.model.trim();
  if (!model || model.length > MAX_MODEL_ID_LENGTH) {
    return failure(started, "请选择有效模型");
  }

  try {
    const isAnthropic = input.apiFormat === "anthropic";
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await requestProviderJson(
      input,
      isAnthropic ? "messages" : "chat/completions",
      {
        method: "POST",
        body: JSON.stringify(
          isAnthropic
            ? {
                model,
                max_tokens: 256,
                messages: [{ role: "user", content: "Reply with exactly: ok" }],
              }
            : {
                model,
                max_tokens: 256,
                messages: [{ role: "user", content: "Reply with exactly: ok" }],
              },
        ),
      },
      signal,
    );
    const valid = isAnthropic
      ? hasAnthropicContent(response.payload)
      : hasOpenAICompletion(response.payload);
    if (!valid) return failure(started, "API 响应格式与所选协议不匹配");
    return {
      ok: true,
      models: [],
      latencyMs: elapsed(started),
      detail: "模型连接成功",
      resolvedBaseURL: response.resolvedBaseURL,
    };
  } catch (error) {
    return safeFailure(started, error);
  }
}
