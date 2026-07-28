import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPreset,
  loadAndApplyLlmSettings,
  publicLlmSettings,
  readLlmSettingsStore,
  saveLlmSettings,
} from "./llm-settings.js";

describe("llm-settings", () => {
  let root: string;
  const prev = { ...process.env };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-llm-"));
    fs.mkdirSync(path.join(root, ".margin"), { recursive: true });
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.MARGIN_API_KEY;
    delete process.env.MARGIN_BASE_URL;
    delete process.env.MARGIN_PROVIDER;
    delete process.env.MARGIN_MODEL;
    delete process.env.MARGIN_AUTH_STYLE;
    delete process.env.MARGIN_API_FORMAT;
  });

  afterEach(() => {
    for (const k of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "MARGIN_API_KEY",
      "MARGIN_BASE_URL",
      "MARGIN_PROVIDER",
      "MARGIN_MODEL",
      "MARGIN_AUTH_STYLE",
      "MARGIN_API_FORMAT",
    ] as const) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("saves and applies key", async () => {
    const saved = await saveLlmSettings(root, {
      provider: {
        apiFormat: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-test-abcdefghabcdefgh",
      },
    });
    expect(readLlmSettingsStore(root).providers[0]?.apiKey).toBe(
      "sk-test-abcdefghabcdefgh",
    );
    expect(process.env.OPENAI_API_KEY).toBe("sk-test-abcdefghabcdefgh");
    const pub = publicLlmSettings(saved);
    expect(pub.llmMode).toBe("byok");
    expect(pub.provider?.apiKeyHint).toContain("…");
  });

  it("normalizes OpenAI-compatible profiles to bearer authentication", async () => {
    fs.writeFileSync(
      path.join(root, ".margin", "llm-settings.json"),
      JSON.stringify({
        activeId: "custom",
        providers: [{
          id: "custom",
          name: "Custom",
          apiFormat: "openai",
          authStyle: "apikey",
          baseURL: "https://provider.test/v1",
          model: "model-a",
        }],
      }),
      "utf8",
    );

    expect(readLlmSettingsStore(root).providers[0]?.authStyle).toBe("bearer");
  });

  it("applies cc-switch proxy preset with PROXY_MANAGED", async () => {
    await applyPreset(root, "cc-switch-proxy");
    expect(process.env.MARGIN_BASE_URL).toBe("http://127.0.0.1:15721");
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("PROXY_MANAGED");
    expect(process.env.MARGIN_AUTH_STYLE).toBe("bearer");
  });

  it("clears key", async () => {
    await saveLlmSettings(root, {
      provider: { apiKey: "sk-aaaaaaaaaaaaaaaa", apiFormat: "openai" },
    });
    await saveLlmSettings(root, { clearApiKey: true });
    expect(readLlmSettingsStore(root).providers[0]?.apiKey).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("requires an explicit key decision when the API target changes", async () => {
    await saveLlmSettings(root, {
      provider: {
        apiFormat: "openai",
        baseURL: "https://one.test/v1",
        model: "model-a",
        apiKey: "saved-key",
      },
    });

    await expect(
      saveLlmSettings(root, {
        provider: { baseURL: "https://two.test/v1" },
      }),
    ).rejects.toThrow(/新 Key|移除旧 Key/);
    expect(readLlmSettingsStore(root).providers[0]?.baseURL).toBe(
      "https://one.test/v1",
    );

    await saveLlmSettings(root, {
      provider: { baseURL: "https://two.test/v1", apiKey: "" },
    });
    expect(readLlmSettingsStore(root).providers[0]?.apiKey).toBeUndefined();
  });

  it("keeps the saved key when a full endpoint is normalized to the same Base URL", async () => {
    await saveLlmSettings(root, {
      provider: {
        apiFormat: "openai",
        baseURL: "https://one.test/gateway/v1/chat/completions",
        model: "model-a",
        apiKey: "saved-key",
      },
    });

    await saveLlmSettings(root, {
      provider: { baseURL: "https://one.test/gateway/v1" },
    });

    expect(readLlmSettingsStore(root).providers[0]).toMatchObject({
      baseURL: "https://one.test/gateway/v1",
      apiKey: "saved-key",
    });
  });

  it("keeps the saved OpenAI key when the UI adds its /v1 suffix", async () => {
    await saveLlmSettings(root, {
      provider: {
        apiFormat: "openai",
        baseURL: "https://one.test",
        model: "model-a",
        apiKey: "saved-key",
      },
    });

    await saveLlmSettings(root, {
      provider: { baseURL: "https://one.test/v1" },
    });

    expect(readLlmSettingsStore(root).providers[0]).toMatchObject({
      baseURL: "https://one.test/v1",
      apiKey: "saved-key",
    });
  });

  it("rejects unsafe Base URLs before persisting settings", async () => {
    await expect(saveLlmSettings(root, {
      provider: { baseURL: "https://provider.test/v1?key=unsafe" },
    })).rejects.toThrow(/查询参数/);
    await expect(saveLlmSettings(root, {
      provider: { baseURL: "ftp://provider.test" },
    })).rejects.toThrow(/http/);
  });

  it("recognizes the Anthropic messages endpoint as its protocol Base URL", async () => {
    await saveLlmSettings(root, {
      provider: {
        apiFormat: "anthropic",
        authStyle: "apikey",
        baseURL: "https://one.test/gateway/v1/messages",
        model: "model-a",
        apiKey: "saved-key",
      },
    });

    await saveLlmSettings(root, {
      provider: { baseURL: "https://one.test/gateway" },
    });

    expect(readLlmSettingsStore(root).providers[0]).toMatchObject({
      baseURL: "https://one.test/gateway",
      apiKey: "saved-key",
    });
  });

  it("load without file key keeps shell env", () => {
    process.env.OPENAI_API_KEY = "sk-from-shell-xxxxxxxx";
    loadAndApplyLlmSettings(root);
    expect(process.env.OPENAI_API_KEY).toBe("sk-from-shell-xxxxxxxx");
  });

  it("load without a settings file preserves the shell model profile", () => {
    process.env.MARGIN_PROVIDER = "openai";
    process.env.MARGIN_MODEL = "llama3.1";
    process.env.MARGIN_BASE_URL = "http://127.0.0.1:11434/v1";
    process.env.MARGIN_API_KEY = "ollama";

    const store = loadAndApplyLlmSettings(root);

    expect(store.providers[0]).toMatchObject({
      apiFormat: "openai",
      model: "llama3.1",
      baseURL: "http://127.0.0.1:11434/v1",
      source: "environment",
    });
    expect(process.env.MARGIN_MODEL).toBe("llama3.1");
    expect(process.env.MARGIN_API_KEY).toBe("ollama");
  });

  it("a saved empty profile clears stale shell credentials on load", async () => {
    await saveLlmSettings(root, {
      provider: { apiFormat: "openai", baseURL: "", model: "gpt-4o-mini" },
    });
    process.env.OPENAI_API_KEY = "stale-shell-key";
    process.env.MARGIN_BASE_URL = "https://stale.test/v1";

    loadAndApplyLlmSettings(root);

    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.MARGIN_BASE_URL).toBeUndefined();
  });

  it("recognizes an Anthropic auth token as a runtime credential", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "proxy-token";
    const settings = publicLlmSettings(readLlmSettingsStore(root));
    expect(settings.llmMode).toBe("byok");
  });

  it("persists the selected harness and clears it with null", async () => {
    await saveLlmSettings(root, { harnessId: "office-zh" });
    expect(readLlmSettingsStore(root).harnessId).toBe("office-zh");
    expect(publicLlmSettings(readLlmSettingsStore(root)).harnessId).toBe("office-zh");
    await saveLlmSettings(root, { harnessId: null });
    expect(readLlmSettingsStore(root).harnessId).toBeUndefined();
  });
});

