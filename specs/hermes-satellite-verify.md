# Hermes Satellite Verify — Implementation Plan

> **Audience:** Hermes (Mac mini operator), Pi coding agent (wiring), Claude Code + Codex (independent verification), and the human operator.
>
> **Repo:** `the-verifier-agent`
>
> **Related docs:** [`hermes-mcp.md`](../hermes-mcp.md), [`hermes-polling.md`](../hermes-polling.md)

---

## Executive summary

We are extending the Pi Verifier Agent pattern from **same-machine builder↔verifier** to **remote Hermes satellite execution**:

1. **Dispatch** — Claude Code, Codex, or Pi crafts a structured prompt and sends it to Hermes on the Mac mini via the MCP async bridge. The dispatch agent does **not** do the work locally.
2. **Execute** — Hermes runs on the Mac mini (`hermes chat` subprocess spawned by the bridge).
3. **Verify** — **Satellite verifier** (dispatch client, persona `satellite-verifier.md`) runs **`hermes_decompose`** on T2 transcript → oracles each atom → grades confidence.
4. **Correct** — Failures go back to Hermes via `hermes_respond`; loop until verified or `max_loops` exhausted, then escalate to the human.

The Mac mini runs the **MCP server**. Any MCP-capable client on any machine connects over **Streamable HTTP + auth**. Unix domain sockets and stdio MCP are the wrong transport model here.

This plan defines **what to build**, **who builds it**, and **how we know it works**.

### Naming (read this first)

| Term | Meaning |
|------|---------|
| **Hermes** | Mac mini **executor** — runs the task. **Not** the verifier. |
| **Satellite verifier** | MCP client (Codex / Claude Code / Pi / CI / other dispatcher) after dispatch — persona **`satellite-verifier.md`**. Verifies Hermes output; calls `hermes_respond`. |
| **VERIFIER** | Local Pi tmux child (`just v`) — persona **`verifier.md`**. Unrelated to the satellite loop. |

---

## Problem

Engineers spend too much time manually confirming that remote agent work actually happened. The existing verifier in this repo solves that for **local Pi builders** (session JSONL slice + unix socket IPC). Hermes work today is:

- Dispatched via MCP (`hermes_submit`)
- Polled one-way (`hermes_status` / `hermes_result`)
- Trusted by reading Hermes’s final paragraph

That is the same review constraint we are trying to eliminate — just on a different machine.

---

## Goals

| # | Goal |
|---|------|
| G1 | **Satellite execution** — Hermes on Mac mini does the work; foreground harness stays conversational. |
| G2 | **Scoped dispatch** — Dispatch agent crafts complete prompts; does not shadow-execute locally. |
| G3 | **Automated verification** — Evidence-based verify loop with confidence grading (reuse existing ladder). |
| G4 | **Bidirectional loop** — Poll while running; wake **satellite verifier** on completion; `hermes_respond` for corrections. |
| G5 | **Client-agnostic bridge** — One HTTP MCP server; Claude Code, Codex, Pi, Cursor all use URL + token. |
| G6 | **Observability** — Per-task audit trail (prompt, status, result, transcript, **cost/model telemetry**). |
| G7 | **Evidence tiers**: Verifier must reach Hermes’s canonical transcript (`state.db` or export), not only `hermes_result` final text. |
| G8 | **Cost telemetry**: Every MCP task row links to token/model/spend data from `state.db`; remote clients and verify Reports see cumulative cost per loop. |

## Non-goals (this plan)

- Blocking MoA or expensive Hermes modes by default (prompt clarity + observability instead).
- Replacing Hermes’s internal gateway, profiles, or SOUL.md architecture.
- Making every client run the full Pi verifier tmux child (Claude/Codex can verify in-session; Pi gets the full extension stack).

---

## Scoped dispatch (definition)

**Scoped dispatch = role separation, not Hermes tool lockdown.**

The dispatch agent must:

1. Write a **structured prompt** with acceptance criteria, paths, constraints, and explicit mention of expensive modes (MoA, delegation) when intended.
2. **Not** edit files, run builds, or “help” locally while Hermes is executing the same task.
3. On Hermes terminal status, the **dispatch client** (Codex, Claude Code, Pi, CI, or another MCP-capable dispatcher — not Hermes) switches to persona **`satellite-verifier`** before telling the user “done.”

Hermes retains full capability. Cost surprises from vague prompts are a **dispatch discipline** problem first; observability is the safety net second.

---

## Architecture

### End-state topology

```text
┌─────────────────────────────────────────────────────────────────┐
│  DISPATCH + VERIFY CLIENTS (any machine)                        │
│  Claude Code · Codex · Pi · Cursor · CI                       │
│                                                                 │
│  Phase A: craft prompt → hermes_submit                          │
│  Phase B: poll (hermes-polling.md) OR receive callback          │
│  Phase C: satellite verifier (satellite-verifier.md)            │
│  Phase D: hermes_respond(corrective) → repeat until verified    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │  MCP Streamable HTTP + Authorization: Bearer
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  MAC MINI — MCP SERVER (hermes_async_bridge.py)                 │
│  Tailscale 100.x.x.x:8081  or  LAN 10.x.x.x:8081         │
│                                                                 │
│  SQLite: tasks, events, (future: costs, callbacks)              │
│  spawn: hermes chat -q … --resume <session_id>                  │
│  on terminal: optional callback → client webhook                │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  HERMES AGENT (executor)                                        │
│  Full tools · skills · MoA when prompted · persistent sessions    │
└─────────────────────────────────────────────────────────────────┘
```

### Local verifier vs satellite verifier

