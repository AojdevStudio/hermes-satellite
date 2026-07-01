# Hermes async polling — simple algorithm

How Claude should wait on a Hermes task after `hermes_submit`. Derived from session `0324398b` (739 events): the bridge worked, but polls every ~240s only gave ~2 checks inside Hermes’s ~600s window — lots of `running`, then `failed`.

## Constants

| Name | Value | Why |
|------|------:|-----|
| `POLL_INITIAL_SEC` | 30 | Catch fast tasks (ping, tiny edits) |
| `POLL_INTERVAL_SEC` | 120 | ~5 status checks inside a 600s window |
| `MAX_WAIT_SEC` | 600 | Match Hermes task timeout; stop chasing |

## Algorithm

1. **Submit** → save `task_id` and `submit_time`.
2. **Sleep** `POLL_INITIAL_SEC`, then **`hermes_status(task_id)`**.
3. **`completed`** → **`hermes_result(task_id)`** once → done.
4. **`failed`** → **`hermes_result(task_id)`** once anyway (error/partial text) → done.
5. **`running`** or **`pending`** → if `now - submit_time >= MAX_WAIT_SEC`, stop (timeout); else sleep `POLL_INTERVAL_SEC` → go to step 2.
6. Report outcome to the user (result payload, or timeout + last status).

## Pseudocode

```text
POLL_INITIAL_SEC = 30
POLL_INTERVAL_SEC = 120
MAX_WAIT_SEC = 600

function waitForHermes(task_id):
  submit_time = now()
  sleep(POLL_INITIAL_SEC)

  loop:
    status = hermes_status(task_id)

    if status == "completed":
      return hermes_result(task_id)

    if status == "failed":
      return hermes_result(task_id)

    if now() - submit_time >= MAX_WAIT_SEC:
      return { timeout: true, last_status: status }

    sleep(POLL_INTERVAL_SEC)
```

## ScheduleWakeup variant

Same logic when the session can’t block in a loop:

```text
After submit: schedule wakeup +30s.
On wakeup: hermes_status.
  completed/failed → hermes_result, report, stop.
  running/pending and elapsed < 600s → schedule +120s, stop.
  elapsed >= 600s → report timeout, stop.
```

## Rules for Claude

- After every **`hermes_submit`**, follow this poll loop (or wakeup chain) until terminal or timeout.
- On **any** terminal status (`completed` or `failed`), call **`hermes_result` exactly once** before reporting.
- Do **not** poll faster than every 30s.
- Do **not** poll forever; **600s from submit** is the hard stop.
- One `task_id` per poll chain unless the user explicitly asked for parallel Hermes tasks.

## What “good” looks like

| Metric | Bad (session) | Target |
|--------|---------------|--------|
| Interval while `running` | ~240s | **120s** |
| Polls inside 600s window | ~2–3 | **~5** |
| `hermes_result` after terminal status | sometimes skipped | **always** |

A high **`running`** share on polls is normal while Hermes works. The failure mode is **`failed` without ever seeing `completed`** — usually too few polls before the 600s cap.

## MCP tools

- `mcp__hermes-async__hermes_submit` — start task
- `mcp__hermes-async__hermes_status` — poll
- `mcp__hermes-async__hermes_result` — fetch outcome (required on terminal status)
