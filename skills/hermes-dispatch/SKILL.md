---
name: hermes-dispatch
description: Dispatch a task to Hermes over the async MCP bridge, then verify Hermes's result as an independent satellite verifier. Use when dispatching work to Hermes ("send this to Hermes"), running the Hermes work queue, or acting as the satellite verifier of a Hermes result. Reach for it whenever you call hermes_submit or hermes_respond on the hermes-async bridge.
---

You are the **dispatcher** and the **satellite verifier**, never the worker. Hermes on the bridge host executes; you write a checkable prompt, poll, then **oracle** every claim Hermes makes against tool evidence before you trust a word of it. Two leading ideas govern the whole skill:

- **Scoped dispatch**: you do NOT do the task locally in parallel. You craft the prompt so Hermes can finish it, then you verify. No "I'll just edit this here while Hermes also runs."
- **Evidence tier**: the final result text is a *claim*, not proof. Confidence is capped by the strength of evidence you can actually inspect (T0 text only is weak; T2 full transcript is strong). A verify pass that stops at the result paragraph grades PARTIAL at best.

The loop is: **submit → poll → pull evidence → oracle → report → reloop or finish.** Run it in order.

## Step 0: Preflight the bridge

- Endpoint: set `$HERMES_MCP_URL` to your bridge's MCP URL, e.g. `http://<bridge-host>:8081/mcp`. Bind the bridge to a private tailnet or VPN address, never a public interface; any stale LAN address is dead by design.
- Auth: `Authorization: Bearer $HERMES_MCP_TOKEN`, required. Keep the token value in your secret manager or a local `.env` (never commit it).
- This client drops to relay/offline sometimes, so preflight in order: `tailscale status` up, then `/healthz` returns `ok`, then the MCP `initialize` returns the tool list. (`/healthz` is unauthenticated and does NOT prove tool auth; the initialize is the real check.)
- Tool names carry a per-harness prefix (Claude Code `mcp__hermes-async__hermes_submit`, Hermes Agent `mcp_hermes_async_*`, others connect by URL). Base names are constant. Confirm exact arg names against the live `tools/list` on connect.

**Done when:** `initialize` succeeded and the `hermes_*` tools are visible.

## Step 1: Submit with a `## Acceptance` block

Keep the dispatched task small and scoped; large multi-part prompts hit the 600s hard timeout. The prompt MUST contain a `## Acceptance` section:

- Bulleted, each bullet exactly ONE testable requirement. These become deterministic `user_requirement` claims at verify time; without them the verifier is guessing.
- Require Hermes to return proof artifacts inline (command output, file excerpts, paths), not just a summary.
- If you intend an expensive mode (MoA, delegation), say so in the acceptance block so cost cross-checks work.

Call `hermes_submit(prompt, caller)`. Save `task_id` + `submit_time`. One `task_id` per poll chain unless the user explicitly asked for parallel tasks.

**Done when:** a `task_id` is returned.

## Step 2: Poll (the contract, enforced in code, not by vibe)

| Constant | Value |
|----------|------:|
| initial sleep | 30s |
| interval | 120s |
| hard cap | 600s from submit |

Sleep 30, then `hermes_status(task_id)`. On `completed` or `failed`, go to Step 3. On `running`/`pending`: if `now - submit_time >= 600` stop as timeout, else sleep 120 and re-check. Never poll faster than 30s; never past 600s. The classic failure is `failed` without ever seeing `completed` because of too few polls before the cap. If the session cannot block in a loop, use ScheduleWakeup: +30s, then +120s per re-check, same terminal rules.

**Done when:** a terminal status or the 600s timeout.

## Step 3: Pull evidence (never trust the paragraph)

- On ANY terminal status, call `hermes_result(task_id)` EXACTLY once (both `completed` and `failed`). It carries a `cost` block.
- Failure handling is mandatory, not the happy path only. A `failed` task is **terminal without resume**. A timeout returns `session_id=null`, so you CANNOT `hermes_respond` to it. `result` and `error` are independent fields; a failed task can carry both, so parse both. Only `completed` yields a resumable `session_id`.
- For anything past a trivial smoke test: `hermes_transcript(session_id)`, then `hermes_decompose(transcript_or_session_id, original_prompt)` to get the `AtomicClaim[]`. Pass your dispatch prompt (with its `## Acceptance` block) into decompose, or the `user_requirement` claims never get generated. Do NOT re-parse the transcript by hand; always go through `hermes_decompose`.
- A `failed` task has `session_id=null`, so T2 is unreachable: grade it at T0 (result and error text only) and escalate. Do not fabricate a higher tier.

