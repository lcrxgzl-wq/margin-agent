# Pi shell review

Reviewed against `@earendil-works/pi-agent-core` 0.80.10 (the version locked by Margin). This is a thin, direct use of `Agent`; it does not fork or need `pi-coding-agent`.

## Verdict

Margin is using the core loop correctly at the basic integration level:

- `runPiSessionTurn` restores the prior `AgentMessage[]`, calls `prompt()`, and returns `agent.state.messages`; `ChatAgentState` retains that array for the live CLI session.
- Tool definitions use the native `AgentTool` contract, return `terminate: true` from `finish_turn`, and all tools are deliberately sequential. Sequential execution is appropriate because `open_document` mutates the shared document bag and proposal/comment tools mutate shared arrays.
- `message_update` forwards only `text_delta`, so streaming output is not duplicated by tool events; the non-streamed fallback is sensible.
- A run-level turn cap and deadline call `agent.abort()`, and subscriptions are removed in `finally`.

This is not yet a robust production shell. The important qualification is that `abort()` requests cancellation; it does not make an unresolved `tool.execute()` promise settle. Pi's own API documents the tool's `signal` argument, but Margin's tools ignore it. Thus a stuck provider stream or tool can still leave `await agent.prompt()` (and the HTTP request) pending despite the 120-second timer. The scan path has the same limitation.

## Continuity, tools, streaming, and abort

### Session continuity: correct in-process, incomplete across restart

`apps/cli/src/chat-agent.ts` passes `agentState.agentMessages` into every session turn and replaces it with the returned state. This preserves native user, assistant, and tool-result messages, which is the right unit of continuity for `Agent`.

However, this state is process-local. `saveAgentTranscript()` receives one record only after the completed turn, labelled `role: "assistant"`, with the complete message array embedded as `toolTrail`. It is neither a per-message transcript nor reloaded into `ChatAgentState`. A CLI restart therefore loses Pi context even though the database contains an opaque, truncated-to-50-runs audit artifact. `ChatMemory` is a separate short text memory used only by the offline discussion path, not Pi.

Also, each new `Agent` has no `sessionId`; no provider-side prompt-cache/session identity is supplied. That is optional, but a stable chat/session ID would make a keyed session a better Pi shell where supported.

### Tools: correct safety shape, missing runtime policy and effect classification

The exposed surface is narrow: no shell, arbitrary filesystem, apply, or direct persistence tool is registered. Tool schemas validate arguments, proposal edits retain revision/hash guards, and `finish_turn` uses Pi's native terminate result. Those are strong foundations.

Pi-agent-core 0.80.10 does **not** expose a native `sideEffect` field on `AgentTool`. `details` is the appropriate opaque result metadata channel, and Pi's `beforeToolCall` / `afterToolCall` hooks are the appropriate runtime policy/audit points. Margin currently sets neither:

- Tool result `details` varies by tool and does not consistently identify `read`, `workspace-write`, `session-open`, `draft`, or `comment` effects.
- The host cannot uniformly audit, approve, time-box, or label tool calls in one place.
- The model prompt says writes/opening must use tools, but the runtime does not independently enforce an allowlist or policy classification.

This is a metadata/auditing gap, not a request to add a pretend Pi-native `sideEffect` property.

### Streaming: good model text streaming, limited tool/protocol observability

Text deltas and user-facing tool-start phases are exposed correctly. Tool calls do not emit progress (`onUpdate`) and tool completion/failure metadata is not surfaced to the caller. That is fine for the synchronous local operations today, but it makes a slow `write_workspace_file`, a failing read, or a timeout hard to distinguish in the UI and transcript.

The HTTP streaming route also does not abort the Pi run when the client disconnects. It queues the turn and waits to completion, so an abandoned browser/client can still consume model and tool work.

### Abort and limits: intent is right; guarantee is not