| | Local Pi verifier (existing) | Satellite verifier (new) |
|---|-------------------------------|-----------------------------------|
| **Executor** | Pi builder, same machine | Hermes subprocess, Mac mini |
| **Trigger** | `agent_end` → IPC `stop` event | `hermes_status` terminal OR bridge callback |
| **Canonical record** | `~/.pi/agent/sessions/.../<id>.jsonl` (file **is** the session) | `~/.hermes/state.db` (DB **is** the session; JSONL is export/interop) |
| **Verifier reads** | JSONL slice via `read` + line offset | **Not** a jsonl slice — see [Evidence model](#evidence-model-critical) |
| **Correction** | `verifier_prompt` → `sendUserMessage` | `hermes_respond` → resume Hermes session |
| **Transport** | Unix domain socket (`/tmp/pi-verifier/`) | MCP HTTP + optional callback webhook |

**Reuse from this repo:** confidence ladder, `## Report` contract, decomposition discipline, `max_loops`, read-only verifier tool surface, IPC envelope *semantics* (not the unix socket itself).

**Do not port blindly:** local verifier’s `SESSION_FILE_START_LINE` / `SESSION_FILE_END_LINE` pattern assumes Pi’s append-only jsonl. Hermes requires a different evidence adapter.

---

## Enforcement parity (normative)

**Root rule:** every guarantee the local verifier enforces in *code* must have a named satellite *code* enforcement point, or be explicitly downgraded to advisory in this spec. The local path earns its guarantees from Pi `--tools` filtering, socket-typed IPC, and `normalizeToolsList`. A persona sentence is not a replacement for any of them.

The satellite path, as first drafted, relocated most local guarantees to persona prose. This table is the acceptance surface: every row must read `re-enforced` or `advisory (accepted)` before the phase that touches it ships. Any `dropped` row is a blocker.

| Local code-enforced invariant | Local mechanism | Satellite disposition (target) |
|---|---|---|
| Evidence scope (read only the turn) | `SESSION_FILE_START/END_LINE` slice | re-enforced: `HERMES_SESSION_ID` + T2 export |
| Read-only verifier | Pi `--tools` excludes write/edit | re-enforced: satellite verifier runs on a tool-allowlisted MCP session with no write/edit, OR a post-hoc transcript mutation check |
| Correction channel | `verifier_prompt` (socket) | re-enforced: `hermes_respond`; satellite persona never launched via `spawnVerifierChild` (see Personas) |
| Confidence integrity (tier cap) | (none today) | re-enforced: deterministic clamp `confidence = min(confidence, capFor(EVIDENCE_TIER))` in trigger code |
| Report parse | `parseReport` fixed header set | re-enforced: parser extended for `### Cost` + `EVIDENCE_TIER` |
| Loop-count cap | builder-side counter, socket IPC | re-enforced: server-persisted per `task_id` |
| Transport auth | same-UID unix socket 0700 | re-enforced: bearer auth before any remote submit |
| Caller identity | implicit same-UID process | re-enforced: identity derived from the bearer token, not the `caller` string |

**Gate (all phases):** no row may ship `dropped`. A row may ship `advisory` only with an explicit one-line justification added to this section.

---

## Evidence model (critical)

Hermes is closer to **SQLite + live UI streams** than to Pi/Claude Code’s **append-only session JSONL**. The important split is **where you are standing**: inside Hermes vs. watching from a remote MCP client.

### Three models side by side

| | **Pi** | **Claude Code** | **Hermes** |
|---|---|---|---|
| **Canonical record** | `~/.pi/agent/sessions/.../<timestamp>_<id>.jsonl` | `~/.claude/projects/.../<session>.jsonl` | `~/.hermes/state.db` (SQLite) |
| **Line format** | Tree of typed entries (`message`, `compaction`, `model_change`, …) | One JSON object per line (`user` / `assistant` / `tool_use` / `tool_result`) | Relational rows: `sessions` + `messages` (role, content, tool_calls, tool_name) |
| **Live evidence** | TUI streams events; subagents write `events.jsonl` | In-session tool UI + jsonl growing beside you | CLI/TUI tool progress, TUI SSE, API runs SSE, kanban `task_events` |
| **Export for forensics** | `/export`, HTML export | Timeline tools on jsonl | `hermes sessions export backup.jsonl` |

Pi and Claude Code treat **the jsonl file as the session**. Hermes treats **`state.db` as the session**; JSONL is mostly export/interop.

### How Hermes records evidence (inside Hermes)

**While running — UI/event streams**

- CLI/TUI: tool breadcrumbs (`display.tool_progress`), reasoning (`show_reasoning`), token streaming
- TUI gateway: SSE (`_emit(event, session_id, payload)`) — tool start/progress, browser, voice
- API server: `GET /v1/runs/{run_id}/events` (SSE)
- Kanban: append-only `task_events` in `kanban.db`; `hermes kanban tail <id>` or dashboard WebSocket
- Messaging: progressive edits when streaming enabled

**After the turn — durable transcript**

Everything lands in **`~/.hermes/state.db`**:

- Session metadata (id, source, title, model, tokens, timestamps)
- Full message history: user/assistant/tool rows, tool calls and tool results
- FTS5 index for `session_search`

CLI resume reads from SQLite, not from a jsonl file.

**Optional file artifacts**

| Artifact | When | Notes |
|----------|------|-------|
| `hermes sessions export …jsonl` | Manual export | One JSON object per session (metadata + messages), not Claude one-line-per-event |
| `~/.hermes/sessions/session_{id}.json` | `sessions.write_json_snapshots: true` | **Off by default** |
| `~/.hermes/sessions/{id}.jsonl` | Some gateway paths | Adapter dumps; not main CLI story |
| Web dashboard | Local | Sessions admin + `GET /api/sessions/{id}/export` |

### What remote MCP clients see today (the gap)

The async bridge stores tasks in **`async_bridge.db`**: prompt, status, final output/error, **`session_id`** (`--pass-session-id`). It does **not** stream Hermes’s inner tool loop to the client.

From Claude/Pi/Codex over MCP:

```text
hermes_submit → hermes_status (running…) → hermes_result (final text only)
```

Optional: **`hermes_sessions`** / session lookup on the Mac mini to inspect `state.db`.

That is why a Claude Code session can be reconstructed as a 739-event timeline from **local jsonl**, while Hermes work through MCP looked like a black box until `hermes_result` — or timeout.

**`hermes_result` text is a claim, not proof.** Verification that stops there will grade `PARTIAL` or `FAILED` for any non-trivial task.

### Mental model

```text
Pi / Claude Code:  live UI ──append──► session.jsonl     (file IS the audit trail)

Hermes:            live UI ──append──► state.db         (DB IS the audit trail)
                   jsonl only on export or opt-in snapshots

MCP bridge today:  client ◄──poll── async_bridge.db      (summary only)
                   full evidence ◄── Mac mini ── state.db + sessions export
```

### Evidence tiers for the satellite verifier (normative)

Implementations must emit a machine-parseable `EVIDENCE_TIER: T0|T1|T2|T3` line in the `## Report` (in addition to the prose "What did you verify?"). The verify trigger clamps the reported confidence to the tier's cap in CODE before the bar colors or the task is marked done: `confidence = min(reported, capFor(tier))`. The cap is enforced after parsing, not left as a request to the LLM. Caps: T0 to PARTIAL, T1 to VERIFIED, T2/T3 to PERFECT-eligible. A satellite Report missing the `EVIDENCE_TIER` line is rejected (the parser must not default it).

| Tier | Source | Verifier can prove | Typical CONFIDENCE cap |
|------|--------|-------------------|------------------------|
| **T0** | `hermes_result` final text only | Claims explicitly quoted in result | PARTIAL at best |
| **T1** | Bridge task row + `session_id` + `hermes_sessions` summary | Session existed; metadata; truncated history if tool returns it | PARTIAL / VERIFIED for trivial tasks |
| **T2** | `hermes sessions export` jsonl (post-task) | Full tool call/result sequence for that session | VERIFIED / PERFECT when oracles match |
| **T3** | Bridge streams `state.db` tail / TUI-style events over MCP (future) | Live + post-hoc same as inside Hermes | PERFECT when complete |

**Phase 3 minimum:** T1 for smoke tests; **T2 required** for production verify loops on code/filesystem tasks. "Code/filesystem task" is detected deterministically, not by judgment: if `hermes_decompose` yields any `tool_execution` atom whose `toolName` is in the write/fs/exec set, the task requires T2, and VERIFIED/PERFECT is forbidden on T0/T1 for that task.

### Practical paths to T2 (rough effort order)

1. **Post-task export (Phase 3 baseline):** After terminal status, bridge or client runs on Mac mini:
   `hermes sessions export /tmp/<task_id>.jsonl --session-id <id>`
   Attach export path or body to callback payload / new MCP tool `hermes_transcript`.
2. **Opt-in snapshots:** Enable `sessions.write_json_snapshots: true` if continuous files are needed without manual export.
3. **Bridge build-out (Phase 4):** `mcp_events` + hook tailing `state.db` / forwarding tool events over MCP (see `hermes-mcp.md` dashboard item).

Dispatch prompts should require Hermes to **include proof artifacts in the result** (command output, file excerpts, paths) even before T2 exists — that raises T0 toward usable, but does not replace T2 for structural verification.

### Mapping local verifier concepts → Hermes

| Local Pi verifier | Hermes satellite equivalent |
|-------------------|----------------------------|
| `BUILDER_SESSION_FILE` + line slice | `HERMES_SESSION_ID` + T2 export jsonl **or** `hermes_transcript` tool output |
| Read jsonl events in slice | Parse export messages / query `state.db` via bridge |
| `verifier_prompt` | `hermes_respond` |
| Builder final assistant message = claim | `hermes_result` final text = claim; tool rows in export = evidence |

### Why a decomposition tool (not LLM-only)

The local Pi verifier puts decomposition in the **persona** (“atoms over assertions”) because Pi jsonl is heterogeneous and the verifier reads an arbitrary slice. That works on one machine but is **non-deterministic, expensive, and inconsistent** — the model may miss sub-claims or invent them.

Hermes T2 export is **already structured**: `sessions` + `messages` with `role`, `tool_calls`, `tool_name`, `content`. That is ideal input for a **`hermes_decompose` tool** that emits a fixed `AtomicClaim[]` before the verifier LLM runs any oracles.

**Split of responsibilities:**

| Step | Who | Deterministic? |
|------|-----|----------------|
| Fetch transcript | `hermes_transcript` | Yes |
| **Decompose into atoms** | **`hermes_decompose`** | **Partial.** `tool_execution` atoms (rule 1) and `user_requirement` atoms (rule 3) are deterministic. `assistant_assertion` atoms (rule 2) are best-effort NL extraction, golden-tested, and marked advisory (see rules below). |
| Match user intent to atoms | `hermes_decompose` + original prompt | Mostly yes if dispatch uses acceptance block |
| Run oracles (file exists, diff, exit code) | Satellite verifier LLM + read-only tools / domain scripts | Per-claim |
| Grade + `hermes_respond` | **`satellite-verifier.md`** persona | Judgment on oracle results only |

The satellite verifier LLM should **not** re-parse raw transcript structure every cycle. It should receive a claim checklist and **prove or disprove each row**.

**`AtomicClaim` shape (sketch):**

```typescript
interface AtomicClaim {
  id: string;
  kind: "tool_execution" | "assistant_assertion" | "user_requirement" | "structured_assistant_claim";
  source: { messageIndex: number; toolName?: string };
  text: string;
  /** Present for tool_execution — the tool result row from export */
  embeddedEvidence?: string;
  suggestedOracle?: "tool_result" | "file_path_in_result" | "git_in_result" | "manual";
  /** Set only when kind==="structured_assistant_claim": the forced-schema mechanism that produced it. Absent => treat as assistant_assertion (prompt-only, not canonical). */
  structuredOutputMechanism?: "response_format" | "strict_tool" | "verify_claims_tool" | "plugin_complete_structured";
}
```

**Decomposition rules (v1):**

1. (Deterministic) Every `tool_call` + matching `tool_result` → one `tool_execution` claim with `embeddedEvidence`. `embeddedEvidence` MUST be sourced only from the T2 export `tool_result` row, never from `hermes_result` final text (which is fabricable T0 prose). This closes the evidence-laundering path.
2. (Advisory, best-effort) Final assistant message → extract assertion sentences (patterns + bullet lines) → `assistant_assertion` claims, cross-linked to nearest preceding tool rows by index. `assistant_assertion` atoms may NOT raise confidence and MUST NOT count toward PERFECT completeness unless each is linked to a `tool_execution` oracle.
3. (Deterministic) Original dispatch prompt → if structured with `## Acceptance` (required in dispatch persona), parse bullets → `user_requirement` claims.
4. (Candidate-only) A schema-shaped `verify_claims` block in the final assistant output is NOT canonical. Confirmed on the live Mac mini: `hermes chat -q` exposes no `--json`/`--schema` flag and the API server does not forward `response_format`/`output_config` into the agent final response; only `agent/plugin_llm.py:complete_structured()` can force a schema, and that is a host/plugin path, not the normal final-response path. Parse and schema-validate such a block, but cap confidence at <= 0.55 as a `structured_assistant_claim` and never let it satisfy `user_requirement` completeness or PERFECT, UNLESS the transcript proves a forced mechanism (provider `response_format`, strict tool use, a dedicated `verify_claims` tool call recorded in T2, or a bridge-owned `plugin_llm.complete_structured` call). The bridge MUST record `structuredOutputMechanism`; absent that field, classify as `assistant_assertion`.

**Where it lives (ownership decided):**

- **Canonical logic:** `apps/verifier/hermes/decompose.ts` is the single source of truth, with golden fixtures from real captured exports (see fixtures gate below).
- **Pi:** `registerTool("hermes_decompose", …)` calls that module directly.
- **Bridge (Phase 3/4):** the Mac-mini bridge does NOT re-implement decomposition in Python. It either (a) shells to `bun apps/verifier/hermes/decompose.ts` against the exported jsonl, or (b) returns the raw T2 export and lets the client decompose. Prefer (a) when non-Pi clients need claims without running the TS locally.
- **Conformance gate:** if any second implementation is ever introduced, both MUST pass the same committed golden fixtures in CI. No unfixtured "same rules" claim ships.
- **Fixtures prerequisite:** decompose.ts may not be designed against an assumed export schema. Commit at least three real `hermes sessions export` samples (success, tool-failure, resumed/respond) as the schema anchor BEFORE writing the parser.

---

## Cost telemetry

The $47 MoA incident showed the gap: **verification without cost visibility** still leaves the operator blind until the provider bill arrives. Cost telemetry is a **first-class deliverable**, not an optional Phase 4 footnote.

### Where cost data already exists

| Store | What it has today | Gap |
|-------|-------------------|-----|
| **`~/.hermes/state.db`** | Session metadata + **computed cost**: model, prompt/completion token counters, timestamps, plus `estimated_cost_usd` / `cost_source` / `billing_provider` / `billing_mode` / `pricing_version` (confirmed on live state.db) | Not linked to MCP `task_id`; not returned to remote clients |
| **`async_bridge.db`** | Prompt, status, final text, `session_id` | **No** token/cost/model columns |
| **Remote MCP client** | Sees `hermes_result` paragraph only | No spend summary |
| **Verify Report** | CONFIDENCE / STATUS | No cost line item |

Hermes already **computes cost**, not just tokens: the `sessions` row carries `estimated_cost_usd`, `cost_source`, `billing_provider`, `billing_mode`, and `pricing_version` (confirmed on the live Mac mini state.db). Do NOT build a local pricing table; read these columns. The work is **bridging those columns → task row → MCP payload → verify Report**.

### Target: `TaskCostSnapshot` (normative shape)

Every terminal task (and every verify+correct cycle) should produce:

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
  estimatedUsd?: number | null; // null by default when no pricing table is configured; a wrong number is worse than null. Prefer provider accounting over a stale local table. Pin the pricing table location + effective date wherever one is used.
  perModelBreakdown?: Array<{ model: string; promptTokens: number; completionTokens: number; estimatedUsd?: number | null }>; // REQUIRED when expensiveToolsUsed includes delegate_task/MoA: a scalar model + estimate cannot price an aggregator + N workers
  expensiveToolsUsed?: string[]; // CONFIRMED (live state.db + source): delegation appears as "delegate_task" in assistant tool_calls[].function.name and in tool_result tool_name. There is NO "moa" tool name -- MoA is a virtual provider detected via session metadata (billing_provider="moa" / billing_base_url="moa://local"), never a tool name.
  /** From state.db sessions row: cost_source. "provider_models_api" = real $, "none" = subscription-included/unpriced (a blind spot, see costUnreconciled). */
  costSource?: "provider_models_api" | "none" | "estimated" | null;
  billingProvider?: string; // state.db billing_provider, e.g. "openrouter" | "moa"
  billingMode?: string;     // state.db billing_mode, e.g. "subscription_included"
  pricingVersion?: string;  // state.db pricing_version
  /** True when cost is a known blind spot: MoA moa://local rows report estimated_cost_usd=0.0 / cost_source=none despite real upstream spend. Surface as "unreconciled", never authoritative $0. */
  costUnreconciled?: boolean;
  source: "state.db" | "hermes_usage_api" | "estimated";
  capturedAt: string;        // ISO8601
}
```

### Bridge persistence (`task_costs` table)

| Column | Purpose |
|--------|---------|
| `task_id` | FK to bridge task |
| `session_id` | Hermes session |
| `loop_index` | 0 = initial submit; 1+ = after each `hermes_respond` |
| `provider`, `model` | From `state.db` session row |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | From session counters post-run |
| `estimated_usd` | Computed at capture time (nullable if unknown) |
| `expensive_tools_used` | JSON array; parsed from transcript tool names |
| `captured_at` | Timestamp |

Capture **on terminal status** (after subprocess exit): bridge reads `state.db` for `session_id`, inserts row, attaches snapshot to `hermes_result` and callback.

### MoA cost blind spot (normative)

MoA runs are a confirmed cost blind spot. MoA executes as a **virtual provider** (`billing_provider=moa`, `billing_base_url=moa://local`, `billing_mode=subscription_included`), and session accounting prices `agent.model`/`agent.provider` (= `moa`/`default`), NOT the resolved aggregator slot that actually calls OpenRouter. So the parent row reports `estimated_cost_usd=0.0` with `cost_source=none` even when the aggregator spent real dollars upstream -- exactly how the $47 stayed invisible. Confirmed against the live Mac mini state.db (session `20260630_081522_c6e18380`) and source (`agent/usage_pricing.py`, `agent/conversation_loop.py`).