describe("reasoning settings", () => {
  let root: string;
  const prev = { ...process.env };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-llm-reasoning-"));
    fs.mkdirSync(path.join(root, ".margin"), { recursive: true });
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.MARGIN_API_KEY;
    delete process.env.MARGIN_BASE_URL;
    delete process.env.MARGIN_PROVIDER;
    delete process.env.MARGIN_MODEL;
    delete process.env.MARGIN_AUTH_STYLE;
    delete process.env.MARGIN_API_FORMAT;
  });

  afterEach(() => {
    for (const k of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "MARGIN_API_KEY",
      "MARGIN_BASE_URL",
      "MARGIN_PROVIDER",
      "MARGIN_MODEL",
      "MARGIN_AUTH_STYLE",
      "MARGIN_API_FORMAT",
    ] as const) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("defaults to auto and persists an explicit reasoning mode", async () => {
    expect(readLlmSettingsStore(root).reasoningMode).toBeUndefined();
    expect(publicLlmSettings(readLlmSettingsStore(root)).reasoningMode).toBe("auto");

    await saveLlmSettings(root, { reasoningMode: "deep" });
    expect(readLlmSettingsStore(root).reasoningMode).toBe("deep");
    expect(publicLlmSettings(readLlmSettingsStore(root)).reasoningMode).toBe("deep");

    await saveLlmSettings(root, { reasoningMode: null });
    expect(readLlmSettingsStore(root).reasoningMode).toBeUndefined();
    expect(publicLlmSettings(readLlmSettingsStore(root)).reasoningMode).toBe("auto");
  });

  it("persists a custom provider reasoning opt-in per profile", async () => {
    await saveLlmSettings(root, {
      provider: {
        id: "custom",
        apiFormat: "openai",
        baseURL: "https://provider.test/v1",
        model: "model-a",
        authStyle: "bearer",
        reasoningOptIn: true,
      },
    });
    const store = readLlmSettingsStore(root);
    expect(store.providers[0]?.reasoningOptIn).toBe(true);
    expect(publicLlmSettings(store).provider?.reasoningOptIn).toBe(true);

    await saveLlmSettings(root, { provider: { id: "custom", reasoningOptIn: false } });
    expect(readLlmSettingsStore(root).providers[0]?.reasoningOptIn).toBeUndefined();
    expect(publicLlmSettings(readLlmSettingsStore(root)).provider?.reasoningOptIn)
      .toBeUndefined();
  });

  it("ignores invalid persisted reasoning modes", () => {
    fs.writeFileSync(
      path.join(root, ".margin", "llm-settings.json"),
      JSON.stringify({
        activeId: "custom",
        reasoningMode: "ludicrous",
        providers: [{
          id: "custom",
          name: "Custom",
          apiFormat: "openai",
          authStyle: "bearer",
          baseURL: "https://provider.test/v1",
          model: "model-a",
        }],
      }),
      "utf8",
    );
    expect(readLlmSettingsStore(root).reasoningMode).toBeUndefined();
    expect(publicLlmSettings(readLlmSettingsStore(root)).reasoningMode).toBe("auto");
  });
});

