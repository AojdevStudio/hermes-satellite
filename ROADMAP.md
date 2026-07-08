# Hermes Satellite Roadmap

Last updated: 2026-07-06

## Product direction

Hermes Satellite turns any dedicated host running Hermes Agent into a shared, authenticated remote executor for MCP-capable clients. The host can be a Mac mini, Linux box, VM, homelab server, CI runner, or any other machine that can run Hermes and expose the bridge over an authenticated network path. Clients such as Claude Code, Codex, Pi, Cursor, CI, or another MCP-capable dispatcher submit structured work to the bridge, wait for completion, fetch evidence, verify claims, and send corrective follow-ups through the same Hermes session.

The target is not just remote execution. The target is a closed loop:

1. Dispatch a scoped task to Hermes.
2. Execute on the configured Hermes host through the authenticated MCP bridge.
3. Wake or poll the satellite verifier when the task reaches terminal status.
4. Verify with transcript evidence, decomposed claims, cost telemetry, and external oracles.
5. Correct through `hermes_respond` until verified or escalated.

## Current state

### Completed foundation

- Native Python Streamable HTTP bridge lives in `apps/hermes-async-bridge/`.
- Bridge exposes authenticated MCP tools over HTTP instead of `supergateway` + stdio.
- Bridge requires bearer auth and refuses blind `0.0.0.0` HTTP binding by default.
- Task state persists in `$HERMES_HOME/async_bridge.db`.
- Hermes evidence and cost data are read from `$HERMES_HOME/state.db`.
- Client polling contract is documented in `hermes-polling.md`.
- Core bridge tools exist:
  - `hermes_submit`
  - `hermes_status`
  - `hermes_result`
  - `hermes_respond`
  - `hermes_cancel`
  - `hermes_list`
  - `hermes_sessions`
  - `hermes_transcript`
  - `hermes_decompose`
  - `hermes_task_cost`
- Recent dispatcher smoke tests prove the practical task path works through submit/status/result polling.

### Known gaps

- Completion callbacks exist in the bridge, but recent dispatcher tasks used polling because they did not provide a `callback_url`.
- The callback listener/wake path still needs end-to-end proof from a real satellite verifier client.
- Per-caller identity is still mostly caller-string level; token-derived principal mapping is not complete.
- Cost telemetry exists, but live acceptance tests need to prove `hermes_result.cost`, `hermes_transcript`, `hermes_decompose`, and `hermes_task_cost` together on authenticated tasks.
- Satellite verifier enforcement parity with the local Pi verifier is not fully locked down in code.
- The `hst` CLI (`scripts/hst.ts`) now covers task queue, per-task detail, costs, events, transcript export, and service health from the host terminal; callback health and verification state still have no operator view, and there is no UI.

## Roadmap

### Phase 0 — Stabilize the bridge runtime

Goal: make the existing bridge boring, observable, and recoverable.

Status: mostly complete; keep hardening while higher phases proceed.

Deliverables:

- Keep `apps/hermes-async-bridge/hermes_async_bridge.py` as the canonical source of truth.
- Keep launchd pointed at the repo script or a deliberate deployed symlink.
- Preserve authenticated HTTP as the only remote transport path.
- Keep unauthenticated MCP initialize returning 401/403 from a separate tailnet node.
- Keep authenticated MCP initialize returning 200 from a separate tailnet node.
- Keep a small authenticated PONG task as the basic smoke test.
- Document operational quirks, especially that the bridge host may not curl its own Tailscale IP reliably.

Validation:

- `just bridge-check`
- unauthenticated `/mcp` initialize fails
- authenticated `/mcp` initialize succeeds
- authenticated `hermes_submit` PONG task completes
- `hermes_result` returns the expected result text

### Phase 1 — Task observability and cost acceptance

Goal: make every remote task auditable enough that the dispatcher can tell what happened and what it cost.

Deliverables:

- Confirm `mcp_events` records submit/status/result/respond/cancel/callback events with safe payloads.
- Confirm `task_runs` records subprocess metadata, exit status, duration, and stderr/stdout character counts.
- Confirm `task_costs` records the latest and historical cost snapshots per task and respond loop.
- Ensure MoA or local-provider unreconciled cost is represented as unknown/unreconciled, not free.
- Add or update tests for `hermes_task_cost(task_id, history=true)`.
- Add an acceptance smoke covering:
  - submit task
  - wait for terminal status
  - fetch result
  - fetch transcript
  - decompose transcript
  - fetch cost

Validation:

- `just test`
- `just bridge-check`
- live authenticated PONG task proves `hermes_result.cost`
- live authenticated PONG task proves `hermes_transcript`
- live authenticated PONG task proves `hermes_decompose`
- live authenticated PONG task proves `hermes_task_cost`

### Phase 2 — Callback/wake path for dispatcher clients

Goal: stop relying only on long polling; wake the dispatcher or satellite verifier on terminal status.

Deliverables:

- Define the callback contract as a stable event schema.
- Stand up a minimal callback listener for at least one active dispatcher client.
- Have dispatcher clients pass `callback_url` to `hermes_submit` and `hermes_respond`.
- Prove bridge `_notify_terminal` POSTs terminal payloads on both success and failure.
- Record `callback_sent` and `callback_failed` in `mcp_events`.
- Decide retry semantics for failed callbacks:
  - no retry, polling is the fallback; or
  - bounded retry with backoff and audit rows.