Rules:

- A snapshot with `costSource="none"` + `billingProvider="moa"` + `billingMode="subscription_included"` MUST be surfaced as **`unreconciled`**, never as authoritative `$0`.
- `moa.reference` / `moa.aggregating` events are display-only and are NOT persisted in T2 exports; do not expect to reconstruct per-model MoA spend from the transcript. Durable MoA traces exist only if `moa.save_traces` is enabled (off by default) at `<hermes_home>/moa-traces/<session_id>.jsonl`.
- Exact MoA upstream spend is recoverable only from the OpenRouter dashboard/API, not locally. Treat the OpenRouter account guardrail as the hard backstop.

### MCP surface

| Tool / field | Behavior |
|--------------|----------|
| **`hermes_result`** | Include `cost: TaskCostSnapshot` block (not prose-only) |
| **`hermes_task_cost(task_id)`** | Query latest or full history for task + respond loops |
| **Callback payload** | Add `cost: TaskCostSnapshot` alongside `transcriptPath` |
| **`hermes_decompose`** | Flag delegation/MoA: `delegate_task` calls (from `tool_calls[].function.name` / `tool_name`) and MoA sessions (via `billing_provider=moa` metadata, not a tool name); informational, not block |

### Verify loop integration

The verifier **`## Report`** gains a required subsection:

