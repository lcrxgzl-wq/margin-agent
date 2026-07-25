import { describe, expect, it } from "vitest";
import type { LlmSettingsStore } from "@margin/storage-local";
import { resolveLlmConnectionInput } from "./llm-connection.js";

const store: LlmSettingsStore = {
  activeId: "openai-main",
  providers: [
    {
      id: "openai-main",
      name: "OpenAI main",
      apiFormat: "openai",
      authStyle: "apikey",
      baseURL: "https://one.test/v1",
      model: "model-a",
      apiKey: "saved-openai",
    },
    {
      id: "anthropic-alt",
      name: "Anthropic alt",
      apiFormat: "anthropic",
      authStyle: "bearer",
      baseURL: "https://two.test",
      model: "model-b",
      apiKey: "saved-anthropic",
    },
  ],
};

describe("resolveLlmConnectionInput", () => {
  it("reuses a saved key only for the same target", () => {
    expect(
      resolveLlmConnectionInput(store, {
        baseURL: "https://one.test/v1/",
        reuseStoredKey: true,
      }).apiKey,
    ).toBe("saved-openai");

    expect(
      resolveLlmConnectionInput(store, {
        baseURL: "https://other.test/v1",
        reuseStoredKey: true,
      }).apiKey,
    ).toBeUndefined();
  });

  it("does not reuse a saved key after protocol or auth changes", () => {
    expect(resolveLlmConnectionInput(store, { apiFormat: "anthropic", reuseStoredKey: true }).apiKey).toBeUndefined();
    expect(resolveLlmConnectionInput(store, { authStyle: "bearer", reuseStoredKey: true }).apiKey).toBeUndefined();
  });

  it("uses an explicit draft key for a changed target", () => {
    expect(
      resolveLlmConnectionInput(store, {
        baseURL: "https://other.test/v1",
        apiKey: "draft-key",
      }).apiKey,
    ).toBe("draft-key");
  });

  it("does not reuse a saved key when the draft explicitly opts out", () => {
    expect(
      resolveLlmConnectionInput(store, {
        baseURL: "https://one.test/v1",
        reuseStoredKey: false,
      }).apiKey,
    ).toBeUndefined();
  });

  it("treats a full endpoint and its canonical Base URL as the same target", () => {
    expect(
      resolveLlmConnectionInput(store, {
        baseURL: "https://one.test/v1/chat/completions",
        reuseStoredKey: true,
      }).apiKey,
    ).toBe("saved-openai");
  });

  it("treats an OpenAI root URL and its automatic /v1 suffix as the same target", () => {
    expect(
      resolveLlmConnectionInput(store, {
        baseURL: "https://one.test",
        reuseStoredKey: true,
      }).apiKey,
    ).toBe("saved-openai");
  });

  it("keeps runtime keys provider-specific", () => {
    const withoutStoredKey: LlmSettingsStore = {
      ...store,
      providers: store.providers.map((provider) => ({ ...provider, apiKey: undefined })),
    };
    expect(
      resolveLlmConnectionInput(withoutStoredKey, { reuseStoredKey: true }, {
        openai: "runtime-openai",
        anthropic: "runtime-anthropic",
      }).apiKey,
    ).toBe("runtime-openai");
    expect(resolveLlmConnectionInput(withoutStoredKey, {}, {
      openai: "runtime-openai",
    }).apiKey).toBeUndefined();
  });
});
