# Hermes MCP bridge — main machine install handoff

Date: 2026-07-02
Audience: operators installing the MCP client on a developer machine

## Bottom line

The Mac mini bridge is no longer the old `supergateway` stdio wrapper. It is now intended to be consumed as a remote HTTP MCP server over Tailscale; clients must be on the tailnet:

- URL: `http://100.x.x.x:8081/mcp`
- Transport: Streamable HTTP MCP
- Auth: `Authorization: Bearer <HERMES_MCP_TOKEN>`
- Token source for this repo checkout: `<repo-root>/.env`
- Token canonical source: your secrets manager entry for `HERMES_ASYNC_BRIDGE_TOKEN`

Do not configure this as a local command/stdio server on the main machine. The Mac mini is the server; the main machine is only a client.

## Current server state

Verified locally on the Mac mini before this handoff:

- launchd label: `com.example.hermes-async-bridge`
- ProgramArguments: `<service-wrapper>`
- Listener: Python process on `100.x.x.x:8081`
- Canonical repo script: `apps/hermes-async-bridge/hermes_async_bridge.py`
- Runtime symlink: `<runtime-script-link>`
- Runtime token cache: `<local-secret-file>`
- Secrets manager mirror: `HERMES_ASYNC_BRIDGE_TOKEN`

Auth has been verified from a separate tailnet client: no-token initialize returned 401, and bearer-token initialize returned 200 with a clean native FastMCP response. New clients should still run the same checks after install to catch local token/config mistakes.

## Install objective on main machine

Configure the local Hermes/Codex/Claude MCP client to connect to the Mac mini bridge over URL-based HTTP MCP with bearer auth.

Expected tools after discovery will be prefixed by the local MCP client. In Hermes Agent, server name `hermes_async` should produce tools like:

- `mcp_hermes_async_hermes_submit`
- `mcp_hermes_async_hermes_status`
- `mcp_hermes_async_hermes_result`
- `mcp_hermes_async_hermes_respond`
- `mcp_hermes_async_hermes_transcript`
- `mcp_hermes_async_hermes_decompose`
- `mcp_hermes_async_hermes_task_cost`

## Recommended Hermes Agent config

Edit `~/.hermes/config.yaml` on the main machine and add:

```yaml
mcp_servers:
  hermes_async:
    url: "http://100.x.x.x:8081/mcp"
    headers:
      Authorization: "Bearer ${HERMES_MCP_TOKEN}"
    timeout: 180
    connect_timeout: 60
```

If Hermes config does not expand `${HERMES_MCP_TOKEN}` in YAML headers in the installed version, put the token value directly in the local profile's private config/env mechanism, not in repo docs. Do not print the token in terminal output or chat.

Alternative CLI starting point, if the current Hermes build supports header-auth setup interactively:

```bash
hermes mcp add hermes_async --url http://100.x.x.x:8081/mcp --auth header
```

Then inspect `~/.hermes/config.yaml` and ensure it has an Authorization header using the Bearer scheme.

## Required smoke tests

Run these in order from the main machine or another tailnet node. Do not skip the negative case.

Important quirk: the Mac mini cannot reliably curl its own Tailscale IP. Do not use a Mac-mini-local curl to judge this bridge; test from another tailnet node.

### 1. Network health

```bash
curl -fsS http://100.x.x.x:8081/healthz
```

Expected: `ok`.

### 2. Negative auth test

Send MCP initialize with no `Authorization` header.

Expected: HTTP `401` or `403`.

Expected: HTTP `401`.

If a tokenless request returns a normal MCP initialize response, auth is not real. Stop and report this as a blocker.

### 3. Positive auth test

Send MCP initialize with:

```text
Authorization: Bearer $HERMES_MCP_TOKEN
Accept: application/json, text/event-stream
Content-Type: application/json
```

Expected: HTTP 200/202-class MCP response with initialize result and/or an `mcp-session-id` header.

Expected: HTTP `200` with a clean initialize response.

### 4. MCP client discovery

Restart the local Hermes/client process after config changes.

Verify the bridge tools appear. For Hermes Agent, look for `mcp_hermes_async_*` tool names on startup or with tool/status inspection.

### 5. PONG task

Submit a small task:

```text
Reply with the word PONG and nothing else.
```

Then poll with the Phase 3 contract:

- initial sleep: 30s
- interval: 120s
- max wait: 600s
- call `hermes_result` exactly once after terminal status

Expected final result text: `PONG`.

### 6. Evidence and cost tools

For the completed task/session, verify:

- `hermes_result` includes a `cost` field (may be null only if state.db lookup did not find the session)
- `hermes_transcript(session_id)` returns T2 JSONL/path/body
- `hermes_decompose(session_id, original_prompt)` returns `AtomicClaim[]`
- `hermes_task_cost(task_id)` returns latest snapshot or explicit null with reason to debug

## Important constraints

- The main machine must not run the bridge script locally.
- Do not reintroduce `supergateway` for this bridge.
- Do not bind the server to `0.0.0.0`.
- Do not put the token in committed docs, PR bodies, screenshots, or logs.
- Tailscale route is preferred. LAN `10.x.x.x` is not the deployed bind right now.
- `/healthz` can be unauthenticated; it does not prove MCP tool auth. Only the no-token `/mcp` negative test proves auth enforcement.

## Troubleshooting

- Connection refused: check Tailscale connectivity to `100.x.x.x` and that launchd is listening on Mac mini.
- 401/403 with token: verify local token matches the bridge operator's `HERMES_ASYNC_BRIDGE_TOKEN` and the operator secret value.
- Tools absent after config: restart Hermes; MCP discovery happens at startup.
- HTTP transport unsupported: upgrade/install Python `mcp` package for the client Hermes environment.
- Result never completes: use `hermes_status`, then check Mac mini logs:
  - `<supervisor-log-destination>`
  - `~/Library/Logs/hermes-async-bridge.err.log`

## Report back format

When done, report:

```text
STATUS: PASS|FAIL
Endpoint: http://100.x.x.x:8081/mcp
Negative auth: <HTTP status>
Positive auth: <HTTP status / initialized?>
Discovered tools: <count + key names>
PONG task: <task_id> <status> <session_id>
Evidence: transcript=<yes/no> decompose=<yes/no> cost=<yes/no/null>
Blockers: <none or exact blocker>
```