```markdown
### Cost
- Task: <task_id> · loop <n>
- Model: <provider>/<model>
- Tokens: <prompt> + <completion> = <total>
- Estimated: $<estimated_usd> (<source>)
- Expensive tools: <list or none>
```

Rules:

- **PARTIAL/FAILED** on correctness does not hide cost; the operator sees both.
- **Counter semantics must be pinned before summing.** `state.db` token counters are session-cumulative, and `hermes_respond` resumes the SAME session, so each per-loop snapshot already carries the running total. Do NOT sum snapshots (that double-counts). Define exactly ONE of: (a) store a per-loop DELTA (current cumulative minus previous) and let chain cost be the sum of deltas, or (b) let chain cost be the LAST snapshot's cumulative total. The `TaskCostSnapshot.loopIndex` comment ("cumulative across resume/respond") and any "sum of snapshots" wording must be reconciled to whichever is chosen. This is a spec self-contradiction to resolve, not a code-vs-spec mismatch.
- Dispatch persona: if the prompt explicitly requests MoA, the acceptance block must say so, and decompose can cross-check `expensiveToolsUsed`.

### Phasing

| Phase | Cost telemetry deliverable |
|-------|---------------------------|
| **2** | Scaffold `TaskCostSnapshot` type; `hermes_result` returns stub/null cost field (document gap) |
| **3** | Verify Report `### Cost` section; persona requires it (may show “unavailable” until Phase 4) |
| **4** | Bridge captures from `state.db`; `task_costs` table; enrich `hermes_result` + callback; `hermes_task_cost` tool |
| **4+** | Optional guardrails: per-caller daily budget, preflight warning when prompt mentions MoA (not default block) |

### Non-goals (unchanged)

