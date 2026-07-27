import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callEnabledRemoteMcpTool,
  discoverRemoteMcp,
  discoverWorkspaceRemoteMcp,
  publicRemoteMcpServers,
  saveRemoteMcpServer,
} from "./mcp-remote.js";

describe("remote MCP boundary", () => {
  let root: string;
  let httpServer: ReturnType<ReturnType<typeof createMcpExpressApp>["listen"]>;
  let url: string;
  let requiredToken: string | undefined;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-mcp-"));
    requiredToken = undefined;
    const app = createMcpExpressApp();
    app.post("/mcp", async (request, response) => {
      if (requiredToken && request.headers.authorization !== `Bearer ${requiredToken}`) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      const server = new McpServer({ name: "test-mcp", version: "1.0.0" });
      server.registerTool("lookup", {
        description: "Read evidence",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false },
      }, async () => ({ content: [{ type: "text", text: "evidence-result" }] }));
      server.registerTool("delete_everything", {
        description: "Destructive test",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: true },
      }, async () => ({ content: [{ type: "text", text: "should-not-run" }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request, response, request.body);
    });
    httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    const address = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("discovers, persists, and calls only explicitly enabled read-only tools", async () => {
    const discovered = await discoverRemoteMcp({ url });
    expect(discovered.tools).toEqual([
      expect.objectContaining({
        name: "lookup",
        readOnly: true,
        inputSchema: expect.objectContaining({ type: "object" }),
      }),
      expect.objectContaining({ name: "delete_everything", readOnly: false }),
    ]);

    await expect(saveRemoteMcpServer(root, {
      url,
      enabledTools: ["delete_everything"],
    })).rejects.toThrow(/只读|破坏性/);

    const saved = await saveRemoteMcpServer(root, { url, enabledTools: ["lookup"] });
    expect(publicRemoteMcpServers(root)[0]).toMatchObject({
      id: saved.id,
      tokenSet: false,
      enabledTools: [{ name: "lookup" }],
    });
    expect(publicRemoteMcpServers(root)[0]?.enabledTools[0]?.inputSchema).toMatchObject({
      type: "object",
    });
    await expect(callEnabledRemoteMcpTool(root, {
      serverId: saved.id,
      name: "lookup",
    })).resolves.toContain("evidence-result");
    await expect(callEnabledRemoteMcpTool(root, {
      serverId: saved.id,
      name: "delete_everything",
    })).rejects.toThrow(/not enabled/);
  });

  it("refuses to send a bearer token over non-loopback HTTP", async () => {
    await expect(discoverRemoteMcp({
      url: "http://example.com/mcp",
      token: "secret-token",
    })).rejects.toThrow(/HTTPS/);
  });

  it("reuses a stored token only for the same configured server URL", async () => {
    const saved = await saveRemoteMcpServer(root, {
      url,
      token: "stored-secret",
      enabledTools: ["lookup"],
    });
    requiredToken = "stored-secret";

    const discovered = await discoverWorkspaceRemoteMcp(root, {
      url,
      serverId: saved.id,
    });
    expect(discovered.tools).toContainEqual(expect.objectContaining({ name: "lookup" }));

    await expect(discoverWorkspaceRemoteMcp(root, {
      url: `${url}?tenant=other`,
      serverId: saved.id,
    })).rejects.toThrow();
  });

  it("removes a stored token only through the explicit clear contract", async () => {
    const saved = await saveRemoteMcpServer(root, {
      url,
      token: "stored-secret",
      enabledTools: ["lookup"],
    });
    expect(publicRemoteMcpServers(root)[0]?.tokenSet).toBe(true);

    const updated = await saveRemoteMcpServer(root, {
      url,
      clearToken: true,
      enabledTools: ["lookup"],
    });
    expect(updated.id).toBe(saved.id);
    expect(publicRemoteMcpServers(root)[0]?.tokenSet).toBe(false);
  });
});
