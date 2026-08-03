import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  translateSelection: vi.fn(),
}));

vi.mock("@margin/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@margin/llm")>();
  return {
    ...actual,
    translateSelection: mocks.translateSelection,
  };
});

describe("translation route", () => {
  const envKeys = ["MARGIN_PORT", "MARGIN_NO_OPEN", "MARGIN_API_KEY"] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const savedArgv = process.argv;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-index-translate-"));
  let runtime: typeof import("./index.js").runtime;

  beforeAll(async () => {
    process.argv = ["node", "margin-agent", root];
    process.env.MARGIN_PORT = "0";
    process.env.MARGIN_NO_OPEN = "1";
    process.env.MARGIN_API_KEY = "test-key";

    ({ runtime } = await import("./index.js"));
    for (let attempt = 0; attempt < 200 && !runtime.app; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!runtime.app || !runtime.state) throw new Error("server did not boot");
  });

  afterAll(async () => {
    if (runtime.app) await runtime.app.close();
    if (runtime.state) {
      runtime.state.workspace.db.close();
      await runtime.state.workspace.releaseLock();
    }
    runtime.app = undefined;
    runtime.state = undefined;
    runtime.enqueueChat = undefined;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    process.argv = savedArgv;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    [undefined, "missing"],
    ["fr", "unknown"],
    [null, "null"],
  ])("rejects %s targetLanguage (%s)", async (targetLanguage) => {
    const { app, state } = runtime;
    if (!app || !state) throw new Error("server did not boot");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/translate",
      headers: { authorization: `Bearer ${state.token}` },
      payload: { text: "hello", targetLanguage },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "targetLanguage must be zh-CN or en" });
    expect(mocks.translateSelection).not.toHaveBeenCalled();
  });

  it("aborts the model request when the client disconnects", async () => {
    const { app, state } = runtime;
    if (!app || !state) throw new Error("server did not boot");
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("server not listening");

    let modelSignal: AbortSignal | undefined;
    const modelStarted = Promise.withResolvers<void>();
    mocks.translateSelection.mockImplementationOnce(async (input) => {
      modelSignal = input.signal;
      modelStarted.resolve();
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const clientController = new AbortController();
    const request = fetch(`http://127.0.0.1:${address.port}/api/v1/translate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "hello", targetLanguage: "zh-CN" }),
      signal: clientController.signal,
    });

    await modelStarted.promise;
    clientController.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(modelSignal?.aborted).toBe(true));
  });
});