- Default-deny MoA at bridge — observability first, guardrails optional.
- Real-time token streaming to MCP clients (T3 live SSE) — post-task snapshot is Phase 4 minimum.

---

## Execution model — who does what

This plan is designed for a **three-agent build + dual verify** workflow:

```text
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  SCAFFOLD        │     │  WIRE            │     │  VERIFY (×2)     │
│  (Cursor /       │ ──► │  Pi coding agent │ ──► │  Claude Code     │
│   initial agent) │     │                  │     │  Codex           │
└──────────────────┘     └──────────────────┘     └──────────────────┘
        │                         │                         │
        │  files, stubs,          │  extensions,            │  independent
        │  personas, specs        │  justfile, pnpm,        │  read-only review
        │                         │  integration            │  + smoke tests
        ▼                         ▼                         ▼
   specs/ + empty            working `just              both must pass
   modules + tests           hermes-dispatch`           before merge
```

### Role: Scaffold agent (initial pass)

**Delivers:** directory layout, TypeScript/Python stubs, persona markdown, prompt templates, `.env.sample` keys, justfile recipes, test skeletons, this spec cross-linked from README.

**Does not:** claim production-ready integration without Pi wiring and dual verification.

### Role: Pi coding agent (wiring pass)

**Delivers:** Working Pi extensions that compile and run; MCP client calls against live bridge; poll loop encoded in extension code (not LLM-improvised); verifier trigger on Hermes completion; `pnpm run typecheck` clean.

**Authority for Pi APIs:** use live Pi coding agent documentation (`pi` CLI / upstream docs), not vendored copies in this repo.

### Role: Claude Code + Codex (independent verification)

**Each runs separately.** Neither may assume the other’s review.

**Verify:**

- Typecheck and lint pass
- Extension behavior matches this spec and `hermes-polling.md`
- Dispatch persona does not grant write/edit to satellite-verifier incorrectly
- Poll constants match spec (30 / 120 / 600)
- `hermes_result` called exactly once on terminal status
- Verify loop respects `max_loops`
- No secrets committed; `.env.sample` documents required vars
- Bridge auth required before exposing beyond Tailscale

**Output:** Each agent emits a short `## Verification Report` (PASS/FAIL + findings). Both PASS required to ship phase.

### Role: Hermes (Mac mini operator)

**Delivers:** Bridge transport migration, callback endpoint, observability tables, launchd updates, skill doc sync under `~/.hermes/`.

**Consumes:** This spec + `hermes-mcp.md` as the contract for server-side behavior.

---

## Phase breakdown

### Phase 0 — Plan anchor (this document)

**Deliverables:**

- [x] `specs/hermes-satellite-verify.md` (this file)
- [ ] README section: “Hermes satellite verify” linking here + `hermes-mcp.md`
- [ ] Hermes skill pointer: update `~/.hermes/skills/.../hermes-mcp-bridge/` to reference this plan

**Exit:** Hermes and all harnesses share one source of truth.

---

### Phase 0.5: Prerequisite code fixes (existing local verifier)

The satellite loop reuses the local `## Report` contract and its parser. Three defects in that reused code must be fixed before the satellite verify loop can be trusted. These are edits to existing source, not new scaffold.

- [ ] **`\Z` end-anchor bug (blocker, live today).** `apps/verifier/verifier.ts:1057` builds the H3 section regex with `\Z`, which JavaScript treats as a literal `Z`, not end-of-string. The final H3 section is silently dropped unless it contains a capital `Z` or is followed by another heading. Replace `\Z` with `$(?![\s\S])`. Regression test: a Report whose last section is `### Verification metadata` (no `Z`) must round-trip. The new `### Cost` block currently only parses because its ISO `capturedAt` value carries a `Z`; do not rely on that accident.
- [ ] **Confidence-absence launder (blocker).** `apps/verifier/verifier.ts:1046-1049` derives `CONFIDENCE` from `STATUS` when the line is absent (`verified` maps to `verified`). On the satellite path this lets a T0 verify report green by omission. For satellite Reports: require an explicit `CONFIDENCE:` line AND an `EVIDENCE_TIER:` line, and clamp confidence by tier in code (see Evidence tiers). Reject satellite Reports missing either line.
- [ ] **Report header set (high).** `apps/verifier/verifier.ts:1015-1021` (`REPORT_HEADERS`) is a closed set and `parseReport` ignores unknown H3s, so `### Cost` and the evidence-tier declaration are dropped. Add `Cost` and `Evidence tier` to the satellite parser's header set. Scope Hermes-only; do not add to the generic local `verifier.md` contract, where cost is meaningless.

**Exit:** the three fixes land with regression tests; `parseReport` round-trips a final section that contains no `Z`, and surfaces `### Cost`.

---

### Phase 1 — Scaffold (repo: `the-verifier-agent`)

**Goal:** File tree and contracts exist; nothing claims to be wired yet.

**Create:**

```text
the-verifier-agent/
├── apps/verifier/
│   ├── hermes/
│   │   ├── client.ts          # MCP HTTP client (Streamable HTTP)
│   │   ├── poll.ts            # POLL_INITIAL/INTERVAL/MAX from hermes-polling.md
│   │   ├── types.ts           # TaskId, TaskStatus, HermesResult, TaskCostSnapshot, AtomicClaim, …
│   │   ├── config.ts          # HERMES_MCP_URL, HERMES_MCP_TOKEN from env
│   │   ├── transcript.ts      # T1/T2 evidence fetch (hermes_sessions, export jsonl parse)
│   │   └── decompose.ts       # T2 → AtomicClaim[] (deterministic; unit-tested)
│   ├── hermes-dispatch.ts     # Pi extension: dispatch tools + poll orchestration
│   └── hermes-verify-trigger.ts  # stub: fires verify cycle on terminal status
├── .pi/verifier/
│   ├── agents/
│   │   ├── hermes-dispatch.md    # crafts prompts; must not do remote work locally
│   │   └── satellite-verifier.md    # read-only verify; hermes_respond for corrections
│   └── prompts/
│       └── verify_on_satellite_complete.md
├── .env.sample                  # HERMES_MCP_URL, HERMES_MCP_TOKEN, optional CALLBACK_URL
└── justfile                     # add hermes-dispatch recipe (stub ok)
```

**`hermes-dispatch.md` persona (frontmatter sketch):**

```yaml
name: hermes-dispatch
description: Dispatch structured work to Hermes via MCP; do not execute locally.
tools: read, grep, find, ls, hermes_submit, hermes_status, hermes_result, hermes_respond, hermes_cancel, hermes_list
model: <operator choice>
domain: hermes-satellite
max_loops: 3
```

**`satellite-verifier.md` persona:** fork of `verifier.md` with the same confidence ladder and `## Report` block, but `verifier_prompt` is replaced by `hermes_respond`. **Call `hermes_decompose` first**; do not manually re-parse the transcript. Oracle each claim in the returned checklist; mark PASS/FAIL/UNSURE per row in the Report.

