# hermes-dispatch reference

Disclosed reference for [`SKILL.md`](SKILL.md). Load when you reach the oracle, cost, or failure-handling steps. Everything here is normative from `specs/hermes-satellite-verify.md`.

## Evidence tiers (normative)

| Tier | Source | Verifier can prove | Confidence cap |
|------|--------|--------------------|----------------|
| T0 | `hermes_result` final text only | claims explicitly quoted in the result | PARTIAL at best |
| T1 | bridge task row + `session_id` + `hermes_sessions` summary | session existed; metadata; truncated history | PARTIAL, or VERIFIED for trivial tasks |
| T2 | `hermes sessions export` jsonl (via `hermes_transcript`) | full tool call/result sequence | VERIFIED/PERFECT when oracles match |
| T3 | bridge streams `state.db` tail over MCP (future) | live plus post-hoc | PERFECT when complete |

Rules:

- Every `## Report` MUST emit a machine-parseable `EVIDENCE_TIER: T0|T1|T2|T3` line. A report missing it is rejected (the parser must not default it).
- Confidence is clamped in code after parsing: `confidence = min(reported, capFor(tier))`. Caps: T0 → PARTIAL, T1 → VERIFIED, T2/T3 → PERFECT-eligible.
- T2 is required for production verify loops on code or filesystem tasks. T1 is only acceptable for smoke tests.
- "Code/filesystem task" is detected deterministically: if `hermes_decompose` yields any `tool_execution` atom whose `toolName` is in the write/fs/exec set, the task requires T2, and VERIFIED/PERFECT is forbidden on T0/T1 for that task.

## Claim taxonomy and decomposition (v1)

`AtomicClaim.kind` is one of `tool_execution | assistant_assertion | user_requirement | structured_assistant_claim`. Decomposition rules:

1. **tool_execution** (deterministic): every `tool_call` plus its matching `tool_result` becomes one claim with `embeddedEvidence`. That evidence MUST come only from the T2 export `tool_result` row, never from the `hermes_result` final text. This closes the evidence-laundering path.
2. **assistant_assertion** (advisory): assertion sentences from the final assistant message, cross-linked to the nearest preceding tool rows. May NOT raise confidence and MUST NOT count toward PERFECT completeness unless each is linked to a `tool_execution` oracle.
3. **user_requirement** (deterministic): parsed from the dispatch `## Acceptance` bullets.
4. **structured_assistant_claim** (candidate only): a schema-shaped `verify_claims` block in output is not canonical. Cap confidence at 0.55, and never let it satisfy `user_requirement` completeness or PERFECT unless the transcript proves a forced mechanism (`structuredOutputMechanism`: `response_format` / `strict_tool` / `verify_claims_tool` / `plugin_complete_structured`). Absent that field, classify as `assistant_assertion`.

Oracle PASS/FAIL rules per claim kind are inline in [`SKILL.md`](SKILL.md) Step 4 (single source of truth). The report must list every claim id with a verdict and refuse PERFECT if any row is UNCHECKED.

`AtomicClaim` shape:

```typescript
interface AtomicClaim {
  id: string;
  kind: "tool_execution" | "assistant_assertion" | "user_requirement" | "structured_assistant_claim";
  source: { messageIndex: number; toolName?: string };
  text: string;
  /** Present for tool_execution: the tool result row from the T2 export */
  embeddedEvidence?: string;
  suggestedOracle?: "tool_result" | "file_path_in_result" | "git_in_result" | "manual";
  /** Set only when kind === "structured_assistant_claim" */
  structuredOutputMechanism?: "response_format" | "strict_tool" | "verify_claims_tool" | "plugin_complete_structured";
}
```

## Verifier independence (normative, spec Phase 1)

For in-session Claude/Codex/Pi verifiers, the persona `tools:` field is enforced by nothing (unlike the Pi `--tools` path). Verbatim:

> Run the in-session verifier on a tool-allowlisted MCP session that omits write/edit, OR add a post-hoc check that the verify transcript contains no mutating tool calls. Do not call this path read-only without one of those.

The satellite verifier's correction channel is `hermes_respond`, never `verifier_prompt` (the dead unix-socket tool from the local Pi path). Never launch the satellite verifier via the local tmux launcher / `spawnVerifierChild`.

