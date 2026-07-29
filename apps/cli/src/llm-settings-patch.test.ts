import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeProfile,
  readLlmSettingsStore,
  saveLlmSettings,
} from "@margin/storage-local";
import { buildLlmSettingsUpdate } from "./llm-settings-patch.js";

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
];

describe("buildLlmSettingsUpdate", () => {
  it("builds no provider patch for a harnessId-only request", () => {
    const update = buildLlmSettingsUpdate({ harnessId: "office-zh" }, "custom");
    expect(update.provider).toBeUndefined();
    expect(update.harnessId).toBe("office-zh");
  });

  it("maps a legacy string provider to an apiFormat patch", () => {
    const update = buildLlmSettingsUpdate({ provider: "anthropic" }, "custom");
    expect(update.provider).toEqual({ id: "custom", apiFormat: "anthropic" });
  });

  it("strips undefined keys from partial provider patches", () => {
    const update = buildLlmSettingsUpdate(
      { baseURL: "https://one.test/v1" },
      "custom",
    );
    expect(update.provider).toEqual({
      id: "custom",
      baseURL: "https://one.test/v1",
    });
  });

  it("keeps an explicit empty apiKey so the saved key is cleared", () => {
    const update = buildLlmSettingsUpdate(
      { provider: { apiFormat: "openai", baseURL: "https://one.test/v1", model: "m", apiKey: "" } },
      "custom",
    );
    expect(update.provider).toMatchObject({ apiKey: "" });
  });

  it("clears the key on the active provider when only clearApiKey is sent", () => {
    const update = buildLlmSettingsUpdate({ clearApiKey: true }, "custom");
    expect(update.provider).toBeUndefined();
    expect(update.clearApiKey).toBe(true);
  });
});

describe("PUT /api/v1/settings/llm update flow", () => {
  it("normalizes profile ids before persistence", () => {
    expect(buildLlmSettingsUpdate({ harnessId: "  minimal  " }, "provider").harnessId)
      .toBe("minimal");
    expect(buildLlmSettingsUpdate({ harnessId: "   " }, "provider").harnessId)
      .toBeNull();
  });

  let root: string;
  const prev = { ...process.env };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-llm-patch-"));
    for (const key of ENV_KEYS) delete process.env[key];
    await saveLlmSettings(root, {
      provider: {
        id: "custom",
        apiFormat: "openai",
        baseURL: "https://one.test/v1",
        model: "model-a",
        authStyle: "bearer",
        apiKey: "saved-key",
      },
    });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, prev);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a harnessId-only request leaves the active provider untouched", async () => {
    const before = activeProfile(readLlmSettingsStore(root));
    const update = buildLlmSettingsUpdate({ harnessId: "office-zh" }, before.id);
    await saveLlmSettings(root, update);

    const store = readLlmSettingsStore(root);
    expect(store.harnessId).toBe("office-zh");
    expect(activeProfile(store)).toEqual(before);
  });

  it("a full form request updates provider and harness together", async () => {
    const before = activeProfile(readLlmSettingsStore(root));
    await saveLlmSettings(root, buildLlmSettingsUpdate({ harnessId: "office-zh" }, before.id));
    await saveLlmSettings(
      root,
      buildLlmSettingsUpdate(
        {
          harnessId: "minimal",
          provider: {
            apiFormat: "anthropic",
            baseURL: "https://two.test",
            model: "model-b",
            authStyle: "apikey",
            apiKey: "new-key",
          },
        },
        before.id,
      ),
    );

    const store = readLlmSettingsStore(root);
    expect(store.harnessId).toBe("minimal");
    const active = activeProfile(store);
    expect(active.apiFormat).toBe("anthropic");
    expect(active.baseURL).toBe("https://two.test");
    expect(active.model).toBe("model-b");
    expect(active.authStyle).toBe("apikey");
    expect(active.apiKey).toBe("new-key");
  });
});