Both runners duplicate a 120-second timer and a turn cap, then call `agent.abort()`. This properly stops a cancellable model stream. It is insufficient for a non-settling tool because every current tool ignores the supplied `AbortSignal`; a generic `Promise.race` alone is unsafe for writes because the underlying write can still finish after the timeout.

The session runner returns a partial run with `notes` after a timeout. The scan runner throws only when the timeout produced zero drafts; it may return timed-out partial drafts. Pick and document one contract (normally: retain completed draft results, mark the run cancelled, and never claim a normal completion).

## Block scan and session turn

They should share a small lifecycle helper, not a single generalized “agent workflow” abstraction.

The two paths repeat model/credential resolution, Agent construction, sequential policy, event subscription, turn counting, deadline setup, cleanup, and error-note handling. They already diverge in behavior: the session path handles text deltas and returns native messages; the scan path does not stream text and starts with an empty message list by design. Duplication is likely to make timeout, cancellation, and auditing fixes land in only one runner.

Extract a `runPiAgentLoop(options)` helper that owns:

1. `Agent` construction with supplied system prompt, tools, messages, optional `sessionId`, and tool hooks;
2. `tool_execution_start/end`, `message_update`, `turn_end`, and `agent_end` event forwarding;
3. deadline, external abort signal, turn budget, cleanup, and a normalized outcome (`completed | aborted | timed_out | error`);
4. returning `agent.state.messages`, error state, event/audit records, and streaming text.

Keep prompt construction, document selection, result extraction, heuristic comments, and persistence in their respective session/scan runners. In particular, scan should continue to pass `messages: []`: it is a bounded, independent document operation, not a chat continuation.

## Prioritized changes

1. **Add cancellable, per-tool execution wrappers.** Change every `execute` signature to receive Pi's `signal`; pass it into bridge/storage operations and check it before committing side effects. Introduce a configurable per-tool timeout by effect class. On timeout, throw a tool error only after the underlying operation is actually cancellable or has been made commit-safe; do not use an untracked `Promise.race` around a write.

2. **Centralize lifecycle/cancellation in `runPiAgentLoop`.** Have both runners use it for the global deadline, turn cap, external request-disconnect abort, `agent.waitForIdle()` settlement, and one explicit partial-result contract. This fixes duplicated logic without coupling session continuity to scans.

3. **Persist and restore a real Pi transcript.** Store native `AgentMessage` entries (or immutable per-turn snapshots) with a conversation ID, run ID, timestamps, outcome, model, and message sequence; restore the latest valid conversation into `ChatAgentState` on session creation. Keep a compact user-facing summary separately. Do not rely on one assistant-labelled `toolTrail` blob for replay.

4. **Add effect metadata and tool hooks.** Define Margin-owned metadata such as `{ effect: "read" | "session-open" | "workspace-write" | "draft" | "comment", target, idempotency }` in every successful tool result. Use `beforeToolCall` to enforce the registered allowlist/effect policy and `afterToolCall` to append duration, outcome, and sanitized metadata to an audit trail. This is the Pi-supported replacement for a nonexistent native `sideEffect` option.

5. **Make the session an explicit Pi session.** Generate a stable conversation/session ID in `ChatAgentState`, pass it as `Agent`'s `sessionId`, record it with the transcript, and surface tool-end/error progress plus cancellation status in NDJSON. This improves provider cache affinity and makes stream failures, aborted clients, and partial work observable.

## Verification criteria

- A deliberately never-resolving read/write bridge either observes the abort signal and settles within its configured tool limit, or fails before making a write visible.
- Disconnecting `/api/v1/chat/stream` aborts the active run and records `aborted`, rather than continuing silently.
- A restart restores the native Pi transcript and a follow-up request can reference a preceding tool result.
- Session and scan tests prove identical timeout/turn-cap/audit behavior while preserving `messages: []` for scans.
- Tool audit records identify effect, target, elapsed time, success/error, and cancellation without storing secrets or full document contents unnecessarily.