## Confidence ladder to STATUS mapping (normative)

`parseReport` requires `CONFIDENCE:`, `STATUS:` (`verified | failed | unsure`), and `EVIDENCE_TIER:` lines, or it discards the entire report. The full CONFIDENCE to STATUS to action table is inline in [`SKILL.md`](SKILL.md) Step 5 (single source of truth); it is not restated here.

## Cost telemetry

`TaskCostSnapshot` shape:

```typescript
interface TaskCostSnapshot {
  taskId: string;
  hermesSessionId: string;
  /** Cumulative across resume/respond cycles for this dispatch chain */
  loopIndex: number;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** null by default when no pricing table is configured; a wrong number is worse than null */
  estimatedUsd?: number | null;
  /** REQUIRED when expensiveToolsUsed includes delegate_task/MoA */
  perModelBreakdown?: Array<{ model: string; promptTokens: number; completionTokens: number; estimatedUsd?: number | null }>;
  /** delegation = "delegate_task"; MoA is NOT a tool name (virtual provider) */
  expensiveToolsUsed?: string[];
  costSource?: "provider_models_api" | "none" | "estimated" | null;
  billingProvider?: string; // e.g. "openrouter" | "moa"
  billingMode?: string;     // e.g. "subscription_included"
  pricingVersion?: string;
  /** true when cost is a known blind spot (MoA) */
  costUnreconciled?: boolean;
  source: "state.db" | "hermes_usage_api" | "estimated";
  capturedAt: string; // ISO8601
}
```

Obtain it from `hermes_result.cost`, from `hermes_task_cost(task_id)` (latest or full history including respond loops), or from the callback payload.

Report `### Cost` format:

```markdown
### Cost
- Task: <task_id> · loop <n>
- Model: <provider>/<model>
- Tokens: <prompt> + <completion> = <total>
- Estimated: $<estimated_usd> (<source>)
- Expensive tools: <list or none>
```

**MoA blind spot (normative):** MoA is a virtual provider (`billingProvider=moa`, `billingMode=subscription_included`). The parent session row reports `estimatedUsd=0.0` / `costSource=none` even when the aggregator spent real dollars upstream. This is how a $47 run stayed invisible. A snapshot with `costSource="none"` + `billingProvider="moa"` MUST be surfaced as **unreconciled, never authoritative $0**; exact spend is recoverable only from the OpenRouter dashboard. Do NOT sum per-loop snapshots (they double-count, since `hermes_respond` resumes the same session with cumulative counters); use per-loop deltas or the last snapshot's cumulative total.

## Bridge failure envelopes (normative, observed)

The poll+result parser must handle these, not only the happy path:

- **Hard timeout** (after 600s): `status="failed"`, `result=""`, `error="Task timed out after 600s"`, `session_id=null`.
- **Upstream auth fail** (fast, ~3-5s): `status="failed"`, `error="Error: HTTP 401: User not found."` (e.g. drained credits), often with `result="Warning: Unknown toolsets: moa"`.
- **Success**: `status="completed"` with a real top-level `session_id`.

Consequences: a `failed` task returns top-level `session_id=null`, so you CANNOT `hermes_respond` to a failure (a fast-fail embeds a session id inside the `error` string; a timeout embeds none). Treat `failed` as terminal-without-resume, not retry-blindly. `result` and `error` are independent fields, so parse both. Only `completed` yields a resumable `session_id`.

## Other gotchas

- A host often cannot reliably curl its own Tailscale IP. Run the PONG/verify smoke from another tailnet node, not the bridge host itself.
- `/healthz` returns `ok` unauthenticated; it does NOT prove tool auth. Only a no-token `initialize` returning 401 proves auth enforcement.
- `hermes_result` text is a claim, not proof. Stopping at T0 grades PARTIAL or FAILED for any non-trivial task.
- Hermes answer-shape policy (homelab HERMES.md): hold results to conclusion / evidence / risk / commands run / verification / gaps. If a result claims success with no verification output, or says "committed to main" (Hermes lands via PR on issue-scoped branches), push back via `hermes_respond`.
- Keep the bearer token in your secret manager or a local `.env` (mode 600), referenced via `$HERMES_MCP_TOKEN`. Never print or commit it.
