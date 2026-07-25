# Prompt architecture review: harness as the sole persona

## Finding

The harness already owns the substantive personality and safety/editing contract, but three execution paths append competing agent identities and policy. This makes the effective system prompt path-dependent:

| Path | Current effective system prompt | Problem |
|---|---|---|
| Interactive Pi | `harness.systemPrompt` + `session-runner.systemPrompt()` | Repeats identity, editing restrictions, anti-fabrication rules, and style. |
| Pi scan | `harness.systemPrompt` + inline scan prompt | Repeats “Paper Agent” and hardcodes a tool choreography. |
| Offline discussion with a provider | `agentSystemPrompt()` + `harness.systemPrompt` | A second conversational persona precedes the harness. |

`packs/*` is not a personality source: it defines optional tools, their descriptions, and deterministic heuristic comments. Keep it that way. `Harness.toolProfile` is the correct switch for enabling those tools.

## Concrete edit plan

1. **Keep and slightly consolidate `packages/harness/src/index.ts` as the authority.**
   - Retain the one identity line per harness (the only permitted `Paper Agent` wording).
   - Move any universal conversational behavior currently unique to `agentSystemPrompt()` into each relevant harness: concise natural Chinese; no command-menu tone; do not claim a file action without a tool result; answer greetings normally.
   - Keep the existing proposal, fabrication, rationale/risk, and citation rules here. Do not duplicate them in runners.
   - If “only through tools” is intended only for document mutation rather than ordinary discussion, clarify it here as “所有工作区/文稿操作必须通过工具”; that matches the discussion path and avoids accidentally requiring a tool call for a greeting.

2. **Reduce `packages/agent/src/session-runner.ts:systemPrompt()` to a runtime appendix.**
   - Return `harness.systemPrompt` unchanged, followed only by runtime facts: available tool names, tool availability from `toolProfile`, and the current capability boundary (no shell, workspace-scoped paths, proposal tools do not apply edits).
   - Delete: `你是 Margin 本地论文 Agent（全工具环）`, `对用户用自然中文回复`, the duplicate “必须通过工具…”, duplicate anti-fabrication prohibition, and `风格：${harness.styleHint}`.
   - Do not copy the harness rules into this appendix. `styleHint` remains metadata/UI material unless it is deliberately incorporated into `Harness.systemPrompt`.

3. **Replace the scan prompt in `packages/agent/src/pi-runner.ts` with a thin scan context appendix.**
   - Delete the inline `你是 Paper Agent`, numbered “必须用工具完成审阅扫描” workflow, repeated prohibitions, and repeated style hint.
   - Use `harness.systemPrompt` plus facts only: this is a non-persisting scan; selected block IDs; available tools; `propose_block_*` records proposals; `finish_turn` marks completion.
   - Delete `scanHint` and its “先做 outline/...，再提案，最后 finish_turn” wording. Replace user prompts with the request and target IDs only, e.g. “审阅这些块；按需要调用工具并为值得修改的块提出提案：…”。The model should decide whether reading outline, a block, search, or pack tools is useful.
   - Keep the host-side turn cap, timeout, and result merging: they are execution controls, not prompt personality.

4. **Eliminate the second system persona in `packages/llm/src/agent-reply.ts` and `packages/llm/src/index.ts`.**
   - Delete `agentSystemPrompt()` and its export from `packages/llm/src/index.ts`.
   - In `streamDiscuss`, replace ``${agentSystemPrompt()}\n\n学科约束：\n${harness.systemPrompt}`` with `harness.systemPrompt` alone. The user prompt constructed by `buildAgentUserPrompt()` remains runtime context, not a persona.
   - `mockAgentReply()` is fallback product copy rather than an LLM system prompt. For strict “one personality” consistency, align its fixed identity/greeting language with the same neutral terminology chosen in the harness; it cannot inherit a model prompt at runtime.

5. **Preserve packs as capability-only extensions.**
   - No identity, tool order, or mandatory workflow belongs in `packs/registry.ts`, `packs/academic.ts`, or `packs/types.ts`.
   - Keep tool descriptions factual (including `cite_check` being morphology-only). The harness remains the policy source that tells the model how to interpret those results.

## Acceptance checks

- Searching `packages/agent/src` and `packages/llm/src` finds no `你是 Paper Agent` or `你是 Margin` system-prompt text; identity is defined only under `packages/harness/src`.
- Each model invocation receives `harness.systemPrompt` exactly once.
- Scan instructions contain target scope and lifecycle facts, but no required outline → cite/style → propose sequence.
- Interactive Pi, scan Pi, and provider-backed discussion retain their tool/context appendices without restating policy.
