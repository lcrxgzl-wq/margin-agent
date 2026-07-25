import {
  Agent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { toolPhaseLabel } from "./progress.js";

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
  maxTurns?: number;
  timeoutMs?: number;
  onProgress?: (phase: string, tool?: string) => void;
  onDelta?: (chunk: string) => void;
  signal?: AbortSignal;
};

export type PiLoopResult = {
  messages: AgentMessage[];
  outcome: PiLoopOutcome;
  notes: string[];
  streamedText: string;
  errorMessage?: string;
};

export async function runPiAgentLoop(opts: PiLoopOptions): Promise<PiLoopResult> {
  const combined = new AbortController();
  const forwardAbort = () => {
    if (!combined.signal.aborted) combined.abort();
  };

  const tools = opts.tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
      if (combined.signal.aborted || signal?.aborted) {
        throw new Error("tool aborted");
      }
      const onToolAbort = () => {
        /* Pi may pass its own signal; we check before/after */
      };
      signal?.addEventListener("abort", onToolAbort, { once: true });
      try {
        return await tool.execute(toolCallId, params as never, signal ?? combined.signal);
      } finally {
        signal?.removeEventListener("abort", onToolAbort);
      }
    },
  }));

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: opts.model as never,
      thinkingLevel: "off",
      tools: tools as AgentTool[],
      messages: opts.messages ? [...opts.messages] : [],
    },
    toolExecution: "sequential",
    getApiKey: async () => opts.apiKey,
    sessionId: opts.sessionId,
  });

  const notes: string[] = [];
  const turnCap = opts.maxTurns ?? 20;
  const limit = opts.timeoutMs ?? 120_000;
  let turns = 0;
  let outcome: PiLoopOutcome = "completed";
  let streamedText = "";
  let thrownError: string | undefined;

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
    if (event.type === "tool_execution_start") {
      opts.onProgress?.(toolPhaseLabel(event.toolName), event.toolName);
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as { type?: string; delta?: string };
      if (update.type === "text_delta" && typeof update.delta === "string" && update.delta) {
        streamedText += update.delta;
        opts.onDelta?.(update.delta);
      }
      return;
    }
    if (event.type === "tool_execution_end" && event.isError && notes.length < 12) {
      const result = event.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const detail = result?.content
        ?.filter((item) => item.type === "text" && item.text)
        .map((item) => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .slice(0, 300);
      notes.push(`tool ${event.toolName} failed${detail ? `: ${detail}` : ""}`);
      return;
    }
    if (event.type === "turn_end") {
      turns += 1;
      if (turns >= turnCap) abort("aborted", `stopped after ${turnCap} turns`);
    }
  });

  const timer = setTimeout(() => abort("timed_out", `aborted after ${limit}ms`), limit);

  try {
    if (!combined.signal.aborted) await agent.prompt(opts.prompt);
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

  const errorMessage = agent.state.errorMessage ?? thrownError;
  if (outcome === "completed" && errorMessage) {
    outcome = "error";
    notes.push(`agent error: ${errorMessage}`);
  }

  return {
    messages: agent.state.messages,
    outcome,
    notes,
    streamedText,
    errorMessage,
  };
}