**Done when:** you hold the result and (for non-trivial tasks) the decomposed claims.

## Step 4: Oracle every claim

Run this pass READ-ONLY (**verifier independence**): either spawn a read-only-tooled subagent for the verify, or post-hoc assert the verify pass issued zero mutating tool calls. Do not treat the pass as read-only unless one of those two mechanisms is in place. The correction channel is always `hermes_respond`; `verifier_prompt` is a dead local-Pi trap, never use it.

Oracle rules per claim kind:

- **tool_execution**: compare the assertion to `embeddedEvidence`, which must come only from the T2 export tool_result row, never from the `hermes_result` text. Deterministic PASS/FAIL where possible.
- **assistant_assertion**: must cite a tool row or external oracle. Never PASS on prose alone; it cannot raise confidence or count toward PERFECT.
- **user_requirement** (your `## Acceptance` bullets): FAIL if no supporting tool evidence exists.
- **structured_assistant_claim**: cap confidence at 0.55; never satisfies PERFECT unless the transcript proves a forced output mechanism.

Confidence is clamped by evidence tier in code: **T0 caps at PARTIAL, T1 caps at VERIFIED, T2/T3 are PERFECT-eligible.** Any code or filesystem task (any write/fs/exec `tool_execution` atom) REQUIRES T2; VERIFIED or PERFECT is forbidden on T0/T1 for it.

Full claim taxonomy, `AtomicClaim` shape, evidence-tier table, and the independence rule verbatim live in [`reference.md`](reference.md).

**Done when:** every claim id has a verdict. If any row is UNCHECKED, refuse PERFECT.

## Step 5: Report (both CONFIDENCE and STATUS, or it is discarded)

Emit a `## Report`. The parser requires these machine-parseable lines and rejects the whole report if `CONFIDENCE:`, `STATUS:`, or `EVIDENCE_TIER:` is missing:

```
CONFIDENCE: PERFECT | VERIFIED | PARTIAL | FEEDBACK | FAILED
STATUS: verified | failed | unsure
EVIDENCE_TIER: T0 | T1 | T2 | T3
```

Then a per-claim PASS/FAIL/UNSURE table (every claim id), and a `### Cost` subsection from `hermes_result.cost` or `hermes_task_cost` (write `unavailable` if the bridge returned no cost block). Surface MoA cost as **unreconciled, never authoritative $0**, and do not sum per-loop snapshots (see [`reference.md`](reference.md)).

| CONFIDENCE | STATUS | Meaning | Action |
|------------|--------|---------|--------|
| PERFECT | verified | every claim verified | report done |
| VERIFIED | verified | all checked passed, minor gaps | report done |
| PARTIAL | verified | no failures, significant unverifiable gaps | report + note gaps |
| FEEDBACK | failed | failures found, correction sent | reloop |
| FAILED | unsure | cannot verify | escalate to human |

**Done when:** the report has all three required lines, a full claim table, and cost.

## Step 6: Reloop or finish

- **FEEDBACK**: `hermes_respond(session_id, corrective_prompt)` (resumes the same Hermes session), then back to Step 2. Increment the loop counter.
- `max_loops` default 3. At the cap, escalate to the user; no silent retry.
- **FAILED** (cannot verify): escalate to the human.
- **VERIFIED** or better: report done to the user.
- Never `hermes_respond` to a `failed` task; there is no resumable session.

## Bridge tools (base names; add your harness prefix)

| Tool | Args | Purpose |
|------|------|---------|
| `hermes_submit` | `(prompt, caller[, callback_url])` | start task |
| `hermes_status` | `(task_id)` | poll |
| `hermes_result` | `(task_id)` | outcome + `cost`; call once on terminal |
| `hermes_respond` | `(session_id, message)` | corrective, resumes session |
| `hermes_cancel` | `(task_id)` | cancel |
| `hermes_list` | `()` | list tasks |
| `hermes_sessions` | `()` | session summaries (T1) |
| `hermes_transcript` | `(session_id)` | T2 jsonl export |
| `hermes_decompose` | `(session_id or transcript, original_prompt)` | `AtomicClaim[]` |
| `hermes_task_cost` | `(task_id)` | `TaskCostSnapshot` |

Normative shapes, decomposition rules, evidence tiers, cost telemetry, and bridge failure envelopes: [`reference.md`](reference.md).
