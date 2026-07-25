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
          harnessId: "novel",
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
    expect(store.harnessId).toBe("novel");
    const active = activeProfile(store);
    expect(active.apiFormat).toBe("anthropic");
    expect(active.baseURL).toBe("https://two.test");
    expect(active.model).toBe("model-b");
    expect(active.authStyle).toBe("apikey");
    expect(active.apiKey).toBe("new-key");
  });
});
