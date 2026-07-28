import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, Zap } from "lucide-react";
import {
  connectCcSwitchRoute,
  discoverLlmModels,
  getLlmSettings,
  saveLlmSettings,
  testLlmConnection,
  type LlmModelDiscoveryResult,
  type LlmProbeResult,
  type LlmSettingsPublic,
} from "../../api";
import {
  completionEndpoint,
  defaultAuthStyle,
  normalizeBaseUrlForFormat,
} from "../../providerDraft";

type Props = {
  open: boolean;
  onSaved?: (settings: LlmSettingsPublic) => void;
  onClose: () => void;
  onCloseLocked?: (locked: boolean) => void;
};

type ApiFormat = "openai" | "anthropic";
type AuthStyle = "bearer" | "apikey";
type Operation = "load" | "discover" | "test" | "save" | null;
type ModelMode = "manual" | "list";
type CcRoute = "claude" | "codex";

const DEFAULT_URL: Record<ApiFormat, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

const DEFAULT_MODEL: Record<ApiFormat, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-6",
};

const CC_ROUTE_LABEL: Record<CcRoute, string> = {
  claude: "Claude（Anthropic Messages）",
  codex: "Codex（OpenAI Chat 桥接）",
};

function normalizedUrl(value: string, format: ApiFormat): string {
  return normalizeBaseUrlForFormat(value, format).replace(/\/+$/, "");
}