describe("reasoning fields", () => {
  let root: string;
  const prev = { ...process.env };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-llm-patch-reasoning-"));
    for (const key of ENV_KEYS) delete process.env[key];
    await saveLlmSettings(root, {
      provider: {
        id: "custom",
        apiFormat: "openai",
        baseURL: "https://one.test/v1",
        model: "model-a",
        authStyle: "bearer",
        apiKey: "saved-key",
      },
    });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, prev);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("threads a reasoning mode without touching the provider patch", () => {
    const update = buildLlmSettingsUpdate({ reasoningMode: "deep" }, "custom");
    expect(update.reasoningMode).toBe("deep");
    expect(update.provider).toBeUndefined();
  });

  it("threads a reasoning opt-in onto the active provider patch", () => {
    const update = buildLlmSettingsUpdate({ reasoningOptIn: true }, "custom");
    expect(update.provider).toEqual({ id: "custom", reasoningOptIn: true });
  });

  it("persists reasoning mode and opt-in through the update flow", async () => {
    const before = activeProfile(readLlmSettingsStore(root));
    await saveLlmSettings(
      root,
      buildLlmSettingsUpdate({ reasoningMode: "standard", reasoningOptIn: true }, before.id),
    );

    const store = readLlmSettingsStore(root);
    expect(store.reasoningMode).toBe("standard");
    expect(activeProfile(store).reasoningOptIn).toBe(true);

    await saveLlmSettings(root, buildLlmSettingsUpdate({ reasoningMode: null }, before.id));
    expect(readLlmSettingsStore(root).reasoningMode).toBeUndefined();
  });

  it("threads an agent timeout without touching the provider patch", () => {
    const update = buildLlmSettingsUpdate({ agentTimeoutMs: 180_000 }, "custom");
    expect(update.agentTimeoutMs).toBe(180_000);
    expect(update.provider).toBeUndefined();
  });

  it("persists and clears an agent timeout through the update flow", async () => {
    const before = activeProfile(readLlmSettingsStore(root));
    await saveLlmSettings(
      root,
      buildLlmSettingsUpdate({ agentTimeoutMs: 240_000 }, before.id),
    );
    expect(readLlmSettingsStore(root).agentTimeoutMs).toBe(240_000);

    await saveLlmSettings(root, buildLlmSettingsUpdate({ agentTimeoutMs: null }, before.id));
    expect(readLlmSettingsStore(root).agentTimeoutMs).toBeUndefined();
  });

  it("surfaces validation errors for invalid agent timeouts", async () => {
    const before = activeProfile(readLlmSettingsStore(root));
    await expect(
      saveLlmSettings(root, buildLlmSettingsUpdate({ agentTimeoutMs: 500 }, before.id)),
    ).rejects.toThrow(/agentTimeoutMs|超时/);
  });

  it("threads a context tier without touching the provider patch", () => {
    const update = buildLlmSettingsUpdate({ contextTier: "max" }, "custom");
    expect(update.contextTier).toBe("max");
    expect(update.provider).toBeUndefined();
  });

  it("persists and clears a context tier through the update flow", async () => {
    const before = activeProfile(readLlmSettingsStore(root));
    await saveLlmSettings(
      root,
      buildLlmSettingsUpdate({ contextTier: "eco" }, before.id),
    );
    expect(readLlmSettingsStore(root).contextTier).toBe("eco");

    await saveLlmSettings(root, buildLlmSettingsUpdate({ contextTier: null }, before.id));
    expect(readLlmSettingsStore(root).contextTier).toBeUndefined();
  });

  it("surfaces validation errors for invalid context tiers", async () => {
    const before = activeProfile(readLlmSettingsStore(root));
    await expect(
      saveLlmSettings(root, buildLlmSettingsUpdate({ contextTier: "ludicrous" as never }, before.id)),
    ).rejects.toThrow(/contextTier/);
  });

  it("threads compactionAuto without touching the provider patch", () => {
    const update = buildLlmSettingsUpdate({ compactionAuto: false }, "custom");
    expect(update.compactionAuto).toBe(false);
    expect(update.provider).toBeUndefined();
  });

  it("persists and clears compactionAuto through the update flow", async () => {
    const before = activeProfile(readLlmSettingsStore(root));
    await saveLlmSettings(
      root,
      buildLlmSettingsUpdate({ compactionAuto: false }, before.id),
    );
    expect(readLlmSettingsStore(root).compactionAuto).toBe(false);

    await saveLlmSettings(root, buildLlmSettingsUpdate({ compactionAuto: null }, before.id));
    expect(readLlmSettingsStore(root).compactionAuto).toBeUndefined();
  });

  it("surfaces validation errors for invalid compactionAuto values", async () => {
    const before = activeProfile(readLlmSettingsStore(root));
    await expect(
      saveLlmSettings(root, buildLlmSettingsUpdate({ compactionAuto: "yes" as never }, before.id)),
    ).rejects.toThrow(/compactionAuto/);
  });
});