**Launch path (normative).** The satellite verifier is spawned as an in-session MCP client, NOT via `spawnVerifierChild` / the local tmux launcher. `normalizeToolsList` (`apps/verifier/_shared/launcher.ts:414-421`) unconditionally appends `verifier_prompt`, a unix-socket tool that is dead off-machine; reusing that path would inject the wrong correction tool and can filter out `hermes_respond`. This is a conditional trap, not an unconditional break: it fires only if a Pi "full extension stack" satellite verifier is spawned through that launcher. If that ever happens, the launcher must append `hermes_respond` (not `verifier_prompt`), verified in the Phase-5 gate.

**Persona body templating (normative).** The fork MUST strip all local-only slots from the body (`<BUILDER_SESSION_ID>`, `<BUILDER_SESSION_FILE>`, `<SOCKET_PATH>`), because `templateBody` (`apps/verifier/_shared/frontmatter.ts:90-101`) leaves unmatched `<UPPER_SNAKE>` slots as LITERAL text in the system prompt. Name the component that renders the satellite persona body and its variables, and give every `verify_on_satellite_complete.md` variable a non-empty default so an absent value never leaks a raw placeholder into the prompt.

**Read-only enforcement (normative).** For in-session Claude/Codex verifiers the persona `tools:` field is enforced by nothing (unlike the Pi `--tools` path). Run the in-session verifier on a tool-allowlisted MCP session that omits write/edit, OR add a post-hoc check that the verify transcript contains no mutating tool calls. Do not call this path read-only without one of those.

**Dispatch persona requirement:** prompts must include a `## Acceptance` section (bulleted, testable) so `hermes_decompose` can emit `user_requirement` atoms without LLM guesswork.

**`verify_on_satellite_complete.md` variables:**

| Variable | Source |
|----------|--------|
| `HERMES_TASK_ID` | bridge task row |
| `HERMES_SESSION_ID` | bridge / result payload |
| `ORIGINAL_PROMPT` | dispatch prompt text |
| `HERMES_RESULT_TEXT` | `hermes_result` body (T0 — claims only) |
| `HERMES_TRANSCRIPT` | T2 export jsonl or `hermes_transcript` tool output (evidence) |
| `HERMES_CLAIMS` | Output of `hermes_decompose` (structured checklist) |
| `EVIDENCE_TIER` | T0 / T1 / T2 / T3 — which sources were available |
| `TURN_INDEX` | verify loop counter |
| `MAX_LOOPS` | persona frontmatter |

**Exit:** Scaffold compiles (`tsc --noEmit`); personas parse; justfile lists recipe; Claude + Codex can review structure.

---

### Phase 2 — Pi wiring

**Goal:** `just hermes-dispatch` submits a real task, polls correctly, returns result.

**Pi coding agent tasks:**

1. Implement `apps/verifier/hermes/client.ts`:
   - JSON-RPC / Streamable HTTP MCP client (URL + Bearer from env)
   - Tools: map to bridge `hermes_submit`, `hermes_status`, `hermes_result`, `hermes_respond`, `hermes_cancel`, `hermes_list`

2. Implement `apps/verifier/hermes/poll.ts`:
   - Export `waitForHermes(taskId): Promise<HermesResult | Timeout>`
   - Constants **must** match `hermes-polling.md`: 30, 120, 600
   - Always call `hermes_result` once on `completed` or `failed`

3. Implement `apps/verifier/hermes-dispatch.ts`:
   - `pi.registerTool()` wrappers delegating to client
   - Optional: internal poll after submit so the LLM cannot skip or mistime polls
   - Load dotenv from cwd (match existing `_shared/env.ts` pattern)

4. **justfile:**

```just
hermes-dispatch:
    pi -e ./apps/verifier/hermes-dispatch.ts -e ./apps/verifier/cross-agent.ts
```

1. Register tools in persona frontmatter to match extension exports.

**Manual smoke test:**

```bash
export HERMES_MCP_URL=http://100.x.x.x:8081/mcp
export HERMES_MCP_TOKEN=<token>
just hermes-dispatch
# Prompt: "Reply with the word PONG and nothing else."
```

**Exit:** Smoke test returns PONG via Hermes; poll metrics meet `hermes-polling.md` targets.

---

### Phase 3 — Verify loop (Pi + any MCP client)

**Goal:** After Hermes completes, automated verify → correct → re-verify until `CONFIDENCE` ≥ VERIFIED or loops exhausted — using **T2 evidence** for non-trivial tasks.

**Pi coding agent tasks:**

1. Finish `hermes-verify-trigger.ts`:
   - On terminal poll result → `hermes_transcript` → **`hermes_decompose`** → inject `verify_on_satellite_complete.md` with `HERMES_CLAIMS` pre-filled
   - Verifier oracles each claim; emits `## Report` with per-claim PASS/FAIL/UNSURE rows
   - Map `CONFIDENCE` / `STATUS` to actions (same semantics as local `verifier.ts`)
   - On `FEEDBACK` / failed claims → `hermes_respond(corrective)` → poll again → re-verify
   - Increment loop counter; at `max_loops` → escalate message to user (no silent retry)
   - If only T0 available on a filesystem/code task → grade PARTIAL/FAILED and state need for T2 in Report

2. Implement `apps/verifier/hermes/transcript.ts` + **`decompose.ts`**:
   - **transcript.ts:** T1/T2 fetch via MCP
   - **decompose.ts:** parse export → `AtomicClaim[]`; golden tests under `apps/verifier/hermes/__fixtures__/`
   - Register **`hermes_decompose`** Pi tool (input: transcript json or session_id if transcript already fetched)

3. **Correction channel mapping:**

| Local verifier | Hermes satellite |
|----------------|------------------|
| `verifier_prompt(session_id, message)` | `hermes_respond(task_id or session_id, message)` |
| Builder `sendUserMessage` followUp | Hermes `--resume <session_id>` via bridge |
| JSONL slice `read` | `HERMES_TRANSCRIPT` + deterministic oracles on tool rows |

1. **Evidence oracles** (satellite verifier runs per claim from `HERMES_CLAIMS`):
   - `tool_execution` claims: compare assertion to `embeddedEvidence` first (deterministic PASS/FAIL when possible)
   - `assistant_assertion` claims: must cite tool row or external oracle; never PASS on prose alone
   - `user_requirement` claims: mapped from dispatch `## Acceptance`; FAIL if no supporting tool evidence
   - Report must list **every claim id** with verdict; refuse PERFECT if any row is UNCHECKED

**Bridge dependency (can ship in Phase 3 or early Phase 4):**

| Tool | Action |
|------|--------|
| **`hermes_transcript`** | Export session from `state.db`; return jsonl body or path |
| **`hermes_decompose`** | Export + run same decomposition rules as `decompose.ts`; return `AtomicClaim[]` JSON for non-Pi clients |

