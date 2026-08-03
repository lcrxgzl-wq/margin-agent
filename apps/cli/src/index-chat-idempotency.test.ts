import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type StreamEvent = Record<string, unknown> & { type?: string };

function eventsOf(body: string): StreamEvent[] {
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamEvent);
}

function doneOf(body: string): StreamEvent {
  const done = eventsOf(body).find((event) => event.type === "done");
  if (!done) throw new Error(`missing done event: ${body}`);
  return done;
}

describe("chat request idempotency", () => {
  const dirs: string[] = [];
  const envKeys = [
    "MARGIN_PORT",
    "MARGIN_NO_OPEN",
    "MARGIN_ENGINE",
    "MARGIN_API_KEY",
    "MARGIN_BASE_URL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
  ];
  let savedEnv: Record<string, string | undefined> = {};
  let savedArgv: string[] = [];

  afterEach(async () => {
    const { runtime } = await import("./index.js");
    if (runtime.app) {
      try {
        await runtime.app.close();
      } catch {
        /* ignore */
      }
      runtime.app = undefined;
    }
    if (runtime.state) {
      try {
        runtime.state.workspace.db.close();
      } catch {
        /* ignore */
      }
      try {
        await runtime.state.workspace.releaseLock();
      } catch {
        /* ignore */
      }
      runtime.state = undefined;
    }
    runtime.enqueueChat = undefined;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    process.argv = savedArgv;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("executes a normal turn once, replays queued/completed results, and rejects conflicts", async () => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    savedArgv = process.argv;
    for (const key of envKeys.slice(3)) delete process.env[key];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-chat-idempotency-"));
    dirs.push(root);
    process.argv = ["node", "margin-agent", root];
    process.env.MARGIN_PORT = "0";
    process.env.MARGIN_NO_OPEN = "1";
    process.env.MARGIN_ENGINE = "simple";

    await import("./index.js");
    const { runtime } = await import("./index.js");
    for (let attempt = 0; attempt < 200 && !runtime.app; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!runtime.app || !runtime.state || !runtime.enqueueChat) {
      throw new Error("server did not boot");
    }
    const { app, state, enqueueChat } = runtime as {
      app: NonNullable<typeof runtime.app>;
      state: NonNullable<typeof runtime.state>;
      enqueueChat: NonNullable<typeof runtime.enqueueChat>;
    };
    const headers = { authorization: `Bearer ${state.token}` };
    const payload = {
      requestId: "chat-request-1",
      message: "请简单回复收到",
    };

    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const blocker = enqueueChat(async () => {
      await queueGate;
    });
    const firstRequest = app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload,
    });
    const queuedDuplicate = app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const inFlightConflict = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload: { ...payload, message: "排队中的另一条请求" },
    });
    expect(inFlightConflict.statusCode).toBe(409);
    releaseQueue();
    await blocker;
    const [firstResponse, duplicateResponse] = await Promise.all([
      firstRequest,
      queuedDuplicate,
    ]);
    expect(firstResponse.statusCode).toBe(200);
    expect(duplicateResponse.statusCode).toBe(200);
    const firstDone = doneOf(firstResponse.body);
    expect(doneOf(duplicateResponse.body)).toEqual(firstDone);
    expect(state.chat.list().filter((turn) => turn.role === "user")).toHaveLength(1);

    const completedReplay = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload,
    });
    expect(completedReplay.statusCode).toBe(200);
    expect(eventsOf(completedReplay.body)).toEqual([firstDone]);
    expect(state.chat.list().filter((turn) => turn.role === "user")).toHaveLength(1);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload: { ...payload, message: "另一条请求" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: expect.stringContaining("different request") });

    const invalidEmpty = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload: { ...payload, requestId: "   " },
    });
    expect(invalidEmpty.statusCode).toBe(400);
    const invalidWhitespace = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload: { ...payload, requestId: "chat request-1" },
    });
    expect(invalidWhitespace.statusCode).toBe(400);
    const invalidControl = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload: { ...payload, requestId: "chat\nrequest-1" },
    });
    expect(invalidControl.statusCode).toBe(400);
    const invalidLong = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload: { ...payload, requestId: "x".repeat(201) },
    });
    expect(invalidLong.statusCode).toBe(400);

    const closePayload = { requestId: "chat-close-1", message: "关闭文稿" };
    const closeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload: closePayload,
    });
    const chatTurnsAfterClose = state.chat.list();
    const closeReplay = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload: closePayload,
    });
    expect(doneOf(closeReplay.body)).toEqual(doneOf(closeResponse.body));
    expect(state.chat.list()).toEqual(chatTurnsAfterClose);

    const clearPayload = { requestId: "chat-clear-1", message: "清空对话" };
    const clearResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload: clearPayload,
    });
    const sessionAfterClear = state.agent.sessionId;
    const clearReplay = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      headers,
      payload: clearPayload,
    });
    expect(doneOf(clearReplay.body)).toEqual(doneOf(clearResponse.body));
    expect(state.agent.sessionId).toBe(sessionAfterClear);
  });
});
