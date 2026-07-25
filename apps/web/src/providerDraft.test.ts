import { describe, expect, it } from "vitest";
import {
  completionEndpoint,
  defaultAuthStyle,
  normalizeBaseUrlForFormat,
} from "./providerDraft";

describe("provider draft defaults", () => {
  it("adds and removes the protocol suffix when format changes", () => {
    expect(normalizeBaseUrlForFormat("https://api.deepseek.com", "openai"))
      .toBe("https://api.deepseek.com/v1");
    expect(normalizeBaseUrlForFormat("https://proxy.test/gateway/v1", "anthropic"))
      .toBe("https://proxy.test/gateway");
  });

  it("normalizes full endpoints and exposes the final completion URL", () => {
    expect(normalizeBaseUrlForFormat("https://proxy.test/v1/chat/completions", "openai"))
      .toBe("https://proxy.test/v1");
    expect(normalizeBaseUrlForFormat("https://proxy.test/v1/messages", "anthropic"))
      .toBe("https://proxy.test");
    expect(completionEndpoint("https://proxy.test", "openai"))
      .toBe("https://proxy.test/v1/chat/completions");
    expect(completionEndpoint("https://proxy.test", "anthropic"))
      .toBe("https://proxy.test/v1/messages");
  });

  it("uses protocol-specific authentication defaults", () => {
    expect(defaultAuthStyle("openai")).toBe("bearer");
    expect(defaultAuthStyle("anthropic")).toBe("apikey");
  });
});