- Keep polling as the safety net even after callbacks work.

Callback payload should include at minimum:

- `type`
- `name`
- `taskId`
- `hermesSessionId`
- `status`
- `timestamp`
- `resultSummary`
- `transcriptPath`
- `evidenceTierAvailable`
- `cost`

Validation:

- submit a task with `callback_url`
- observe callback listener receive terminal event
- verify `mcp_events.callback_sent`
- verify dispatcher can wake satellite verifier from the callback
- repeat with a failing or timed-out task

### Phase 3 — Satellite verifier loop

Goal: make “done” mean verified, not merely completed.

Deliverables:

- Finalize `satellite-verifier.md` persona contract.
- Use `hermes_transcript` as T2 evidence source for Hermes work.
- Use `hermes_decompose` to produce atomic claims from transcript/result evidence.
- Oracle each claim using appropriate evidence:
  - tool outputs
  - file paths
  - command results
  - external service state
  - HTTP endpoints
  - git status/diff when relevant
- Emit a structured `## Report` with confidence, failures, cost, and next action.
- Use `hermes_respond` for corrective follow-ups in the same Hermes session.
- Enforce `max_loops` so bad tasks escalate instead of spinning.
- Make the verifier explicitly distinguish:
  - verified
  - unverifiable
  - failed
  - needs human decision

Validation:

- run a task that succeeds on first attempt
- run a task that requires one corrective `hermes_respond`
- run a negative task that must fail verification
- confirm the verifier never reports success from final prose alone

### Phase 4 — Enforcement parity and identity

Goal: match the safety guarantees of the local Pi verifier path or explicitly document accepted downgrades.

Deliverables:

- Replace caller-string trust with token-derived principal identity.
- Add per-principal audit fields to task rows and event rows.
- Define verifier tool allowlists or post-hoc mutation checks.
- Enforce confidence caps based on evidence tier.
- Extend report parsing for cost and evidence tier fields.
- Persist loop count per task/follow-up chain.
- Make every row in the enforcement parity table in `specs/hermes-satellite-verify.md` either `re-enforced` or explicitly `advisory (accepted)`.

Validation:

- spoofed caller string does not grant identity
- verifier cannot silently mutate workspace without detection
- confidence cannot exceed the cap for weak evidence
- report parser rejects malformed or incomplete reports

### Phase 5 — Operator experience

Goal: make the system easy to inspect and operate while AFK.

Status: largely delivered by the `hst` CLI (`scripts/hst.ts`); callback health, verifier results, and the Discord/mobile summary remain.

Deliverables:

- Provide a simple task queue/status view. Done: `hst tasks` (status, caller, age, duration, LLM-gist of each prompt) and `hst health`.
- Show recent tasks by caller, status, duration, cost, and verifier result. Done except verifier result: `hst tasks` and `hst costs` (per-task cost with caller; subscription-billed `$0` shown as such, any other `$0` shown as unknown, never free).
- Show callback health and last callback errors.
- Show transcript/evidence links or export paths. Done: `hst transcript <id>` exports the session JSONL and prints the path.
- Add a quick “what is running now?” command or view. Done: `hst tasks -s running` and `hst watch`.
- Add a compact Discord/mobile-friendly summary for completed verified tasks and failures.

Validation:

- operator can answer “what is running?” in one command/view
- operator can answer “what failed and why?” without opening SQLite manually
- Discord/mobile summary is short, accurate, and includes next action

### Phase 6 — Policy and guardrails

Goal: add safety rails without blocking legitimate high-capability Hermes runs.

Deliverables:

- Optional per-principal budget caps.
- Optional preflight warning for prompts requesting MoA, delegation, or expensive external models.
- Optional `allow_expensive=true` style policy if cost surprises continue.
- Task retention policy for old rows, transcripts, and large outputs.
- Backpressure rules for concurrent tasks.
- Clear timeout and cancellation policy.

Validation:

- budget cap blocks or escalates before expensive work starts
- allowed expensive work remains possible when explicit
- retention cleanup does not break recent audit trails
- concurrent task limit prevents resource exhaustion

## Near-term priority list

1. Prove a live authenticated task that returns result, transcript, decomposition, and cost together.
2. Stand up and test a real callback listener for an active dispatcher client.
3. Have dispatcher clients pass `callback_url` on dispatch.
4. Done: the `hst` CLI (`scripts/hst.ts`) is the current-tasks operator command — `hst tasks`, `hst task <id>`, `hst costs`, `hst watch`, `hst health`.
5. Tighten token-derived caller identity.
6. Add one verifier-loop negative test that must not pass from final prose alone.
7. Update README and docs as each roadmap phase moves from target to verified.

## Acceptance definition for the product

Hermes Satellite is ready when an MCP client can dispatch a real repo task to a configured Hermes host, receive a wake event or poll terminal status, fetch transcript evidence, decompose claims, verify those claims with concrete oracles, request corrections through the same Hermes session, report cost, and only tell the user the work is done after verification passes.

## References

- `README.md`
- `hermes-mcp.md`
- `hermes-polling.md`
- `apps/hermes-async-bridge/README.md`
- `apps/hermes-async-bridge/hermes_async_bridge.py`
- `specs/hermes-satellite-verify.md`
- `specs/hermes-mcp-main-machine-install.md`
