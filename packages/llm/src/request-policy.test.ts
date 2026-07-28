import { describe, expect, it } from "vitest";
import {
  configureRequestPolicy,
  extractUsage,
  marginRequestHeaders,
  reportModelUsage,
  type ModelUsageEntry,
} from "./request-policy.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("marginRequestHeaders", () => {
  it("sends the configured product version and a fresh request id per call", () => {
    configureRequestPolicy({ version: "9.9.9-test" });
    const first = marginRequestHeaders();
    const second = marginRequestHeaders();
    expect(first["User-Agent"]).toBe("margin-agent/9.9.9-test");
    expect(first["X-Client-Request-Id"]).toMatch(UUID);
    expect(second["X-Client-Request-Id"]).toMatch(UUID);
    expect(second["X-Client-Request-Id"]).not.toBe(first["X-Client-Request-Id"]);
  });

  it("ignores an empty version override", () => {
    configureRequestPolicy({ version: "  " });
    expect(marginRequestHeaders()["User-Agent"]).toBe("margin-agent/9.9.9-test");
  });
});

describe("extractUsage", () => {
  it("maps OpenAI usage including cached prompt tokens", () => {
    expect(
      extractUsage("openai", {
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    ).toEqual({ input: 120, output: 30, cacheRead: 80, cacheWrite: 0 });
  });

  it("maps Anthropic usage including cache read/write tokens", () => {
    expect(
      extractUsage("anthropic", {
        usage: {
          input_tokens: 200,
          output_tokens: 45,
          cache_read_input_tokens: 150,
          cache_creation_input_tokens: 60,
        },
      }),
    ).toEqual({ input: 200, output: 45, cacheRead: 150, cacheWrite: 60 });
  });

  it("returns undefined when the response carries no usage", () => {
    expect(extractUsage("openai", { choices: [] })).toBeUndefined();
    expect(extractUsage("anthropic", null)).toBeUndefined();
  });
});

describe("reportModelUsage", () => {
  const entry: ModelUsageEntry = {
    path: "probe",
    model: "model-a",
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    requestId: "req-1",
  };

  it("delivers entries to the configured recorder", () => {
    const seen: ModelUsageEntry[] = [];
    configureRequestPolicy({ onUsage: (e) => seen.push(e) });
    reportModelUsage(entry);
    expect(seen).toEqual([entry]);
    configureRequestPolicy({ onUsage: undefined });
    reportModelUsage(entry);
    expect(seen).toHaveLength(1);
  });

  it("never throws when the recorder fails", () => {
    configureRequestPolicy({
      onUsage: () => {
        throw new Error("disk full");
      },
    });
    expect(() => reportModelUsage(entry)).not.toThrow();
    configureRequestPolicy({ onUsage: undefined });
  });
});
