import { z } from "zod";
import {
  LlmProposalOutputSchema,
  type BlockSnapshot,
  type LlmProposalOutput,
  type RiskLevel,
} from "@margin/domain";
import { directIdentity, getHarness } from "@margin/harness";
import { type ChatHistoryTurn } from "./history.js";
import {
  buildAgentUserPrompt,
  mockAgentReply,
} from "./agent-reply.js";
import {
  canonicalizeProviderBaseURL,
  testLlmModelConnection,
  type LlmProbeResult,
} from "./provider-probe.js";
import {
  extractUsage,
  marginRequestHeaders,
  reportModelUsage,
} from "./request-policy.js";

export {
  canonicalizeProviderBaseURL,
  discoverLlmModels,
  testLlmModelConnection,
  type LlmApiFormat,
  type LlmAuthStyle,
  type LlmProviderProbeInput,
  type LlmModelProbeInput,
  type LlmModelOption,
  type LlmProbeResult,
} from "./provider-probe.js";
export {
  configureRequestPolicy,
  extractUsage,
  marginRequestHeaders,
  reportModelUsage,
  type ModelRequestPath,
  type ModelUsage,
  type ModelUsageEntry,
} from "./request-policy.js";

export type { ChatHistoryTurn } from "./history.js";
export { formatHistoryForPrompt, trimHistory } from "./history.js";
export { mockAgentReply, agentSystemPrompt } from "./agent-reply.js";

const OutputSchema = z.object({
  blockId: z.string(),
  after: z.string().min(1),
  rationale: z.string().min(1),
  risk: z.enum(["language", "structure", "argument", "fact"]).default("language"),
  evidence: z.array(z.string()).default([]),
});

const MAX_COMPLETION_BYTES = 1024 * 1024;
const COMPLETION_TIMEOUT_MS = 90_000;

type RuntimeFormat = "openai" | "anthropic";

function runtimeFormat(): RuntimeFormat {
  return (process.env.MARGIN_API_FORMAT || process.env.MARGIN_PROVIDER || "openai")
    .toLowerCase() === "anthropic" ? "anthropic" : "openai";
}

function runtimeApiKey(format: RuntimeFormat): string | undefined {
  return format === "anthropic"
    ? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? process.env.MARGIN_API_KEY
    : process.env.OPENAI_API_KEY ?? process.env.MARGIN_API_KEY;
}

