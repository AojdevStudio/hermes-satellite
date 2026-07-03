# Hermes Satellite

Remote Hermes execution and satellite verification over authenticated MCP.

Hermes Satellite turns a Mac mini running Hermes Agent into a shared, authenticated remote executor. MCP-capable clients on other machines submit work to Hermes, poll for terminal status, fetch transcript evidence, decompose claims, and send corrective follow-ups through the same Hermes session.

## What is here

- `apps/hermes-async-bridge/` — native Python Streamable HTTP MCP bridge for Hermes Agent.
- `apps/verifier/hermes/` — TypeScript client, polling, transcript, and decomposition modules.
- `.pi/verifier/agents/hermes-dispatch.md` — Pi persona for scoped dispatch to Hermes.
- `.pi/verifier/agents/satellite-verifier.md` — verifier persona for evidence-based remote verification.
- `specs/hermes-satellite-verify.md` — implementation plan and evidence/cost model.
- `hermes-mcp.md` — current Mac mini bridge architecture and operational state.
- `specs/hermes-mcp-main-machine-install.md` — handoff for installing the client config on another machine.

## Example deployment

A typical bridge runs as native FastMCP over Streamable HTTP on a dedicated host (often a Mac mini on Tailscale):

- MCP URL: `http://100.x.x.x:8081/mcp` (replace with your bridge host's Tailscale or LAN IP)
- Health URL: `http://100.x.x.x:8081/healthz`
- Auth: `Authorization: Bearer <HERMES_MCP_TOKEN>`
- launchd wrapper: `~/.hermes/scripts/run_hermes_async_bridge.sh`

Auth should be verified from a **separate** tailnet node (not from the bridge host itself):

- no-token MCP initialize → HTTP 401
- bearer-token MCP initialize → HTTP 200

Operational quirk: the bridge host often cannot reliably curl its own Tailscale IP. Smoke-test from another tailnet node.

## Quick start for a client machine

1. Put the bearer token in the client machine's private environment as `HERMES_MCP_TOKEN`.
2. Configure the MCP client as a remote URL server, not a local command:

```yaml
mcp_servers:
  hermes_async:
    url: "http://100.x.x.x:8081/mcp"
    headers:
      Authorization: "Bearer ${HERMES_MCP_TOKEN}"
    timeout: 180
    connect_timeout: 60
```

3. Restart the client so MCP discovery runs.
4. Confirm the bridge tools appear with the client-specific prefix, for example `mcp_hermes_async_hermes_submit` in Hermes Agent.
5. Run the negative and positive auth checks from `specs/hermes-mcp-main-machine-install.md`.

## Local development

Install verifier dependencies:

```bash
cd apps/verifier
pnpm install
```

Useful recipes:

```bash
just                    # list recipes
just typecheck          # TypeScript no-emit check
just test               # compile and run Hermes decomposition tests
just bridge-check       # Python syntax/import-level bridge checks
just hermes-dispatch    # start Pi dispatch persona with Hermes MCP tooling
```

## Bridge runtime

The bridge script defaults are intentionally conservative:

- refuses `0.0.0.0` for HTTP transport
- requires `HERMES_ASYNC_BRIDGE_TOKEN` unless running stdio/test mode
- stores task state in `$HERMES_HOME/async_bridge.db`
- reads Hermes transcript/cost data from `$HERMES_HOME/state.db`
- records MCP/task/cost audit rows in SQLite

See `apps/hermes-async-bridge/README.md` for deployment details.

## Verification model

The satellite verifier does not trust final prose alone. The intended verification flow is:

1. `hermes_submit` a structured prompt with a `## Acceptance` section.
2. Poll using the contract in `hermes-polling.md`.
3. Fetch T2 evidence with `hermes_transcript(session_id)`.
4. Decompose the transcript with `hermes_decompose` into `AtomicClaim[]`.
5. Oracle each claim and report confidence.
6. Use `hermes_respond` for corrective follow-ups until verified or max loops are exhausted.

Cost visibility is part of the contract. `hermes_result` and `hermes_task_cost` surface `TaskCostSnapshot` data from Hermes `state.db`; MoA rows with unreconciled local cost are reported as unknown/unreconciled, not free.

## Legacy Pi verifier

This repo still contains the original local Pi verifier harness (`just verifier`) because Hermes Satellite grew from that architecture. The new product direction is the remote Hermes bridge plus satellite verification loop; README/images/docs from the old upstream project have been removed or are being rewritten around that direction.

## License

MIT — see `LICENSE`.
