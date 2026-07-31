import { randomUUID } from "node:crypto";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createPiSummarizer,
  orchestrateCompaction,
  pruneToolOutputs,
  type CompactionEvent,
  type CompactionOutcome,
  type ContextTierName,
  type SummarizerFn,
} from "./compaction.js";
import {
  marginRequestHeaders,
  reportModelUsage,
  type ModelUsage,
} from "@margin/llm";
import { toolPhaseLabel } from "./progress.js";
import { LiteralThinkingBlockFilter } from "./assistant-text.js";

export type PiLoopOutcome = "completed" | "aborted" | "timed_out" | "error";

export type PiLoopOptions = {
  /** The user turn to run; prompt construction remains with the caller. */
  prompt: string;
  systemPrompt: string;
  tools: AgentTool[];
  messages?: AgentMessage[];
  model: unknown;
  apiKey?: string;
  sessionId?: string;
  /** Explicit Pi thinking level; undefined keeps reasoning controls omitted ("off"). */
  thinkingLevel?: "low" | "medium" | "high";
  /** Usage-recording path label for this loop. */
  usagePath?: "pi-chat" | "pi-scan";
  maxTurns?: number;
  timeoutMs?: number;
  maxContextMessages?: number;
  maxContextChars?: number;
  /** Floor for the final tool/text compaction rung; defaults to 32 (status quo). */
  toolCompactionFloor?: number;
  /** Optional stricter allowlist; defaults to the tools actually mounted. */
  allowedToolNames?: readonly string[];
  onProgress?: (phase: string, tool?: string) => void;
  onDelta?: (chunk: string) => void;
  /** Model context window; enables usage-triggered compaction when set. */
  contextWindow?: number;
  /** Context tier; eco never summarizes (prune + trim ladder only). */
  contextTier?: ContextTierName;
  /** Automatic compaction (threshold trigger + overflow retry); default true. */
  compactionAuto?: boolean;
  /** Test seam: injected summarizer; defaults to pi generateSummary. */
  summarizer?: SummarizerFn;
  /** Compaction events (archiving / UI visibility handled by the host). */
  onCompaction?: (event: CompactionEvent) => void;
  /** Last compaction summary, for incremental summary updates. */
  previousSummary?: string;
  /** Synthetic decision snapshot appended to the summarizer input (Round B host wiring). */
  domainSnapshot?: string;
  signal?: AbortSignal;
};

export type ToolAuditEvent = {
  toolCallId: string;
  toolName: string;
  status: "completed" | "error" | "blocked" | "aborted";
  durationMs: number;
  args?: unknown;
};

export type PiLoopResult = {
  messages: AgentMessage[];
  outcome: PiLoopOutcome;
  notes: string[];
  streamedText: string;
  errorMessage?: string;
  toolAudit: ToolAuditEvent[];
};

function unfinishedToolStatus(outcome: PiLoopOutcome): "error" | "aborted" {
  return outcome === "aborted" || outcome === "timed_out" ? "aborted" : "error";
}

const DEFAULT_MAX_CONTEXT_MESSAGES = 80;
const DEFAULT_MAX_CONTEXT_CHARS = 200_000;
const REDACTED_KEY = /(?:api.?key|authorization|cookie|password|secret|token)/i;

function serializedChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function summarizeValue(value: unknown, depth = 0, stringLimit = 500): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > stringLimit
      ? `${value.slice(0, stringLimit)}...[${value.length} chars]`
      : value;
  }
  if (depth >= 3) return "[nested]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => summarizeValue(item, depth + 1, stringLimit));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[key] = REDACTED_KEY.test(key)
        ? "[REDACTED]"
        : summarizeValue(item, depth + 1, stringLimit);
    }
    return out;
  }
  return String(value);
}

export function summarizeToolArguments(value: unknown): unknown {
  const summary = summarizeValue(value);
  if (serializedChars(summary) <= 2_000) return summary;
  return { summary: "[arguments omitted]", chars: serializedChars(value) };
}

function roleOf(message: AgentMessage): string | undefined {
  return message && typeof message === "object" && "role" in message
    ? String((message as { role?: unknown }).role ?? "")
    : undefined;
}

