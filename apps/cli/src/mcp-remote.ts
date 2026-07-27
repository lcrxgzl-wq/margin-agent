import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MARGIN_VERSION } from "./version.js";

export type RemoteMcpTool = {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
};

export type RemoteMcpServer = {
  id: string;
  name: string;
  url: string;
  token?: string;
  enabledTools: Array<Pick<RemoteMcpTool, "name" | "description" | "inputSchema">>;
};

type RemoteMcpStore = { servers: RemoteMcpServer[] };

const MAX_SERVERS = 8;
const MAX_TOOLS = 100;
const MAX_RESULT_CHARS = 64_000;
const MAX_TOKEN_CHARS = 8_192;
const MAX_SCHEMA_CHARS = 32_000;
const TIMEOUT_MS = 20_000;

function settingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".margin", "mcp-settings.json");
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { type: "object" };
  const serialized = JSON.stringify(candidate);
  if (serialized.length > MAX_SCHEMA_CHARS) throw new Error("MCP tool input schema is too large");
  return JSON.parse(serialized) as Record<string, unknown>;
}

export function normalizeRemoteMcpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("MCP URL 格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP 仅支持远程 http(s)，不支持 stdio/命令启动");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("MCP URL 不得包含用户信息或片段");
  }
  return url.toString();
}

function serverId(url: string): string {
  return `mcp-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function validateRemoteMcpAuth(url: string, token?: string): void {
  const value = token?.trim();
  if (!value) return;
  if (value.length > MAX_TOKEN_CHARS) throw new Error("MCP Token 过长");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("远程 MCP 携带 Token 时必须使用 HTTPS；HTTP 仅允许本机回环地址");
  }
}

function redactMcpError(error: unknown, token?: string): Error {
  let message = error instanceof Error ? error.message : String(error);
  const secret = token?.trim();
  if (secret) {
    for (const value of new Set([secret, encodeURIComponent(secret)])) {
      if (value) message = message.split(value).join("[REDACTED]");
    }
  }
  return new Error(message);
}

export function readRemoteMcpStore(workspaceRoot: string): RemoteMcpStore {
  const file = settingsPath(workspaceRoot);
  if (!fs.existsSync(file)) return { servers: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RemoteMcpStore;
    const servers = Array.isArray(raw.servers) ? raw.servers.slice(0, MAX_SERVERS) : [];
    return {
      servers: servers.flatMap((server) => {
        try {
          const url = normalizeRemoteMcpUrl(server.url);
          const enabledTools = Array.isArray(server.enabledTools)
            ? server.enabledTools
                .filter((tool) => tool && typeof tool.name === "string" && tool.name.length <= 120)
                .slice(0, MAX_TOOLS)
                .map((tool) => ({
                  name: tool.name,
                  description: typeof tool.description === "string" ? tool.description.slice(0, 500) : "",
                  inputSchema: normalizeInputSchema(tool.inputSchema),
                }))
            : [];
          return [{
            id: serverId(url),
            name: String(server.name || new URL(url).hostname).slice(0, 80),
            url,
            token: typeof server.token === "string" ? server.token : undefined,
            enabledTools,
          }];
        } catch {
          return [];
        }
      }),
    };
  } catch {
    return { servers: [] };
  }
}

async function writeRemoteMcpStore(workspaceRoot: string, store: RemoteMcpStore): Promise<void> {
  const file = settingsPath(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.promises.rename(temporary, file);
}

async function withClient<T>(
  input: { url: string; token?: string },
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const url = normalizeRemoteMcpUrl(input.url);
  validateRemoteMcpAuth(url, input.token);
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const client = new Client({ name: "margin", version: MARGIN_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      redirect: "error",
      ...(input.token?.trim()
        ? { headers: { Authorization: `Bearer ${input.token.trim()}` } }
        : {}),
    },
    reconnectionOptions: {
      initialReconnectionDelay: 250,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        return run(client);
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP 请求超时（${TIMEOUT_MS}ms）`)), TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    throw redactMcpError(error, input.token);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

export async function discoverRemoteMcp(input: {
  url: string;
  token?: string;
}): Promise<{ url: string; tools: RemoteMcpTool[]; latencyMs: number }> {
  const started = Date.now();
  const url = normalizeRemoteMcpUrl(input.url);
  const tools = await withClient({ ...input, url }, async (client) => {
    const result = await client.listTools();
    return result.tools.slice(0, MAX_TOOLS).map((tool) => ({
      name: tool.name,
      description: tool.description?.slice(0, 500) ?? "",
      readOnly: tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true,
      inputSchema: normalizeInputSchema(tool.inputSchema),
    }));
  });
  return { url, tools, latencyMs: Math.max(0, Date.now() - started) };
}