describe("cc-switch profiles", () => {
  let root: string;
  const prev = { ...process.env };
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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-llm-ccswitch-"));
    fs.mkdirSync(path.join(root, ".margin"), { recursive: true });
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const settingsFileText = () =>
    fs.readFileSync(path.join(root, ".margin", "llm-settings.json"), "utf8");

  it("never persists apiKey or the placeholder for a cc-switch profile", async () => {
    await saveLlmSettings(root, {
      provider: {
        id: "cc-switch-claude",
        name: "CC Switch 本地代理（Claude）",
        apiFormat: "anthropic",
        baseURL: "http://127.0.0.1:15721",
        model: "claude-sonnet-4-6",
        authStyle: "bearer",
        source: "cc-switch",
        apiKey: "sk-sentinel-SECRET",
      },
    });

    const store = readLlmSettingsStore(root);
    expect(store.providers[0]?.apiKey).toBeUndefined();
    const fileText = settingsFileText();
    expect(fileText).not.toContain("sk-sentinel-SECRET");
    expect(fileText).not.toContain("PROXY_MANAGED");
  });

  it("injects the placeholder in memory only for a loopback cc-switch profile", async () => {
    await saveLlmSettings(root, {
      provider: {
        id: "cc-switch-claude",
        name: "CC Switch 本地代理（Claude）",
        apiFormat: "anthropic",
        baseURL: "http://127.0.0.1:15721",
        model: "claude-sonnet-4-6",
        authStyle: "bearer",
        source: "cc-switch",
      },
    });

    expect(process.env.MARGIN_API_KEY).toBe("PROXY_MANAGED");
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("PROXY_MANAGED");
    expect(process.env.MARGIN_BASE_URL).toBe("http://127.0.0.1:15721");
  });

  it("refuses the placeholder when a cc-switch profile points off-loopback", async () => {
    await saveLlmSettings(root, {
      provider: {
        id: "cc-switch-claude",
        name: "CC Switch 本地代理（Claude）",
        apiFormat: "anthropic",
        baseURL: "https://evil.example.com",
        model: "claude-sonnet-4-6",
        authStyle: "bearer",
        source: "cc-switch",
      },
    });

    expect(process.env.MARGIN_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("presents a cc-switch profile honestly without fake key material", async () => {
    const saved = await saveLlmSettings(root, {
      provider: {
        id: "cc-switch-claude",
        name: "CC Switch 本地代理（Claude）",
        apiFormat: "anthropic",
        baseURL: "http://127.0.0.1:15721",
        model: "claude-sonnet-4-6",
        authStyle: "bearer",
        source: "cc-switch",
      },
    });

    const pub = publicLlmSettings(saved);
    expect(pub.provider?.apiKeySet).toBe(true);
    expect(pub.provider?.apiKeyHint).toBe("由 CC Switch 代理管理");
    expect(JSON.stringify(pub)).not.toContain("PROXY_MANAGED");

    await saveLlmSettings(root, {
      provider: { id: "cc-switch-claude", baseURL: "https://evil.example.com" },
    });
    const offLoopback = publicLlmSettings(readLlmSettingsStore(root));
    expect(offLoopback.provider?.apiKeySet).toBe(false);
    expect(offLoopback.provider?.apiKeyHint).toBe("");
  });

  it("funnels the cc-switch-proxy preset into the same memory-only behavior", async () => {
    const saved = await applyPreset(root, "cc-switch-proxy");
    const profile = saved.providers.find((p) => p.id === "cc-switch-proxy");
    expect(profile?.source).toBe("cc-switch");
    expect(profile?.apiKey).toBeUndefined();

    const fileText = settingsFileText();
    expect(fileText).not.toContain("PROXY_MANAGED");

    // Placeholder is still applied in memory for the loopback target.
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("PROXY_MANAGED");
  });
});