function compactToolMessages(messages: AgentMessage[], textLimit: number): AgentMessage[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    if (roleOf(message) === "toolResult") {
      const toolResult = message as unknown as {
        content?: Array<Record<string, unknown>>;
        details?: unknown;
      };
      return {
        ...message,
        content: Array.isArray(toolResult.content)
          ? toolResult.content.map((item) =>
              item.type === "text" && typeof item.text === "string" && item.text.length > textLimit
                ? { ...item, text: `${item.text.slice(0, textLimit)}...[tool output truncated]` }
                : item,
            )
          : toolResult.content,
        details: summarizeValue(toolResult.details, 0, 200),
      } as unknown as AgentMessage;
    }
    if (roleOf(message) === "assistant") {
      const assistant = message as unknown as { content?: Array<Record<string, unknown>> };
      if (!Array.isArray(assistant.content)) return message;
      return {
        ...message,
        content: assistant.content.map((item) =>
          item.type === "toolCall" && item.arguments
            ? { ...item, arguments: summarizeValue(item.arguments, 0, 200) }
            : item,
        ),
      } as unknown as AgentMessage;
    }
    return message;
  });
}

function compactAllMessageText(messages: AgentMessage[], textLimit: number): AgentMessage[] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (roleOf(messages[index]!) === "user") {
      latestUserIndex = index;
      break;
    }
  }
  return messages.map((message, index) => {
    if (!message || typeof message !== "object") return message;
    // The current request is immutable. If it alone exceeds this soft budget,
    // let the provider reject it visibly instead of changing what the author asked.
    if (index === latestUserIndex) return message;
    const value = message as unknown as {
      content?: string | Array<Record<string, unknown>>;
    };
    const truncate = (text: string) => text.length > textLimit
      ? `${text.slice(0, textLimit)}...[message text truncated]`
      : text;
    return {
      ...message,
      content: typeof value.content === "string"
        ? truncate(value.content)
        : Array.isArray(value.content)
          ? value.content.map((item) =>
              item.type === "text" && typeof item.text === "string"
                ? { ...item, text: truncate(item.text) }
                : item,
            )
          : value.content,
    } as unknown as AgentMessage;
  });
}

function dropOldestContextUnit(messages: AgentMessage[]): boolean {
  const start = roleOf(messages[0]!) === "user" ? 1 : 0;
  if (start >= messages.length) return false;
  let end = start + 1;
  if (roleOf(messages[start]!) === "assistant") {
    while (end < messages.length && roleOf(messages[end]!) === "toolResult") end += 1;
  } else if (roleOf(messages[start]!) === "toolResult") {
    while (end < messages.length && roleOf(messages[end]!) === "toolResult") end += 1;
  }
  messages.splice(start, end - start);
  return true;
}

/** Keep recent complete user-started turns and bound tool payloads for provider context. */
export function trimAgentMessages(
  messages: AgentMessage[],
  maxMessages = DEFAULT_MAX_CONTEXT_MESSAGES,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
  toolCompactionFloor = 32,
): AgentMessage[] {
  let trimmed = [...messages];
  if (trimmed.length > maxMessages) {
    const cutoff = trimmed.length - maxMessages;
    const nextUser = trimmed.findIndex((message, index) => index >= cutoff && roleOf(message) === "user");
    if (nextUser >= 0) {
      trimmed = trimmed.slice(nextUser);
    } else {
      let lastUser = -1;
      for (let index = trimmed.length - 1; index >= 0; index -= 1) {
        if (roleOf(trimmed[index]!) === "user") {
          lastUser = index;
          break;
        }
      }
      if (lastUser >= 0) trimmed = trimmed.slice(lastUser);
      while (trimmed.length > maxMessages && dropOldestContextUnit(trimmed)) {
        // Keep the current user request plus the most recent complete tool units.
      }
      if (trimmed.length > maxMessages) trimmed = trimmed.slice(-maxMessages);
    }
  }
  while (serializedChars(trimmed) > maxChars) {
    const nextUser = trimmed.findIndex((message, index) => index > 0 && roleOf(message) === "user");
    if (nextUser < 0) break;
    trimmed = trimmed.slice(nextUser);
  }
  if (serializedChars(trimmed) > maxChars) trimmed = compactToolMessages(trimmed, 4_000);
  if (serializedChars(trimmed) > maxChars) trimmed = compactToolMessages(trimmed, 512);
  if (serializedChars(trimmed) > maxChars) trimmed = compactAllMessageText(trimmed, 512);
  if (serializedChars(trimmed) > maxChars) trimmed = compactAllMessageText(trimmed, 128);
  while (serializedChars(trimmed) > maxChars && dropOldestContextUnit(trimmed)) {
    // Last resort for one oversized turn: preserve its user request and newest complete units.
  }
  if (serializedChars(trimmed) > maxChars) trimmed = compactAllMessageText(trimmed, Math.max(32, toolCompactionFloor));
  return trimmed;
}