export async function discoverWorkspaceRemoteMcp(
  workspaceRoot: string,
  input: { url: string; token?: string; serverId?: string },
): Promise<{ url: string; tools: RemoteMcpTool[]; latencyMs: number }> {
  const url = normalizeRemoteMcpUrl(input.url);
  const stored = input.serverId
    ? readRemoteMcpStore(workspaceRoot).servers.find(
        (server) => server.id === input.serverId && server.url === url,
      )
    : undefined;
  return discoverRemoteMcp({
    url,
    token: input.token?.trim() || stored?.token,
  });
}

export async function saveRemoteMcpServer(
  workspaceRoot: string,
  input: { name?: string; url: string; token?: string; clearToken?: boolean; enabledTools: string[] },
): Promise<RemoteMcpServer> {
  const existingStore = readRemoteMcpStore(workspaceRoot);
  const url = normalizeRemoteMcpUrl(input.url);
  const existing = existingStore.servers.find((server) => server.id === serverId(url));
  const token = input.clearToken ? undefined : input.token?.trim() || existing?.token;
  const discovered = await discoverRemoteMcp({ url, token });
  const requested = new Set(input.enabledTools.filter(Boolean));
  const enabledTools = discovered.tools
    .filter((tool) => tool.readOnly && requested.has(tool.name))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  if (!enabledTools.length) throw new Error("至少选择一个只读 MCP 工具");
  if (requested.size !== enabledTools.length) {
    throw new Error("所选 MCP 工具不存在、未标记只读或具有破坏性");
  }
  const server: RemoteMcpServer = {
    id: serverId(url),
    name: String(input.name?.trim() || new URL(url).hostname).slice(0, 80),
    url,
    token,
    enabledTools,
  };
  const servers = [
    ...existingStore.servers.filter((candidate) => candidate.id !== server.id),
    server,
  ].slice(-MAX_SERVERS);
  await writeRemoteMcpStore(workspaceRoot, { servers });
  return server;
}

export async function removeRemoteMcpServer(workspaceRoot: string, id: string): Promise<void> {
  const store = readRemoteMcpStore(workspaceRoot);
  await writeRemoteMcpStore(workspaceRoot, {
    servers: store.servers.filter((server) => server.id !== id),
  });
}

function publicServer(server: RemoteMcpServer) {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    tokenSet: !!server.token,
    enabledTools: server.enabledTools,
  };
}

export function publicRemoteMcpServers(workspaceRoot: string) {
  return readRemoteMcpStore(workspaceRoot).servers.map(publicServer);
}

export function listEnabledRemoteMcpTools(workspaceRoot: string) {
  return readRemoteMcpStore(workspaceRoot).servers.flatMap((server) =>
    server.enabledTools.map((tool) => ({
      serverId: server.id,
      serverName: server.name,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  );
}

export async function callEnabledRemoteMcpTool(
  workspaceRoot: string,
  input: { serverId: string; name: string; arguments?: Record<string, unknown> },
): Promise<string> {
  const server = readRemoteMcpStore(workspaceRoot).servers.find(
    (candidate) => candidate.id === input.serverId,
  );
  if (!server) throw new Error("MCP server is not configured");
  if (!server.enabledTools.some((tool) => tool.name === input.name)) {
    throw new Error("MCP tool is not enabled");
  }
  return withClient(server, async (client) => {
    const tools = await client.listTools();
    const current = tools.tools.find((tool) => tool.name === input.name);
    if (!current || current.annotations?.readOnlyHint !== true || current.annotations?.destructiveHint === true) {
      throw new Error("MCP tool is no longer marked read-only");
    }
    const result = await client.callTool({
      name: input.name,
      arguments: input.arguments ?? {},
    });
    const rawContent = (result as { content?: unknown }).content;
    const text = Array.isArray(rawContent)
      ? rawContent.map((value) => {
          const item = value && typeof value === "object"
            ? value as Record<string, unknown>
            : {};
          if (item.type === "text" && typeof item.text === "string") return item.text;
          if (item.type === "resource" && item.resource && typeof item.resource === "object") {
            const resource = item.resource as Record<string, unknown>;
            if (typeof resource.text === "string") return resource.text;
          }
          if (item.type === "resource_link" && typeof item.uri === "string") return item.uri;
          return `[unsupported MCP content: ${String(item.type ?? "unknown")}]`;
        }).join("\n")
      : JSON.stringify((result as { toolResult?: unknown }).toolResult);
    const structuredContent = (result as { structuredContent?: unknown }).structuredContent;
    const structured = structuredContent
      ? `\n${JSON.stringify(structuredContent)}`
      : "";
    return `${text}${structured}`.slice(0, MAX_RESULT_CHARS);
  });
}