function runtimeEndpoint(format: RuntimeFormat): string {
  const fallback = format === "anthropic"
    ? "https://api.anthropic.com"
    : "https://api.openai.com/v1";
  const base = canonicalizeProviderBaseURL(process.env.MARGIN_BASE_URL || fallback, format);
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  if (format === "anthropic") {
    url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/messages`;
  } else {
    url.pathname = `${path}/chat/completions`;
  }
  return url.toString();
}

function runtimeHeaders(format: RuntimeFormat, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...marginRequestHeaders(),
  };
  if (format === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (process.env.MARGIN_AUTH_STYLE === "bearer") headers.Authorization = `Bearer ${key}`;
    else headers["x-api-key"] = key;
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

async function readBoundedCompletion(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_COMPLETION_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("LLM response exceeds 1 MiB");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_COMPLETION_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("LLM response exceeds 1 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function requestTextCompletion(
  prompt: string,
  system: string,
  signal?: AbortSignal,
): Promise<string> {
  const format = runtimeFormat();
  const key = runtimeApiKey(format);
  if (!key && !process.env.MARGIN_BASE_URL) throw new Error("LLM is not configured");
  const model = process.env.MARGIN_MODEL || (format === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini");
  const body = format === "anthropic"
    ? { model, max_tokens: 4096, system, messages: [{ role: "user", content: prompt }] }
    : { model, max_tokens: 4096, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] };
  const timeout = AbortSignal.timeout(COMPLETION_TIMEOUT_MS);
  const headers = runtimeHeaders(format, key ?? "ollama");
  const response = await fetch(runtimeEndpoint(format), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`LLM request failed (HTTP ${response.status})`);
  }
  const raw = await readBoundedCompletion(response);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("LLM endpoint returned invalid JSON");
  }
  const usage = extractUsage(format, payload);
  if (usage) {
    reportModelUsage({
      path: "legacy",
      model,
      ...usage,
      requestId: headers["X-Client-Request-Id"] ?? "",
    });
  }
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (format === "anthropic") {
    const content = Array.isArray(record.content) ? record.content : [];
    return content
      .map((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? String((item as { text: string }).text)
        : "")
      .join("")
      .trim();
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content.trim() : "";
}

function parseProposalJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("LLM endpoint returned invalid proposal JSON");
  }
}

export type GenerateInput = {
  block: BlockSnapshot;
  neighbors?: BlockSnapshot[];
  styleHint?: string;
  harnessId?: string;
  /** Directed rewrite instruction from the author. */
  instruction?: string;
  signal?: AbortSignal;
};

function mockProposal(input: GenerateInput): LlmProposalOutput {
  const instruction = input.instruction?.trim();
  const after = instruction
    ? `${input.block.text}\n\n（按指令草案：${instruction.slice(0, 120)}——请人工审定；勿新增无来源引用。）`
    : `${input.block.text}\n\n（边注建议：补一句理论桥接，并点明文献对话切口；勿新增无来源引用。）`;
  return LlmProposalOutputSchema.parse({
    blockId: input.block.id,
    after,
    rationale: instruction
      ? `按用户指令：${instruction.slice(0, 200)}（mock）`
      : "补充可辩护的理论桥接（mock）",
    risk: "argument" satisfies RiskLevel,
    evidence: [],
  });
}

function validateOutput(blockId: string, object: unknown): LlmProposalOutput {
  const parsed = LlmProposalOutputSchema.parse(object);
  if (parsed.blockId !== blockId) {
    throw new Error("LLM returned foreign blockId");
  }
  if (!parsed.after.trim()) {
    throw new Error("LLM returned empty after");
  }
  return parsed;
}

export async function generateProposal(input: GenerateInput): Promise<LlmProposalOutput> {
  const apiKey = runtimeApiKey(runtimeFormat());
  const baseURL = process.env.MARGIN_BASE_URL;
  const harness = getHarness(input.harnessId);

  if (!apiKey && !baseURL) {
    return mockProposal(input);
  }

  const neighborText = (input.neighbors ?? [])
    .map((n) => `- (${n.id}) ${n.text.slice(0, 200)}`)
    .join("\n");

  const instruction = input.instruction?.trim();
  const prompt = `目标块 id=${input.block.id} kind=${input.block.kind}
正文:
"""
${input.block.text}
"""
相邻上下文:
${neighborText || "(无)"}
风格提示: ${input.styleHint ?? harness.styleHint}
${instruction ? `作者指令（必须优先遵循）:\n"""\n${instruction.slice(0, 600)}\n"""` : ""}
请提出一处改进${instruction ? "（严格按作者指令改写，勿跑题）" : ""}。勿新增无来源引用或虚构访谈。`;

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completion = await requestTextCompletion(
        `${attempt === 0 ? prompt : `${prompt}\n\n上次输出不合规，请严格返回同一 blockId 与非空 after。`}\n\n只返回 JSON：{"blockId":"...","after":"...","rationale":"...","risk":"language|structure|argument|fact","evidence":[]}`,
        directIdentity(input.harnessId),
        input.signal,
      );
      const object = OutputSchema.parse(parseProposalJson(completion));
      return validateOutput(input.block.id, object);
    } catch (err) {
      if (input.signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type DiscussInput = {
  message: string;
  excerpt?: string;
  outlineHint?: string;
  harnessId?: string;
  /** Prior turns (excluding the current user message). */
  history?: ChatHistoryTurn[];
  hasDocument?: boolean;
  signal?: AbortSignal;
};

/** Conversational agent reply (no proposals, no command-menu tone). */
export async function generateDiscuss(input: DiscussInput): Promise<string> {
  return streamDiscuss(input);
}

/** Yield reply text in chunks (mock paced; BYOK uses provider stream). */
export async function streamDiscuss(
  input: DiscussInput,
  onDelta?: (chunk: string) => void,
): Promise<string> {
  const apiKey = runtimeApiKey(runtimeFormat());
  const baseURL = process.env.MARGIN_BASE_URL;
    const replyInput = {
    message: input.message,
    excerpt: input.excerpt,
    outlineHint: input.outlineHint,
    history: input.history,
    hasDocument: input.hasDocument,
  };

  if (!apiKey && !baseURL) {
    const text = mockAgentReply(replyInput);
    await emitTextChunks(text, onDelta);
    return text;
  }

  try {
    const full = await requestTextCompletion(
      buildAgentUserPrompt(replyInput),
      directIdentity(input.harnessId),
      input.signal,
    );
    const text = full.trim() || mockAgentReply(replyInput);
    await emitTextChunks(text, onDelta, { delayMs: 0 });
    return text;
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw error;
  }
}

/** Pace offline/tool replies so UI feels live without fake 64-char post-cut. */
export async function emitTextChunks(
  text: string,
  onDelta?: (chunk: string) => void,
  opts?: { chunkSize?: number; delayMs?: number },
): Promise<void> {
  if (!onDelta) return;
  const size = opts?.chunkSize ?? 48;
  const delay = opts?.delayMs ?? 12;
  if (!text) return;
  if (text.length <= size) {
    onDelta(text);
    return;
  }
  for (let i = 0; i < text.length; i += size) {
    onDelta(text.slice(i, i + size));
    if (delay > 0 && i + size < text.length) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Minimal connectivity probe for Settings. */
export async function probeLlmConnection(input?: {
  model?: string;
}): Promise<LlmProbeResult> {
  const format = (
    process.env.MARGIN_API_FORMAT ||
    process.env.MARGIN_PROVIDER ||
    "openai"
  ).toLowerCase() === "anthropic"
    ? "anthropic"
    : "openai";
  const apiKey =
    format === "anthropic"
      ? process.env.ANTHROPIC_AUTH_TOKEN ??
        process.env.ANTHROPIC_API_KEY ??
        process.env.MARGIN_API_KEY
      : process.env.OPENAI_API_KEY ?? process.env.MARGIN_API_KEY;
  const baseURL = process.env.MARGIN_BASE_URL;
  if (!apiKey && !baseURL) {
    return {
      ok: false,
      models: [],
      latencyMs: 0,
      detail: "未配置 API Key / Base URL（当前为离线）",
    };
  }
  const authStyle = process.env.MARGIN_AUTH_STYLE === "bearer" ? "bearer" : "apikey";
  return testLlmModelConnection({
    apiFormat: format,
    baseURL:
      baseURL ||
      (format === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
    apiKey,
    authStyle,
    model:
      input?.model ??
      process.env.MARGIN_MODEL ??
      (format === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini"),
  });
}

