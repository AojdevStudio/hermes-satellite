# Satellite Verification Cycle

## Purpose

Verify the work Hermes completed for task `<HERMES_TASK_ID>`. This prompt fires when Hermes reaches a terminal status (`completed` or `failed`). Use the pre-decomposed claim checklist, oracle each row against T2 evidence when available, and emit a `## Report` per your system-prompt contract.

## Variables

HERMES_TASK_ID: <HERMES_TASK_ID>
HERMES_SESSION_ID: <HERMES_SESSION_ID>
ORIGINAL_PROMPT: <ORIGINAL_PROMPT>
HERMES_RESULT_TEXT: <HERMES_RESULT_TEXT>
HERMES_TRANSCRIPT: <HERMES_TRANSCRIPT>
HERMES_CLAIMS: <HERMES_CLAIMS>
EVIDENCE_TIER: <EVIDENCE_TIER>
TURN_INDEX: <TURN_INDEX>
MAX_LOOPS: <MAX_LOOPS>

### Original dispatch prompt

<ORIGINAL_PROMPT>

### Hermes final result (T0 — claims only)

<HERMES_RESULT_TEXT>

### Pre-decomposed claims (from hermes_decompose)

<HERMES_CLAIMS>

### Transcript export (T2 evidence when available)

<HERMES_TRANSCRIPT>

## Instructions

- **Do not re-decompose manually** if `HERMES_CLAIMS` is populated — oracle each listed claim. Call `hermes_decompose` only when the checklist is missing or stale.
- **Respect evidence tier `<EVIDENCE_TIER>`.** T0 alone cannot support VERIFIED/PERFECT on code/filesystem tasks. State tier limitations explicitly in the Report.
- **Ground truth intent** is the original dispatch prompt above — verify against what was **requested**, not extra work Hermes did unprompted.
- **Hermes result text is a claim**, not proof. Prefer tool rows in the transcript export for oracles.
- **`delegate_task` rows prove only the delegation**, not the child's work — child tool calls are absent from this export. Oracle claims about delegated slices against world state (the artifacts the dispatch prompt's `## Delegation plan` named), never against child summaries alone.
- If verification fails AND you have a concrete corrective fix, call `hermes_respond` with `task_id=<HERMES_TASK_ID>` **before** emitting the Report.
- If you cannot verify (no T2 on a fs/code task, no oracle, ambiguous claim), set `STATUS: unsure` and list what's missing under "What do you need from me to verify this next time?"
- End with exactly one `## Report` block. After the Report: stop.

## Workflow

1. Note `EVIDENCE_TIER`, `TURN_INDEX`, and `MAX_LOOPS` — loop `<TURN_INDEX>` of `<MAX_LOOPS>`.
2. For each claim in the checklist, select an oracle (tool result content, file read, grep, bash read-only, domain script).
3. Record PASS / FAIL / UNSURE per claim with exact tool output citations.
4. If any FAIL with a concrete fix → `hermes_respond(task_id=<HERMES_TASK_ID>, message=<fix>)`.
5. Emit `## Report` including `EVIDENCE_TIER`, `### Cost`, and per-claim rows. Stop.
