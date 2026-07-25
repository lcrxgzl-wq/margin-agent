# Pi router review

## Current routing truth table

Rules are first-match wins:

| Condition | Route | Rule |
| --- | --- | --- |
| `MARGIN_ENGINE=simple` | offline | `engine-simple` |
| No runtime credentials | offline | `missing-credentials` |
| `MARGIN_ENGINE=pi` | Pi | `engine-pi` |
| Multi-step regex match | Pi | `multi-step` |
| Greeting or identity question | offline | `greeting-or-identity` |
| `parseOpenIntent()` recognizes an open request | offline | `open-intent` |
| Starts with read/new/write | offline | `file-read-or-write` |
| Contains a list-files phrase | offline | `list-files` |
| Contains rewrite/proofread/revise | offline | `rewrite` |
| Anything else (including normal discussion) | offline | `offline-default` |

Thus, with credentials, Pi currently receives only explicit `pi` and the narrow multi-step regex. In particular, opening documents, rewriting, and ordinary discussion all use the offline planner. `runSessionTurn()` rechecks runtime credentials through `hasRuntimeCredentials()` before routing; a Pi error then falls back to the offline loop unless `MARGIN_ENGINE_STRICT=1`.

## Recommended Pi-first order

1. `engine-simple` → offline (explicit operator override).
2. `missing-credentials` → offline.
3. `engine-pi` → Pi (retain explicit override and clear diagnostics).
4. Greeting / identity → offline fast path.
5. List-files request → offline fast path.
6. `pi-default` → Pi.

Remove the routing role of `multi-step`, `open-intent`, `file-read-or-write`, and `rewrite`: Pi has the same session tool surface (`list/read/write/open` plus paper proposal tools), and should decide how to execute these requests. In particular, “打开…”, “重写…”, and discussion must reach Pi when credentials exist. Keep the offline implementation as the no-credentials fallback, not as the normal keyed path.

## Keep offline even with credentials

1. Explicit `MARGIN_ENGINE=simple`.
2. Greeting-only utterances.
3. Identity-only questions.
4. Pure file-list requests.

Do not keep direct open, read, write, rewrite, or general discussion offline merely because they match a regex; those are substantive turns where Pi can use context and tools. The four rules above are the complete keyed fast-path set.

## Pi-first risks and mitigations

- **Latency:** a remote turn adds model/tool startup time. Keep the four deterministic fast paths and retain streaming progress/deltas.
- **Cost:** simple intent handling consumes tokens. Restrict the Pi system prompt/context to the current document hint and capped selection; avoid routing trivial list/greeting work there.
- **Unreliable tool choice:** Pi may take extra turns for deterministic actions. Preserve the existing sequential tools, 20-turn cap, and 120-second timeout; monitor tool/turn counts.
- **Availability:** Pi errors already degrade to offline unless strict mode is selected. Surface `fallbackFrom`/`fallbackReason` to make fallback visible rather than silently treating it as Pi success.

## Tests that must change

- Replace the parameterized expectation that `打开样章` and `重写这一段，使其更简洁` route offline: with credentials, both should expect `pi_session` via `pi-default`.
- Add a keyed normal-discussion case (for example, `讨论研究设计`) expecting Pi via `pi-default`.
- Retain greeting/identity offline assertions and add/retain a pure list-files offline assertion.
- Retain missing-credentials offline coverage for every request category (including discuss/rewrite) and `engine-simple` precedence coverage.
- Retain explicit `engine-pi`; add precedence tests proving `engine-simple` wins over credentials and that a Pi failure in `runSessionTurn` still returns the documented offline fallback (or throws in strict mode).