**Claude Code / Codex parallel path (no Pi required):**

1. `hermes_submit` with structured prompt + `## Acceptance`
2. Poll per `hermes-polling.md`
3. `hermes_transcript` → **`hermes_decompose`** (bridge MCP)
4. Verifier hat oracles each claim in checklist — **does not re-decompose manually**
5. `hermes_respond` on failure; repeat

**Exit:** Deliberately bad Hermes answer → decompose surfaces failed tool row → `hermes_respond` → second pass VERIFIED.

---

### Phase 4 — Bridge hardening (Hermes on Mac mini)

**Goal:** Production-shaped server matching `hermes-mcp.md` target architecture.

**Hermes tasks:**

| Task | Detail |
|------|--------|
| **Transport** | Native Streamable HTTP MCP in Python; remove `supergateway` + stdio. Confirmed: installed `mcp 1.26.0` already exposes `FastMCP(token_verifier=..., auth=AuthSettings(...), host, port, streamable_http_path)` and a static bearer verifier instantiates on the live venv. Pin `mcp>=1.26,<2`. See `.auto/research/hermes-phase4-blockers.md` section 1. |
| **Auth** | Bearer via SDK `token_verifier` + `AuthSettings` (not an ad-hoc header hack); reject unauthenticated. **Verified 2026-07-02:** A separate tailnet client: no-token initialize returned 401, bearer-token initialize returned 200 from the native FastMCP server. `/healthz` and custom routes may be intentionally unauthenticated and are NOT proof that MCP auth protects tools. |
| **Bind** | Tailscale IP `100.x.x.x` (+ LAN `10.x.x.x` when home); never blind `0.0.0.0`. TLS optional on Tailscale/private LAN, required at any public/Traefik edge. |
| **Observability** | SQLite tables: `mcp_events`, `task_runs`, **`task_costs`** (see [Cost telemetry](#cost-telemetry)) |
| **Cost capture** | On terminal: read session token counters from `state.db`; attach to `hermes_result` + callback |
| **Transcript bridge** | `hermes_transcript` MCP tool: export from `state.db` post-task; optional link to `session_id` in callback |
| **Retention** | Stop silent 24h task wipe; configurable retention |
| **Callback** | On terminal status POST to client `CALLBACK_URL` (optional per submit) |
| **Repo home** | Move canonical script to `apps/hermes-async-bridge/` (this repo or homelab); symlink from `~/.hermes/scripts/` |
| **Skill sync** | Update `hermes-mcp-bridge` skill + `async-bridge-architecture.md` |

**Callback payload (proposed — aligns with `apps/verifier/_shared/ipc.ts` Event semantics):**

```json
{
  "type": "event",
  "name": "stop",
  "taskId": "uuid",
  "hermesSessionId": "uuid",
  "status": "completed",
  "timestamp": 1719859200000,
  "originalPrompt": "...",
  "resultSummary": "...",
  "caller": "pi|claude|codex",
  "transcriptPath": "/tmp/<task>_<session>.jsonl",
  "evidenceTierAvailable": "T2",
  "cost": {
    "taskId": "uuid",
    "hermesSessionId": "uuid",
    "loopIndex": 0,
    "provider": "moa",
    "model": "default",
    "promptTokens": 790772,
    "completionTokens": 35763,
    "totalTokens": 826535,
    "estimatedUsd": null,
    "costSource": "none",
    "billingProvider": "moa",
    "billingMode": "subscription_included",
    "costUnreconciled": true,
    "expensiveToolsUsed": ["delegate_task"],
    "source": "state.db",
    "capturedAt": "2026-07-01T12:00:00Z"
  }
}
```

**Pi side (follow-up):** optional webhook listener extension OR long-poll `hermes_watch` tool to consume callbacks and skip blocking poll during execution.

**Exit:** Auth enforced; callback received on MacBook within 5s of Hermes terminal; audit row exists per task; **`task_costs` row populated** when session exists in `state.db`.

---

### Phase 5 — Dual independent verification (gate)

**Goal:** Claude Code and Codex each produce PASS before operator merges / deploys.

**Checklist (each agent runs alone):**

```markdown
## Verification Report — <agent name> — Phase <N>

- [ ] typecheck pass (`cd apps/verifier && pnpm run typecheck`)
- [ ] poll constants 30 / 120 / 600 enforced in code
- [ ] hermes_result called once on terminal status (code path review)
- [ ] dispatch persona has no write/edit
- [ ] satellite-verifier persona uses hermes_respond not verifier_prompt
- [ ] max_loops enforced on verify+correct cycle
- [ ] .env.sample documents HERMES_MCP_URL, HERMES_MCP_TOKEN
- [ ] no secrets in git
- [ ] smoke test: PONG task (Phase 2)
- [ ] smoke test: intentional fail → correct → pass (Phase 3)
- [ ] verify loop uses T2 + **hermes_decompose** claim checklist (not manual transcript parsing)
- [ ] decompose.ts unit tests pass on fixture exports
- [ ] Report cites every claim id; no PERFECT on result-paragraph-only
- [ ] Report includes `### Cost` (or explicit “cost unavailable” until Phase 4)
- [ ] bridge auth required (Phase 4, when deployed)

STATUS: PASS | FAIL
FINDINGS: ...
```

**Exit:** Two PASS reports archived in `specs/verification-reports/phase-N-claude.md` and `phase-N-codex.md`.

---

## IPC envelope reuse

Extend `apps/verifier/_shared/ipc.ts` (or sibling `hermes-ipc.ts`) with Hermes-specific types without breaking local verifier:

```typescript
/** Bridge callback / wake payload — mirrors Event{name:"stop"} semantics over HTTP */
export interface HermesTaskComplete {
  type: "event";
  name: "stop";
  taskId: string;
  hermesSessionId: string;
  status: "completed" | "failed";
  timestamp: number;
  originalPrompt?: string;
  resultSummary?: string;
  caller?: string;
}
```

Local unix socket IPC remains unchanged for `just v` (builder + verifier child).

---

## Configuration

### Client `.env` (MacBook)

```bash
# Required for Hermes MCP client
HERMES_MCP_URL=http://100.x.x.x:8081/mcp
HERMES_MCP_TOKEN=

# Optional: receive bridge completion callbacks (Phase 4)
HERMES_CALLBACK_URL=http://127.0.0.1:9477/hermes/callback
HERMES_CALLBACK_SECRET=
```

### MCP client config (Claude Code / Codex — conceptual)

```json
{
  "url": "http://100.x.x.x:8081/mcp",
  "headers": {
    "Authorization": "Bearer <HERMES_MCP_TOKEN>"
  }
}
```

### Mac mini bridge (today → target)

| | Today | Target |
|---|-------|--------|
| Endpoint | `http://100.x.x.x:8081/mcp` | Tailscale + auth |
| Wrapper | native Streamable HTTP (`mcp` SDK `FastMCP` + `token_verifier`) | native Streamable HTTP (`mcp` SDK `FastMCP` + `token_verifier`) |
| Auth | Bearer required; verified no-token 401 / bearer 200 from a separate tailnet client | Bearer required |

Paths: see [`hermes-mcp.md`](../hermes-mcp.md).

---

## Polling contract (normative)

Implementations **must** follow [`hermes-polling.md`](../hermes-polling.md):

| Constant | Value |
|----------|------:|
| `POLL_INITIAL_SEC` | 30 |
| `POLL_INTERVAL_SEC` | 120 |
| `MAX_WAIT_SEC` | 600 |

Encode in `apps/verifier/hermes/poll.ts` — do not rely on the LLM to sleep correctly.

### Bridge failure envelope (normative, observed)

Captured from the live async bridge; the poll loop and result parser MUST handle these, not only the happy path:

| Mode | Shape |
|------|-------|
| Hard timeout | After 600s the bridge kills the task: `status="failed"`, `result=""`, `error="Task timed out after 600s"`, `session_id=null`. Large multi-part prompts hit this; keep dispatched work small and scoped. |
| Upstream auth fail (fast) | ~3-5s: `status="failed"`, `error="Error: HTTP 401: User not found."` (billing/user rejection, e.g. drained OpenRouter credits), often with `result="Warning: Unknown toolsets: moa"`. |
| Success | `status="completed"` with a real top-level `session_id`. |

Contract consequences:

- A **failed** task returns top-level `session_id=null`; you CANNOT `hermes_respond` to a failure. (The fast-fail mode embeds a session id inside the `error` string; the timeout mode embeds none.) The correction loop MUST treat `failed` as terminal-without-resume, not retry blindly.
- `result` and `error` are independent fields: a failed task can carry a non-empty `result` (e.g. the `moa` warning) AND an `error`. Parse both.
- Only `completed` tasks yield a resumable `session_id`.

---

## Confidence ladder (reuse; STATUS mapping made explicit)

From `.pi/verifier/agents/verifier.md`. The `STATUS` column is added because `parseReport` (`apps/verifier/verifier.ts:1035-1037`) REQUIRES a `STATUS:` line whose value is one of `verified | failed | unsure`, or it discards the entire Report. A satellite persona that emits only `CONFIDENCE` loses its report silently. Every satellite Report MUST include both lines.

| CONFIDENCE | STATUS (required line) | Meaning | Action |
|------------|------------------------|---------|--------|
| PERFECT | verified | Every claim verified | Report done to user |
| VERIFIED | verified | All checked passed; minor gaps | Report done |
| PARTIAL | verified | No failures, but significant unverifiable gaps | Report + note gaps |
| FEEDBACK | failed | Failures found; `hermes_respond` sent | Poll + re-verify |
| FAILED | unsure | Cannot verify; escalate | Human |

---

## Hermes operator runbook (summary)

1. Read this spec + `hermes-mcp.md`.
2. Phase 4: migrate bridge to native HTTP + auth; deploy launchd.
3. Expose health: `GET /healthz`.
4. Log every MCP tool call to `mcp_events`; **capture token/model cost to `task_costs` on terminal**.
5. On task terminal: invoke optional callback URL (include `cost` block).
6. Keep skill docs under `~/.hermes/skills/autonomous-ai-agents/hermes-mcp-bridge/` in sync with repo.
7. Do not block MoA by default — **`task_costs.expensive_tools_used` and verify Report `### Cost`** are the post-mortem surface.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| MCP client only sees `hermes_result` (T0 black box) | `hermes_transcript` + T2 export from `state.db`; callback includes export path |
| Verifier ports Pi jsonl slice pattern to Hermes | Explicit evidence adapter; no `SESSION_FILE_*` in Hermes personas |
| Verifier cannot read Mac mini filesystem from MacBook | Tool outputs in T2 transcript; dispatch requires proof in result as interim |
| Callback delivery fails | Poll remains safety net (`hermes-polling.md`) |
| Claude and Codex verify different things | Shared checklist above; both must PASS |
| Bridge script drift (skill copy ≠ active script) | Single repo source + symlink (Phase 4) |
| Expensive prompts | Scoped dispatch discipline + **`task_costs`** + Report `### Cost`; optional budget caps Phase 4+ |

---

## Milestone summary

| Phase | Owner | Done when |
|-------|-------|-----------|
| 0 | Spec | This document + README link |
| 1 | Scaffold agent | Tree exists; typecheck stub pass |
| 2 | Pi coding agent | `just hermes-dispatch` PONG smoke test |
| 3 | Pi coding agent | Fail → correct → verify loop works |
| 4 | Hermes | Native HTTP + auth + callback + audit + **cost capture from state.db** |
| 5 | Claude Code + Codex | Independent PASS reports |

---

## References

- [`hermes-mcp.md`](../hermes-mcp.md) — bridge architecture, Mac mini paths, target transport
- [`hermes-polling.md`](../hermes-polling.md) — normative client poll algorithm
- [`README.md`](../README.md) — local Pi verifier (builder + unix socket child)
- `.pi/verifier/agents/verifier.md` — confidence ladder and verify contract
- `apps/verifier/_shared/ipc.ts` — envelope types for local verifier IPC
- Pi coding agent upstream documentation — API authority for extension wiring

---

## Message for Hermes

You are the **executor and bridge operator** on the Mac mini. Clients on developer laptops (and elsewhere) will send work through your MCP server; they will not do that work locally. Your job in this plan is:

1. **Run** tasks via `hermes chat` subprocesses with full agent capability when the prompt asks for it.
2. **Expose** a stable, authenticated HTTP MCP API (target: no supergateway).
3. **Record** observability for verification **and cost post-mortems** — scrape `state.db` session counters into `task_costs`; attach to MCP responses.
4. **Bridge evidence to clients** — the **satellite verifier** (MCP client) cannot rely on Pi-style jsonl slices. Provide T2 via `hermes sessions export` (tool: `hermes_transcript`) and eventually T3 event streaming.
5. **Signal** completion back to clients (callback) with `session_id` + optional `transcriptPath`.
6. **Accept** corrective prompts via `hermes_respond` and resume sessions until clients mark work verified.

Hermes already records rich evidence (tool names, token counts, FTS search) in **`~/.hermes/state.db`**. The gap is not missing data — it is **not pushing that transcript to remote MCP callers** the way Pi jsonl sits beside the verifier. Closing that gap is part of your Phase 4 deliverables.

The verification discipline (decompose claims, evidence not assertions, confidence grades, loop limits) lives in this repo’s personas. Your bridge is the **transport, execution, and evidence-export layer**; the clients own **dispatch quality** and **verify loops**.

When Phase 4 starts, treat `specs/hermes-satellite-verify.md` and `hermes-mcp.md` as the contract. Open an issue if callback URL shape or auth token rotation needs a decision.
