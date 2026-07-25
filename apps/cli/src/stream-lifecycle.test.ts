import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { abortOnClientDisconnect } from "./stream-lifecycle.js";

class ResponseEvents extends EventEmitter {
  writableEnded = false;
}

describe("abortOnClientDisconnect", () => {
  it("does not abort when the request closes after its body was read", () => {
    const request = new EventEmitter();
    const response = new ResponseEvents();
    const controller = new AbortController();
    const dispose = abortOnClientDisconnect(request, response, controller);

    request.emit("close");

    expect(controller.signal.aborted).toBe(false);
    dispose();
  });

  it("aborts when the request body or response connection is interrupted", () => {
    const request = new EventEmitter();
    const response = new ResponseEvents();
    const requestController = new AbortController();
    abortOnClientDisconnect(request, response, requestController);

    request.emit("aborted");
    expect(requestController.signal.aborted).toBe(true);

    const responseController = new AbortController();
    abortOnClientDisconnect(request, response, responseController);
    response.emit("close");
    expect(responseController.signal.aborted).toBe(true);
  });

  it("does not abort when a completed response closes", () => {
    const request = new EventEmitter();
    const response = new ResponseEvents();
    const controller = new AbortController();
    abortOnClientDisconnect(request, response, controller);

    response.writableEnded = true;
    response.emit("close");

    expect(controller.signal.aborted).toBe(false);
  });

  it("keeps a real Fastify POST alive after its request body is consumed", async () => {
    const app = Fastify();
    let aborted: boolean | undefined;
    app.post("/stream", async (request, reply) => {
      reply.hijack();
      const controller = new AbortController();
      const dispose = abortOnClientDisconnect(request.raw, reply.raw, controller);
      await new Promise((resolve) => setTimeout(resolve, 20));
      aborted = controller.signal.aborted;
      reply.raw.end("done");
      dispose();
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("server not listening");
      const response = await fetch(`http://127.0.0.1:${address.port}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test" }),
      });

      expect(await response.text()).toBe("done");
      expect(aborted).toBe(false);
    } finally {
      await app.close();
    }
  });
});