function isSafeBaseURL(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function ProbeResult({ label, result, detail }: {
  label: string;
  result: LlmProbeResult;
  detail?: string;
}) {
  return (
    <div
      className={`settings-result ${result.ok ? "ok" : "err"}`}
      role={result.ok ? "status" : "alert"}
      aria-live="polite"
    >
      <strong>{result.ok ? `${label}成功` : `${label}失败`}</strong>
      <span className="settings-latency">{result.latencyMs} ms</span>
      <span className="settings-result-detail">{detail || result.detail}</span>
    </div>
  );
}

export function ModelTab({ open, onSaved, onClose, onCloseLocked }: Props) {
  const [data, setData] = useState<LlmSettingsPublic | null>(null);
  const [apiFormat, setApiFormat] = useState<ApiFormat>("openai");
  const [authStyle, setAuthStyle] = useState<AuthStyle>("bearer");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [removeSavedKey, setRemoveSavedKey] = useState(false);
  const [reasoningOptIn, setReasoningOptIn] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelMode, setModelMode] = useState<ModelMode>("manual");
  const [operation, setOperation] = useState<Operation>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<LlmModelDiscoveryResult | null>(null);
  const [testResult, setTestResult] = useState<LlmProbeResult | null>(null);
  const [ccConnecting, setCcConnecting] = useState<CcRoute | null>(null);
  const [ccError, setCcError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const invalidateConnection = () => {
    requestSequence.current += 1;
    setModels([]);
    setModelMode("manual");
    setDiscovery(null);
    setTestResult(null);
    setError(null);
  };

  const hydrate = (settings: LlmSettingsPublic) => {
    const provider = settings.provider;
    const format = provider?.apiFormat ?? "openai";
    setData(settings);
    setApiFormat(format);
    setAuthStyle(format === "openai" ? "bearer" : (provider?.authStyle ?? "apikey"));
    setBaseURL(provider?.baseURL ?? "");
    setModel(settings.llmMode === "byok" ? (provider?.model ?? "") : "");
    setReasoningOptIn(provider?.reasoningOptIn === true);
    setApiKey("");
    setRemoveSavedKey(false);
    setModels([]);
    setModelMode("manual");
    setDiscovery(null);
    setTestResult(null);
    setCcError(null);
  };

  useEffect(() => {
    if (!open) {
      requestSequence.current += 1;
      return;
    }
    let active = true;
    const requestId = ++requestSequence.current;
    setOperation("load");
    setLoadError(null);
    setError(null);
    void getLlmSettings()
      .then((settings) => {
        if (active && requestId === requestSequence.current) hydrate(settings);
      })
      .catch((reason) => {
        if (active && requestId === requestSequence.current) {
          setLoadError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (active && requestId === requestSequence.current) setOperation(null);
      });
    return () => {
      active = false;
    };
  }, [open]);

  // Saving locks dialog close (Escape / close button stay safe while writing).
  useEffect(() => {
    onCloseLocked?.(operation === "save" || ccConnecting !== null);
  }, [operation, ccConnecting, onCloseLocked]);

  if (!open) return null;

  const activeProvider = data?.provider;
  const busy = operation !== null;
  const sameTargetAsSaved = !!(
    activeProvider &&
    activeProvider.apiFormat === apiFormat &&
    activeProvider.authStyle === authStyle &&
    normalizedUrl(activeProvider.baseURL, apiFormat) === normalizedUrl(baseURL, apiFormat)
  );
  const storedKeyAvailable = !!(
    sameTargetAsSaved &&
    activeProvider?.apiKeySet &&
    !removeSavedKey
  );
  const targetChangedWithSavedKey = !!(
    activeProvider?.apiKeySet &&
    !sameTargetAsSaved &&
    !apiKey.trim() &&
    !removeSavedKey
  );
  const endpoint = completionEndpoint(baseURL, apiFormat);
  const effectiveAuth = authStyle === "apikey" ? "x-api-key" : "Authorization: Bearer";
  const baseURLValid = isSafeBaseURL(baseURL);
  const ccSwitch = data?.ccSwitch;
  const ccRoutes = ccSwitch?.routes;

  const changeFormat = (nextFormat: ApiFormat) => {
    if (nextFormat === apiFormat) return;
    setApiFormat(nextFormat);
    setBaseURL((value) => {
      const wasProtocolDefault =
        normalizedUrl(value, apiFormat) === normalizedUrl(DEFAULT_URL[apiFormat], apiFormat);
      return wasProtocolDefault
        ? DEFAULT_URL[nextFormat]
        : normalizeBaseUrlForFormat(value || DEFAULT_URL[nextFormat], nextFormat);
    });
    setAuthStyle(defaultAuthStyle(nextFormat));
    invalidateConnection();
  };

  const normalizeDraftBaseURL = () => {
    const normalized = normalizeBaseUrlForFormat(baseURL, apiFormat);
    if (normalized && normalized !== baseURL) setBaseURL(normalized);
    return normalized;
  };

  const connectionDraft = (draftBaseURL = baseURL.trim()) => ({
    apiFormat,
    authStyle,
    baseURL: draftBaseURL,
    apiKey: apiKey.trim() || undefined,
    model: model.trim() || undefined,
    reuseStoredKey: storedKeyAvailable,
  });

  const discover = async () => {
    const draftBaseURL = normalizeDraftBaseURL();
    if (!draftBaseURL) {
      setError("Base URL 不能为空。");
      return;
    }
    setOperation("discover");
    const requestId = ++requestSequence.current;
    setError(null);
    setModels([]);
    setModelMode("manual");
    setDiscovery(null);
    setTestResult(null);
    try {
      const result = await discoverLlmModels(connectionDraft(draftBaseURL));
      if (requestId !== requestSequence.current) return;
      setDiscovery(result);
      setModels(result.models);
      if (result.ok && result.models.length) setModelMode("list");
      if (result.ok && result.resolvedBaseURL) setBaseURL(result.resolvedBaseURL);
    } catch (reason) {
      if (requestId === requestSequence.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (requestId === requestSequence.current) setOperation(null);
    }
  };

  const test = async () => {
    const draftBaseURL = normalizeDraftBaseURL();
    if (!draftBaseURL || !model.trim()) {
      setError("请填写 Base URL 并选择模型。");
      return;
    }
    setOperation("test");
    const requestId = ++requestSequence.current;
    setError(null);
    setTestResult(null);
    try {
      const result = await testLlmConnection(connectionDraft(draftBaseURL));
      if (requestId !== requestSequence.current) return;
      setTestResult(result);
      if (result.ok && result.resolvedBaseURL) setBaseURL(result.resolvedBaseURL);
    } catch (reason) {
      if (requestId === requestSequence.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (requestId === requestSequence.current) setOperation(null);
    }
  };

  const save = async () => {
    const draftBaseURL = normalizeDraftBaseURL();
    if (!draftBaseURL || !model.trim()) {
      setError("Base URL 和模型不能为空。");
      return;
    }
    if (!isSafeBaseURL(draftBaseURL)) {
      setError("服务地址必须是完整的 http(s) URL，且不能包含账号、查询参数或片段。");
      return;
    }
    if (targetChangedWithSavedKey) {
      setError("地址或协议已变化。请输入新 Key，或明确选择保存时移除旧 Key。");
      return;
    }
    setOperation("save");
    const requestId = ++requestSequence.current;
    setError(null);
    try {
      const settings = await saveLlmSettings({
        provider: {
          apiFormat,
          authStyle,
          baseURL: draftBaseURL,
          model: model.trim(),
          apiKey:
            apiKey.trim() || (removeSavedKey || !sameTargetAsSaved ? "" : undefined),
        },
        // Only send the opt-in when it changes the active profile's stored value.
        reasoningOptIn:
          reasoningOptIn !== (activeProvider?.reasoningOptIn === true)
            ? reasoningOptIn
            : undefined,
      });
      onSaved?.(settings);
      requestSequence.current += 1;
      onClose();
    } catch (reason) {
      if (requestId === requestSequence.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (requestId === requestSequence.current) setOperation(null);
    }
  };

  const connectCcSwitch = async (route: CcRoute) => {
    setCcConnecting(route);
    setCcError(null);
    try {
      const settings = await connectCcSwitchRoute(route);
      onSaved?.(settings);
      hydrate(settings);
    } catch (reason) {
      // A failed connection must not overwrite the active configuration.
      setCcError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCcConnecting(null);
    }
  };

  const applyPreset = (preset: NonNullable<LlmSettingsPublic["presets"]>[number]) => {
    setApiFormat(preset.apiFormat);
    setAuthStyle(preset.authStyle);
    setBaseURL(preset.baseURL);
    setModel(preset.model);
    invalidateConnection();
  };

  const remoteModelOptions =
    model.trim() && !models.includes(model.trim()) ? [model.trim(), ...models] : models;

  return (
    <div className="settings-tab-body">
      <p className="settings-active-status" role="status">
        {data?.llmMode === "byok" && activeProvider
          ? `当前已启用：${activeProvider.name || activeProvider.model}（${activeProvider.apiFormat === "anthropic" ? "Anthropic" : "OpenAI 兼容"}${activeProvider.source === "cc-switch" ? " · CC Switch 代理" : ""}）`
          : "当前未启用模型：通过下方任一方式连接后才会启用。"}
      </p>

      {loadError ? (
        <p className="settings-msg err" role="alert">
          读取设置失败：{loadError}{" "}
          <button
            type="button"
            className="linkish"
            onClick={() => {
              requestSequence.current += 1;
              setOperation("load");
              setLoadError(null);
              void getLlmSettings()
                .then((settings) => hydrate(settings))
                .catch((reason) => {
                  setLoadError(reason instanceof Error ? reason.message : String(reason));
                })
                .finally(() => setOperation(null));
            }}
          >重试</button>
        </p>
      ) : null}

      <section className="cc-switch-section" aria-label="CC Switch 连接">
        <div className="settings-field-head">
          <span>通过 CC Switch 连接</span>
          <small>{ccSwitch?.detected ? "已检测到本地代理" : operation === "load" ? "检测中…" : "未检测到"}</small>
        </div>
        {ccSwitch?.detected && ccRoutes && (ccRoutes.claude || ccRoutes.codex) ? (
          <ul className="cc-route-list">
            {(["claude", "codex"] as CcRoute[]).map((route) => {
              const info = ccRoutes[route];
              if (!info) return null;
              const isActiveRoute =
                activeProvider?.source === "cc-switch" &&
                normalizedUrl(activeProvider.baseURL, activeProvider.apiFormat) ===
                  normalizedUrl(info.baseURL, activeProvider.apiFormat);
              return (
                <li key={route} className="cc-route">
                  <div>
                    <strong>{CC_ROUTE_LABEL[route]}</strong>
                    <small>{info.baseURL}{info.model ? ` · ${info.model}` : ""}</small>
                  </div>
                  {isActiveRoute && data?.llmMode === "byok" ? (
                    <span className="cc-route-active" role="status">当前使用</span>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={busy || ccConnecting !== null}
                      onClick={() => void connectCcSwitch(route)}
                    >
                      {ccConnecting === route ? "连接中…" : "连接"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <small className="settings-field-note">
            未检测到本机 CC Switch 代理。在 CC Switch 中启用代理后重新打开此面板即可连接。
          </small>
        )}
        {ccError ? <p className="settings-msg err" role="alert">CC Switch 连接失败：{ccError}</p> : null}
      </section>

      {data?.presets?.length ? (
        <section aria-label="常用服务预设">
          <div className="settings-field-head"><span>常用服务（填入后补 Key）</span></div>
          <div className="preset-row">
            {data.presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="chip"
                disabled={busy}
                title={preset.hint || preset.websiteUrl || preset.baseURL || preset.name}
                onClick={() => applyPreset(preset)}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="settings-format" role="radiogroup" aria-label="接口格式">
        <button
          type="button"
          role="radio"
          aria-checked={apiFormat === "openai"}
          className={apiFormat === "openai" ? "active" : ""}
          disabled={busy}
          onClick={() => changeFormat("openai")}
        >
          OpenAI 兼容
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={apiFormat === "anthropic"}
          className={apiFormat === "anthropic" ? "active" : ""}
          disabled={busy}
          onClick={() => changeFormat("anthropic")}
        >
          Anthropic
        </button>
      </div>

      <label className="settings-field">
        <span>服务地址</span>
        <input
          value={baseURL}
          disabled={busy}
          onChange={(event) => {
            setBaseURL(event.target.value);
            invalidateConnection();
          }}
          onBlur={normalizeDraftBaseURL}
          placeholder={DEFAULT_URL[apiFormat]}
          autoComplete="url"
          spellCheck={false}
        />
        <small className="settings-field-note">
          {baseURL.trim() && !baseURLValid
            ? "请输入完整的 http(s) 地址，不包含账号、查询参数或片段"
            : endpoint
            ? <>将请求 <code>{endpoint}</code></>
            : apiFormat === "openai"
              ? "将自动补全 /v1"
              : "将按 Anthropic Messages 格式调用"}
        </small>
      </label>

      <div className="settings-field">
        <div className="settings-field-head">
          <span>
            API Key
            {apiKey.trim()
              ? " · 新 Key 未保存"
              : removeSavedKey
                ? " · 保存时移除"
                : storedKeyAvailable && activeProvider?.apiKeyHint
                  ? ` · 已保存 ${activeProvider.apiKeyHint}`
                  : ""}
          </span>
          {activeProvider?.apiKeySet && !apiKey.trim() ? (
            <button
              type="button"
              className="linkish"
              disabled={busy}
              onClick={() => {
                setRemoveSavedKey((value) => !value);
                invalidateConnection();
              }}
            >
              {removeSavedKey ? "撤销移除" : "保存时移除"}
            </button>
          ) : null}
        </div>
        <input
          type="password"
          value={apiKey}
          disabled={busy}
          onChange={(event) => {
            setApiKey(event.target.value);
            if (event.target.value) setRemoveSavedKey(false);
            invalidateConnection();
          }}
          placeholder={storedKeyAvailable ? "留空使用已保存密钥" : "输入 API Key"}
          autoComplete="new-password"
          aria-label="API Key"
        />
        <small className="settings-field-note">默认鉴权：{effectiveAuth}</small>
      </div>

      <div className="settings-discover-row">
        <button
          type="button"
          className="btn"
          disabled={busy || !baseURLValid}
          onClick={() => void discover()}
        >
          <RefreshCw size={15} />
          {operation === "discover" ? "正在读取…" : "读取模型"}
        </button>
      </div>

      {discovery ? (
        <ProbeResult
          label="模型读取"
          result={discovery}
          detail={discovery.ok ? `发现 ${discovery.models.length} 个可用模型` : undefined}
        />
      ) : null}

      <div className="settings-model-group">
        <div className="settings-field-head">
          <span>选择模型</span>
          {models.length ? (
            <button
              type="button"
              className="linkish"
              disabled={busy}
              onClick={() => setModelMode((value) => (value === "list" ? "manual" : "list"))}
            >
              {modelMode === "list" ? "手动填写" : "从列表选择"}
            </button>
          ) : null}
        </div>
        {models.length && modelMode === "list" ? (
          <select
            value={model}
            disabled={busy}
            onChange={(event) => {
              setModel(event.target.value);
              setTestResult(null);
              setError(null);
            }}
            aria-label="选择模型"
          >
            <option value="" disabled>请选择模型</option>
            {remoteModelOptions.map((item) => (
              <option key={item} value={item}>
                {item === model.trim() && !models.includes(item)
                  ? `${item}（当前填写，列表未返回）`
                  : item}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={model}
            disabled={busy}
            onChange={(event) => {
              setModel(event.target.value);
              setTestResult(null);
              setError(null);
            }}
            placeholder={DEFAULT_MODEL[apiFormat]}
            autoComplete="off"
            spellCheck={false}
            aria-label="模型 ID"
          />
        )}
      </div>

      <div className="settings-test-row">
        <button
          type="button"
          className="btn ghost"
          disabled={busy || !baseURLValid || !model.trim()}
          onClick={() => void test()}
        >
          <Zap size={15} />
          {operation === "test" ? "测试中…" : "测试连接"}
        </button>
      </div>

      {testResult ? <ProbeResult label="模型测试" result={testResult} /> : null}

      <details className="settings-advanced">
        <summary>高级设置</summary>
        <div className="settings-advanced-grid">
          {apiFormat === "anthropic" ? <label className="settings-field">
            <span>覆盖默认鉴权</span>
            <select
              value={authStyle}
              disabled={busy}
              onChange={(event) => {
                setAuthStyle(event.target.value as AuthStyle);
                invalidateConnection();
              }}
            >
              {apiFormat === "anthropic" ? <option value="apikey">x-api-key</option> : null}
              <option value="bearer">Authorization: Bearer</option>
            </select>
          </label> : null}
          <label className="settings-field settings-field-inline">
            <input
              type="checkbox"
              checked={reasoningOptIn}
              disabled={busy}
              onChange={(event) => setReasoningOptIn(event.target.checked)}
            />
            <span>为该自定义服务启用推理强度控制（保存后生效）</span>
          </label>
        </div>
      </details>

      {error ? <p className="settings-msg err" role="alert">{error}</p> : null}

      <footer className="settings-actions settings-footer">
        <button
          type="button"
          className="btn"
          disabled={busy || !baseURLValid || !model.trim()}
          onClick={() => void save()}
        >
          <Check size={15} />
          {operation === "save" ? "保存中…" : "保存并使用"}
        </button>
      </footer>
    </div>
  );
}
