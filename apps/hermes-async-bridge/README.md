# Hermes async bridge

Native Python MCP Streamable HTTP server for Phase 4 of Hermes satellite verification.

This is the canonical repo copy intended to replace the prototype `~/.hermes/scripts/hermes_async_bridge.py` + `supergateway` launch path.

## Runtime contract

- Transport: official Python MCP SDK 2.x `MCPServer` with `transport="streamable-http"`.
- Auth: SDK bearer token verifier via `token_verifier` + `AuthSettings`; set `HERMES_ASYNC_BRIDGE_TOKEN`.
- Bind: explicit Tailscale/LAN host only. The script refuses `0.0.0.0` for HTTP.
- SQLite state: defaults to `$HERMES_HOME/async_bridge.db`. Inspect it read-only with the `hst` CLI (`scripts/hst.ts` at the repo root): tasks, per-task detail, costs, events, health.
- Hermes evidence: reads `$HERMES_HOME/state.db` for transcript/cost metadata.

## HTTP boundaries

| Path | Purpose | Authentication |
|------|---------|----------------|
| `/mcp` | MCP Streamable HTTP only | `HERMES_ASYNC_BRIDGE_TOKEN` |
| `/healthz` | Liveness only; it proves neither auth nor task execution | None |
| `/alerts/pullsmith/v1` | Durable Pullsmith operational-alert acceptance | Dedicated `HERMES_PULLSMITH_ALERT_TOKEN` |

The Pullsmith route does not accept the general MCP bearer. The two configured
tokens must differ. Authentication is checked before the request body is read
or parsed, and envelopes are limited to 64 KiB with bounded strings,
collections, and nesting.

The V1 request is:

```json
{
  "version": 1,
  "id": "storage-alert:archive-unavailable:<digest>",
  "source": "pullsmith",
  "audience": "hermes",
  "kind": "archive-unavailable",
  "severity": "error",
  "message": "Evidence archive unavailable",
  "detail": { "objectCount": 2, "sample": ["sha256:..."] },
  "raisedAt": "2026-09-01T04:00:00Z"
}
```

Successful first acceptance and exact replay both return HTTP `202`:

```json
{
  "version": 1,
  "id": "storage-alert:archive-unavailable:<digest>",
  "transport": "hermes-async-bridge-alert-v1",
  "taskId": "<full-sha256>",
  "acceptedAt": "2026-09-01T04:00:01Z"
}
```

Acceptance atomically commits the immutable `operational_alerts` row and its
pending Hermes task before scheduling work. Exact replay returns the original
receipt; reuse of an id with a different canonical payload returns HTTP `409`
with `alert-id-conflict`. Startup reschedules accepted pending tasks and stale
running tasks under the same deterministic task id. Malformed envelopes return
`400`, unauthenticated requests `401`, and oversized requests `413`.

## Tools

- `hermes_submit(prompt, caller?, callback_url?)`
- `hermes_status(task_id)`
- `hermes_result(task_id)` — includes latest `cost` snapshot when available
- `hermes_respond(task_id, prompt, callback_url?)`
- `hermes_cancel(task_id)`
- `hermes_list(status?, limit?)`
- `hermes_sessions(limit?)`
- `hermes_transcript(session_id, include_body?)`
- `hermes_decompose(session_id? transcript_jsonl? original_prompt?)`
- `hermes_task_cost(task_id, history?)`

## Launch example

Current self-hosted deployments run from a local clone. A clone-free installer and the managed service are planned, not available today.

```bash
git clone https://github.com/AojdevStudio/hermes-satellite.git
cd hermes-satellite

export HERMES_HOME=~/.hermes
export HERMES_ASYNC_BRIDGE_TOKEN='<shared bearer token>'
export HERMES_PULLSMITH_ALERT_TOKEN='<different-alert-only-token>'
export HERMES_ASYNC_BRIDGE_HOST=100.x.x.x
export HERMES_ASYNC_BRIDGE_PORT=8081
~/.hermes/hermes-agent/venv/bin/python3 \
  <repo-root>/apps/hermes-async-bridge/hermes_async_bridge.py
```

The legacy `supergateway` command should be removed once launchd points directly at this script.

## Deployment shape

Generate each bearer token once from the OS CSPRNG. Keep the MCP and Pullsmith
alert tokens distinct. Do not print either token in logs, commit it, or put it
directly in the plist. Your secrets manager is canonical; local files are only
runtime caches.

Deployment checklist:

1. `mkdir -p ~/.hermes/secrets && chmod 700 ~/.hermes/secrets`.
2. Generate `secrets.token_urlsafe(48)` into
   `<local-secret-file>` and `chmod 600` the file.
3. Mirror the same value to Bitwarden Secrets Manager, e.g. key
   `HERMES_ASYNC_BRIDGE_TOKEN`, under the appropriate machine/agent secrets
   project.
4. Use a wrapper script outside the repo to read the token file, export
   `HERMES_ASYNC_BRIDGE_TOKEN` and the separately stored
   `HERMES_PULLSMITH_ALERT_TOKEN`, then exec the repo bridge.
5. Cut transport over at the same time: while `supergateway` is still in front,
   setting `HERMES_ASYNC_BRIDGE_TOKEN` does not protect HTTP because the Python
   script only sees stdio. Auth is real only after native MCP HTTP is the
   process listening on the socket.

```bash
ln -sf <repo-root>/apps/hermes-async-bridge/hermes_async_bridge.py \
  ~/.hermes/scripts/hermes_async_bridge.py
```

Then update `~/Library/LaunchAgents/com.example.hermes-async-bridge.plist` to run the Hermes venv Python directly rather than `npx supergateway`.

## Verification

Local syntax check does not require `mcp` installed in this repo environment:

```bash
python3 -m py_compile apps/hermes-async-bridge/hermes_async_bridge.py
```

Runtime verification must use the Hermes venv, which is expected to satisfy
`requirements.txt` (`mcp>=2,<3`):

```bash
~/.hermes/hermes-agent/venv/bin/python3 - <<'PY'
from pathlib import Path
import importlib.util
path = Path('apps/hermes-async-bridge/hermes_async_bridge.py')
spec = importlib.util.spec_from_file_location('bridge', path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print('loaded', mod.STREAMABLE_PATH)
PY
```

Live auth smoke tests must cover both directions:

- Negative: an unauthenticated MCP request to `/mcp` returns 401/403. If it
  returns a normal MCP response, auth is not actually enforced.
- Positive: the same request with `Authorization: Bearer ${HERMES_MCP_TOKEN}` initializes
  successfully.
- Then run a small authenticated `hermes_submit` PONG task and verify
  `hermes_result`, `hermes_transcript`, and `hermes_task_cost`.