export async function runPiAgentLoop(opts: PiLoopOptions): Promise<PiLoopResult> {
  const combined = new AbortController();
  const notes: string[] = [];
  const toolAudit: ToolAuditEvent[] = [];
  const toolStarts = new Map<string, { startedAt: number; args: unknown; name: string }>();
  const usageRequestId = randomUUID();
  const usageTotal: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Shared request policy: margin identity headers on every provider request.
  // Also forward model.headers (Bearer Authorization) into options.headers —
  // pi-ai's auth gate only inspects options.apiKey / options.headers.
  const streamFn: StreamFn = (model, context, options) => {
    const modelHeaders =
      model &&
      typeof model === "object" &&
      "headers" in model &&
      model.headers &&
      typeof model.headers === "object"
        ? (model.headers as Record<string, string>)
        : {};
    return streamSimple(model, context, {
      ...options,
      headers: {
        ...modelHeaders,
        ...(options?.headers ?? {}),
        ...marginRequestHeaders(),
      },
    });
  };
  const contextMessageLimit = opts.maxContextMessages ?? DEFAULT_MAX_CONTEXT_MESSAGES;
  const contextCharLimit = opts.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const forwardAbort = () => {
    if (!combined.signal.aborted) combined.abort();
  };

  const tools = opts.tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const toolSignal = signal
        ? AbortSignal.any([combined.signal, signal])
        : combined.signal;
      if (toolSignal.aborted) {
        throw new Error("tool aborted");
      }
      return tool.execute(toolCallId, params as never, toolSignal);
    },
  }));
  const mountedToolNames = new Set(tools.map((tool) => tool.name));
  const allowedToolNames = new Set(
    opts.allowedToolNames
      ? opts.allowedToolNames.filter((name) => mountedToolNames.has(name))
      : mountedToolNames,
  );
  const terminatingToolCalls = new Set<string>();
  const turnCap = opts.maxTurns ?? 20;
  const limit = opts.timeoutMs ?? 300_000;
  let turns = 0;
  let outcome: PiLoopOutcome = "completed";
  let streamedText = "";
  let thrownError: string | undefined;
  const visibleTextFilter = new LiteralThinkingBlockFilter();
  const emitVisibleText = (text: string) => {
    if (!text) return;
    streamedText += text;
    opts.onDelta?.(text);
  };

  // Context compaction state (Round A): prune always; summarize when the
  // tier allows it, the user has not disabled it, and this session has not
  // given up after a non-shrinking compaction.
  let previousSummary = opts.previousSummary;
  let lastCompactionAt: number | undefined;
  let autoCompactionDisabled = false;
  const contextTier: ContextTierName = opts.contextTier ?? "standard";
  const compactionAuto = opts.compactionAuto !== false;
  // C3: with auto compaction on a non-eco tier the state holds the full
  // transcript; trimming is a per-request view only (transformContext), and
  // growth is bounded by compaction itself. Eco / compactionAuto=false keep
  // the documented degraded path of trimming state directly.
  const fullTranscriptState = compactionAuto && contextTier !== "eco";
  const modelAuthHeaders =
    opts.model &&
    typeof opts.model === "object" &&
    "headers" in opts.model &&
    opts.model.headers &&
    typeof opts.model.headers === "object"
      ? (opts.model.headers as Record<string, string>)
      : {};
  const summarizer =
    opts.summarizer ??
    createPiSummarizer({
      model: opts.model as never,
      apiKey: opts.apiKey,
      headers: { ...modelAuthHeaders, ...marginRequestHeaders() },
    });
  const reportCompaction = (
    reason: CompactionEvent["reason"],
    outcome: Extract<CompactionOutcome, { kind: "compacted" }>,
    messagesBefore: AgentMessage[],
  ) => {
    previousSummary = outcome.summary;
    lastCompactionAt = Date.now();
    notes.push(
      `context compacted (${reason}): ~${outcome.tokensBefore} -> ${outcome.tokensAfter} tokens`,
    );
    opts.onCompaction?.({
      eventId: outcome.eventId,
      reason,
      tokensBefore: outcome.tokensBefore,
      tokensAfter: outcome.tokensAfter,
      summary: outcome.summary,
      messagesBefore,
      messagesAfter: outcome.messages,
    });
  };
  // Returns the per-request context view. Compaction (when it fires) replaces
  // the view with [summary head] + kept tail; otherwise the view is pruned and
  // trimmed — but the pi state is never mutated here.
  const maybeCompactContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const working = pruneToolOutputs(messages).messages;
    if (
      !compactionAuto ||
      contextTier === "eco" ||
      autoCompactionDisabled ||
      !(opts.contextWindow && opts.contextWindow > 0)
    ) {
      return trimAgentMessages(
        working,
        contextMessageLimit,
        contextCharLimit,
        opts.toolCompactionFloor,
      );
    }
    const outcome = await orchestrateCompaction({
      messages: working,
      model: opts.model as never,
      contextWindow: opts.contextWindow,
      tier: contextTier,
      summarizer,
      previousSummary,
      domainSnapshot: opts.domainSnapshot,
      lastCompactionAt,
      signal: combined.signal,
    });
    if (outcome.kind === "compacted") {
      reportCompaction("threshold", outcome, messages);
      return outcome.messages;
    }
    if (outcome.kind === "skipped" && outcome.reason === "not_beneficial") {
      autoCompactionDisabled = true;
      notes.push("auto compaction disabled: summary would not shrink context");
    } else if (outcome.kind === "failed") {
      notes.push(`compaction failed, falling back to trim: ${outcome.error}`);
    }
    return trimAgentMessages(
      outcome.messages,
      contextMessageLimit,
      contextCharLimit,
      opts.toolCompactionFloor,
    );
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: opts.model as never,
      thinkingLevel: opts.thinkingLevel ?? "off",
      tools: tools as AgentTool[],
      messages: fullTranscriptState
        ? (opts.messages ?? [])
        : trimAgentMessages(
            opts.messages ?? [],
            contextMessageLimit,
            contextCharLimit,
            opts.toolCompactionFloor,
          ),
    },
    transformContext: async (messages) => maybeCompactContext(messages),
    beforeToolCall: async ({ toolCall, args }) => {
      const summary = summarizeToolArguments(args);
      if (!allowedToolNames.has(toolCall.name)) {
        toolAudit.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          status: "blocked",
          durationMs: 0,
          args: summary,
        });
        if (notes.length < 12) notes.push(`blocked unauthorized tool ${toolCall.name}`);
        return { block: true, reason: `Tool ${toolCall.name} is not allowed by the active profile` };
      }
      toolStarts.set(toolCall.id, {
        startedAt: Date.now(),
        args: summary,
        name: toolCall.name,
      });
      return undefined;
    },
    afterToolCall: async ({ toolCall, result, isError }) => {
      if (result?.terminate === true) terminatingToolCalls.add(toolCall.id);
      const started = toolStarts.get(toolCall.id);
      if (!started) return undefined;
      toolStarts.delete(toolCall.id);
      toolAudit.push({
        toolCallId: toolCall.id,
        toolName: started.name,
        status: isError ? "error" : "completed",
        durationMs: Math.max(0, Date.now() - started.startedAt),
        args: started.args,
      });
      return undefined;
    },
    toolExecution: "sequential",
    streamFn,
    getApiKey: async () => opts.apiKey,
    sessionId: opts.sessionId,
  });

  const abort = (nextOutcome: Exclude<PiLoopOutcome, "completed">, note: string) => {
    if (outcome !== "completed") return;
    outcome = nextOutcome;
    notes.push(note);
    forwardAbort();
    agent.abort();
  };

  const onExternalAbort = () => abort("aborted", "aborted by external signal");
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (opts.signal?.aborted) onExternalAbort();

  const unsub = agent.subscribe((event) => {
    if (event.type === "message_end") {
      const message = event.message as { role?: string; usage?: Partial<ModelUsage> };
      if (message.role === "assistant") emitVisibleText(visibleTextFilter.finish());
      if (message.role === "assistant" && message.usage) {
        usageTotal.input += message.usage.input ?? 0;
        usageTotal.output += message.usage.output ?? 0;
        usageTotal.cacheRead += message.usage.cacheRead ?? 0;
        usageTotal.cacheWrite += message.usage.cacheWrite ?? 0;
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      opts.onProgress?.(toolPhaseLabel(event.toolName), event.toolName);
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as { type?: string; delta?: string };
      if (update.type === "text_delta" && typeof update.delta === "string" && update.delta) {
        emitVisibleText(visibleTextFilter.push(update.delta));
      }
      return;
    }
    if (event.type === "tool_execution_end" && event.isError) {
      const result = event.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const detail = result?.content
        ?.filter((item) => item.type === "text" && item.text)
        .map((item) => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .slice(0, 300);
      // Recoverable tool failures (unknown blockId, missing source, etc.) must
      // stay in the transcript so the model can list/search and continue.
      if (notes.length < 12) {
        notes.push(`tool ${event.toolName} failed${detail ? `: ${detail}` : ""}`);
      }
      return;
    }
    if (event.type === "turn_end") {
      turns += 1;
      const content = (event.message as { content?: Array<{ type?: string; id?: string }> }).content;
      const toolCallIds = Array.isArray(content)
        ? content
            .filter((item) => item.type === "toolCall" && typeof item.id === "string")
            .map((item) => item.id!)
        : [];
      const terminated = toolCallIds.length > 0 && toolCallIds.every(
        (toolCallId) => terminatingToolCalls.has(toolCallId),
      );
      for (const toolCallId of toolCallIds) terminatingToolCalls.delete(toolCallId);
      if (turns >= turnCap && toolCallIds.length > 0 && !terminated) {
        abort("aborted", `stopped after ${turnCap} turns`);
      }
    }
  });

  const timer = setTimeout(() => abort("timed_out", `aborted after ${limit}ms`), limit);

  let overflowRetried = false;
  const maybeRetryOverflowOnce = async () => {
    if (overflowRetried || !compactionAuto || combined.signal.aborted) return;
    const messages = agent.state.messages as AgentMessage[];
    const last = messages[messages.length - 1] as
      | { role?: string; stopReason?: string; errorMessage?: string }
      | undefined;
    if (!last || last.role !== "assistant" || last.stopReason !== "error" || !last.errorMessage) {
      return;
    }
    if (!isContextOverflow(last as never, opts.contextWindow)) return;
    overflowRetried = true;
    notes.push("context overflow: compacted transcript and retried once");
    // Delete the failed assistant message, compact the transcript, retry once.
    const cleaned = pruneToolOutputs(messages.slice(0, -1)).messages;
    let compacted: AgentMessage[];
    if (contextTier !== "eco" && opts.contextWindow && opts.contextWindow > 0) {
      const outcome = await orchestrateCompaction({
        messages: cleaned,
        model: opts.model as never,
        contextWindow: opts.contextWindow,
        tier: contextTier,
        summarizer,
        previousSummary,
        domainSnapshot: opts.domainSnapshot,
        force: true,
        signal: combined.signal,
      });
      if (outcome.kind === "compacted") {
        reportCompaction("overflow", outcome, cleaned);
        compacted = outcome.messages;
      } else {
        compacted = trimAgentMessages(
          outcome.messages,
          contextMessageLimit,
          contextCharLimit,
          opts.toolCompactionFloor,
        );
      }
    } else {
      compacted = trimAgentMessages(
        cleaned,
        contextMessageLimit,
        contextCharLimit,
        opts.toolCompactionFloor,
      );
    }
    agent.state.messages = compacted as never;
    await agent.continue();
  };

  try {
    if (!combined.signal.aborted) {
      await agent.prompt(opts.prompt);
      await maybeRetryOverflowOnce();
    }
  } catch (error) {
    if (combined.signal.aborted && outcome === "completed") {
      outcome = "aborted";
      notes.push("aborted by external signal");
    } else if (outcome === "completed") {
      outcome = "error";
      thrownError = error instanceof Error ? error.message : String(error);
      notes.push(`agent error: ${thrownError}`);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    unsub();
  }
  emitVisibleText(visibleTextFilter.finish());

  const errorMessage = agent.state.errorMessage ?? thrownError;
  if (outcome === "completed" && errorMessage) {
    outcome = "error";
    notes.push(`agent error: ${errorMessage}`);
  }

  for (const [toolCallId, started] of toolStarts) {
    toolAudit.push({
      toolCallId,
      toolName: started.name,
      status: unfinishedToolStatus(outcome),
      durationMs: Math.max(0, Date.now() - started.startedAt),
      args: started.args,
    });
  }
  toolStarts.clear();

  if (
    opts.usagePath &&
    (usageTotal.input > 0 ||
      usageTotal.output > 0 ||
      usageTotal.cacheRead > 0 ||
      usageTotal.cacheWrite > 0)
  ) {
    reportModelUsage({
      path: opts.usagePath,
      model: String((opts.model as { id?: string } | undefined)?.id ?? ""),
      ...usageTotal,
      requestId: usageRequestId,
    });
  }

  return {
    messages: fullTranscriptState
      ? agent.state.messages
      : trimAgentMessages(agent.state.messages, contextMessageLimit, contextCharLimit, opts.toolCompactionFloor),
    outcome,
    notes,
    streamedText,
    errorMessage,
    toolAudit,
  };
}
