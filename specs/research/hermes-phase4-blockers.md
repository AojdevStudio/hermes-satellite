# Hermes Phase 4 verification blockers research

Date: 2026-07-01

## Executive verdict

| Question | Verdict | Recommendation |
|---|---|---|
| 1. Native HTTP MCP + bearer auth in Python | **Unblock; runtime bridge still exposed** | Use native Streamable HTTP. Mac mini runtime evidence shows the active bridge is still `supergateway` on `0.0.0.0:8081`, wrapping stdio `mcp` 1.26.0 with no `fastmcp` package and no bearer auth; `/healthz` returns `ok`. The installed `FastMCP` signature already accepts `token_verifier`, `auth`, host, port, and `streamable_http_path`; a local compile/instantiation test confirms a static bearer verifier works on `mcp 1.26.0`. The smallest fix is to delete `supergateway` and run native Streamable HTTP with SDK auth. |
| 2. Real Hermes MoA/delegation tool names + pricing source | **Unblocked with caveat** | Real Mac mini evidence confirms delegation uses `delegate_task`. A true MoA session export was found (`20260630_081522_c6e18380`): session metadata marks `billing_provider=moa`, `billing_base_url=moa://local`, but the exported messages contain normal tool rows and no `moa.reference` / `moa.aggregating` events. Cost is a blind spot: the virtual MoA session has `estimated_cost_usd=0.0`, `cost_source=none`, so Phase 4 must not trust the parent MoA row for spend. |
| 3. Hermes structured-output feasibility | **Decision needed; normal chat path not proven** | Treat `structured_assistant_claim` as **candidate-only**. Mac mini source/runtime evidence shows `hermes chat --help` exposes no schema/JSON mode flag, and the OpenAI-compatible API server calls `_run_agent(...)` without forwarding `response_format`/`output_config`. Hermes `plugin_llm.complete_structured()` can do schema calls, but that is a host/plugin helper path, not the normal Hermes final-response path. |

---

## 1. Native HTTP MCP + bearer auth in Python

### Findings

- Official MCP Python SDK v1.x is the stable production line. Its README says v1.x is recommended for production and supports stdio, SSE, and Streamable HTTP. It shows `mcp.run(transport="streamable-http")` with `mcp.server.fastmcp.FastMCP`.
- Official MCP Python SDK v1.x authorization docs show server-side bearer/OAuth resource-server auth by passing `token_verifier=SimpleTokenVerifier()` and `auth=AuthSettings(...)` into `FastMCP`, then running `mcp.run(transport="streamable-http")`.
- Official MCP Python SDK v2 docs expose `streamable_http_app(..., auth=..., token_verifier=..., auth_server_provider=...)`, but the GitHub README warns v2 is pre-release and not production-stable yet.
- Separate `fastmcp` 2.x docs support direct HTTP (`mcp.run(transport="http")`) or ASGI (`app = mcp.http_app()`), `StaticTokenVerifier`, JWT/JWKS verifiers, introspection verifiers, and custom Starlette middleware. Its client docs show `Client(url, auth="token")` and `StreamableHttpTransport(..., auth="token")` sending `Authorization: Bearer <token>`.

- Mac mini runtime evidence confirms the current active async bridge has not yet taken that path. Evidence artifact: `specs/research/artifacts/macmini-async-bridge-runtime-evidence.txt`.
  - `~/Library/LaunchAgents/com.aojdevstudio.hermes-async-bridge.plist` runs `npx -y supergateway --stdio /Users/aojdevstudio/.hermes/scripts/hermes_async_bridge.py --port 8081 --host 0.0.0.0 --outputTransport streamableHttp --healthEndpoint /healthz`.
  - The bridge process is live and `/healthz` returns `ok`.
  - The Hermes venv has `mcp 1.26.0`, `fastmcp` missing, and `FastMCP(...)` already exposes `token_verifier`, `auth`, `host`, `port`, and `streamable_http_path` parameters.
  - The bridge submits privileged work by spawning `hermes chat -q <prompt> -Q --yolo --pass-session-id --source tool`; the docs explicitly say “No authentication — relies on network-level isolation”. That makes tool auth mandatory before broad remote exposure.
- Mac mini SDK API introspection confirms the exact official-SDK migration imports and protocol. Evidence artifact: `specs/research/artifacts/macmini-mcp126-auth-api-evidence.txt`.
  - `mcp.server.auth.provider.TokenVerifier` is a protocol with `async def verify_token(self, token: str) -> AccessToken | None`.
  - `mcp.server.auth.provider.AccessToken` accepts `token`, `client_id`, `scopes`, optional `expires_at`, and optional `resource`.
  - `mcp.server.auth.settings.AuthSettings` requires `issuer_url` and `resource_server_url`, with optional `required_scopes`.
  - `FastMCP.run(transport="streamable-http")` dispatches to `run_streamable_http_async`; host/port/path are constructor settings, not `run()` arguments.
  - A `StaticBearerVerifier` instantiation test succeeded with `FastMCP(... token_verifier=StaticBearerVerifier("redacted"), auth=AuthSettings(...), host="127.0.0.1", port=8081, streamable_http_path="/mcp")`.


### Auth placement

Use SDK auth, not ad hoc middleware, when staying on official MCP Python SDK:

```py
mcp = FastMCP(
    "Hermes Async Bridge",
    token_verifier=HermesTokenVerifier(),
    auth=AuthSettings(...),
)
mcp.run(transport="streamable-http", host="100.66.249.14", port=8081)
```

If using separate `fastmcp` 2.x:

```py
auth = StaticTokenVerifier(tokens={token: {"sub": "obi", "client_id": "obi"}})
mcp = FastMCP("Hermes Async Bridge", auth=auth)
app = mcp.http_app()
```


### Minimal verified official-SDK patch shape

The live Mac mini package is enough for a small patch without switching libraries:

```py
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP

class StaticBearerVerifier:
    def __init__(self, token: str):
        self.token = token

    async def verify_token(self, token: str) -> AccessToken | None:
        if token != self.token:
            return None
        return AccessToken(token=token, client_id="hermes-bridge", scopes=["hermes:submit"])

mcp = FastMCP(
    "hermes-async",
    instructions=...,  # keep existing tool instructions
    host="100.66.249.14",  # or 10.69.1.100; avoid 0.0.0.0 by default
    port=8081,
    streamable_http_path="/mcp",
    token_verifier=StaticBearerVerifier(os.environ["HERMES_ASYNC_BRIDGE_TOKEN"]),
    auth=AuthSettings(
        issuer_url="https://hermes.local",
        resource_server_url="http://100.66.249.14:8081",
        required_scopes=["hermes:submit"],
    ),
)
# register the existing hermes_submit/status/result/respond/cancel/list/sessions tools
mcp.run(transport="streamable-http")
```

This patch shape is intentionally smaller than adding OAuth/JWT first: it closes unauthenticated LAN submit while preserving the existing task manager and SQLite store. OAuth/JWT can replace the verifier later without changing `hermes_decompose` fixtures.

### Smallest safe Phase 4 migration path

1. Keep the official SDK already installed (`mcp 1.26.0`) if it is otherwise compatible; its live `FastMCP` signature already has `token_verifier` and `auth`. Pin `mcp>=1.26,<2` or upgrade within v1.x only if the chosen verifier class requires it.
2. Remove `supergateway`; run the existing bridge as a native Streamable HTTP MCP server.
3. Bind only to Tailscale/LAN (`100.66.249.14` or `10.69.1.100`), not blind `0.0.0.0` unless firewall/reverse proxy is already enforced.
4. Add bearer token verification before enabling remote `hermes_submit`; this matters because bridge tasks run `hermes chat ... --yolo --source tool`.
5. Add one unauthenticated `/healthz` only if needed; remember FastMCP custom routes may be intentionally unauthenticated.
6. Keep TLS optional only on Tailscale/private LAN; require TLS at any public/Traefik edge.

### Smallest spec correction

Replace “Auth required; bearer auth before any remote submit” with:

```md
Phase 4 transport/auth: the Mac mini bridge MUST run native Streamable HTTP MCP, not `supergateway` wrapping stdio. Runtime evidence shows the active bridge currently listens on `0.0.0.0:8081`, has no auth, and launches privileged `hermes chat ... --yolo --source tool` tasks. If it keeps the official `mcp` Python SDK, use `mcp.server.fastmcp.FastMCP(..., token_verifier=..., auth=AuthSettings(...), host=..., port=..., streamable_http_path="/mcp")`; the observed `mcp 1.26.0` signature already supports those parameters, and Mac mini instantiation evidence confirms the exact import paths `mcp.server.auth.provider.{AccessToken, TokenVerifier}` plus `mcp.server.auth.settings.AuthSettings`. Pin `mcp>=1.26,<2` unless a verifier requires a newer v1.x. Do not read bearer tokens through module globals or tool arguments. If switching to `fastmcp` 2.x, use its `StaticTokenVerifier`/JWT verifier and `http_app()`/`run(transport="http")`. Bind to Tailscale/LAN; expose public only behind TLS. Health/custom routes are not proof that MCP auth protects tools.
```

---

## 2. Real Hermes MoA/delegation tool names + pricing source

### Findings

- Local Hermes source registers the delegation tool as exactly `delegate_task` in `~/.hermes/hermes-agent/tools/delegate_tool.py` (`DELEGATE_TASK_SCHEMA = {"name": "delegate_task", ...}` and `registry.register(name="delegate_task", ...)`).
- Real Mac mini `~/.hermes/state.db` now confirms the exported/durable delegation names: `tool_calls[].function.name = "delegate_task"` on assistant rows and `tool_name = "delegate_task"` on matching tool result rows. Evidence artifact: `specs/research/artifacts/macmini-delegate-task-20260630_142436_667c9b.json`.
- The highest-cost session is `20260630_142436_667c9b`: model `z-ai/glm-5.2`, provider `openrouter`, `input_tokens=16,283,987`, `output_tokens=107,257`, `cache_read_tokens=54,074,158`, `tool_call_count=384`, `estimated_cost_usd=25.20348334`, `cost_source=provider_models_api`. Its direct child lineage total is **28.62754006 USD**. Evidence artifact: `specs/research/artifacts/macmini-delegate-lineage-20260630_142436_667c9b.json`.
- The cost driver in the real expensive session is **context bloat / long-running single-model tool loop**, not MoA: the session and children all use `z-ai/glm-5.2`; delegation children are small relative to the parent. Guardrails should key on cumulative input/cache tokens, tool-call count, duration, and child lineage cost, with `delegate_task` as a secondary fan-out signal.
- Local Hermes source emits MoA display events named `moa.reference` and `moa.aggregating` in `tui_gateway/server.py`; `agent/moa_loop.py` emits those while running reference models and aggregator.
- A true MoA parent session was found and exported from the Mac mini: `20260630_081522_c6e18380`, source `discord`, model `default`, `billing_provider=moa`, `billing_base_url=moa://local`, `input_tokens=790,772`, `output_tokens=35,763`, `cache_read_tokens=3,159,552`, `tool_call_count=51`, `estimated_cost_usd=0.0`, `cost_source=none`. Evidence artifact: `specs/research/artifacts/macmini-moa-export-20260630_081522_c6e18380.jsonl`.
- The MoA export confirms an important transcript limitation: persisted/exported `messages` show normal assistant/tool rows (`terminal`, `search_files`, `execute_code`, `delegate_task`, `vision_analyze`, `skill_view`, `read_file`, `memory`, `web_extract`) and do **not** include `moa.reference` / `moa.aggregating` event rows. Therefore `hermes_decompose` cannot detect MoA from tool names alone; it must inspect session metadata (`billing_provider=moa` or `billing_base_url=moa://local`) and optionally separate live event streams if Phase 4 adds them.
- MoA cost has a current **cost blind spot**: the MoA parent row reports `estimated_cost_usd=0.0` and `cost_source=none` despite large token counters, and its direct child rows are subscription-included `gpt-5.5` subagents. The aggregator/reference provider costs are not recoverable from the exported messages alone. Phase 4 must either fix Hermes MoA accounting upstream or mark MoA parent cost as unknown/unreconciled rather than `$0`.

### Pricing source

- Official OpenRouter API docs say model pricing is in the models API as per-token strings: `pricing.prompt` is cost per input token, `pricing.completion` is cost per output token, and optional fields include fixed `request`, `image`, `web_search`, `internal_reasoning`, `input_cache_read`, and `input_cache_write`.
- Official OpenRouter API docs say response `usage.cost` is “cost in credits”, and token counts use the model’s native tokenizer; generation stats can be queried later by generation id.
- Hermes source uses `OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"`, `fetch_model_metadata()`, and `usage_pricing._openrouter_pricing_entry()` to transform OpenRouter per-token pricing into per-million-token USD-style estimates. The `CostResult` field is `amount_usd`; session DB columns are `estimated_cost_usd`, `actual_cost_usd`, `cost_source`, and `pricing_version`.
- Live OpenRouter `/api/v1/models` sample for relevant models:
  - `anthropic/claude-opus-4.8`: prompt `0.000005`, completion `0.000025`, cache read `0.0000005`, cache write `0.00000625` — dollars/credits per token, equivalent to $5/M input and $25/M output.
  - `anthropic/claude-opus-4.8-fast`: prompt `0.00001`, completion `0.00005` — $10/M input and $50/M output.
  - `anthropic/claude-opus-4.1`: prompt `0.000015`, completion `0.000075` — $15/M input and $75/M output.
  - `z-ai/glm-5.2`: prompt `0.00000093`, completion `0.000003` — $0.93/M input and $3/M output.
  - `openrouter/fusion`: prompt `-1`, completion `-1`; this is router/special pricing, not a normal per-token model price. Treat as unknown unless `usage.cost` or generation stats are captured.

### Captured live artifact and remaining artifact needed

Captured from the Mac mini via SSH:

```bash
ssh macmini 'sqlite3 -json ~/.hermes/state.db "select m.id as message_id, m.session_id, m.role, m.tool_name, m.tool_call_id, m.tool_calls, substr(m.content,1,2000) as content, m.timestamp from messages m where m.session_id=\"20260630_142436_667c9b\" and (m.tool_name=\"delegate_task\" or m.tool_calls like \"%delegate_task%\") order by m.timestamp;"'   > specs/research/artifacts/macmini-delegate-task-20260630_142436_667c9b.json

ssh macmini 'sqlite3 -json ~/.hermes/state.db "select id,parent_session_id,model,billing_provider,billing_base_url,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,tool_call_count,estimated_cost_usd,cost_source,pricing_version from sessions where id=\"20260630_142436_667c9b\" or parent_session_id=\"20260630_142436_667c9b\" order by estimated_cost_usd desc;"'   > specs/research/artifacts/macmini-delegate-lineage-20260630_142436_667c9b.json
```

Captured true MoA parent export from the Mac mini:

```bash
ssh macmini '/Users/aojdevstudio/.local/bin/hermes sessions export /tmp/hermes-20260630_081522_c6e18380.jsonl --session-id 20260630_081522_c6e18380'
ssh macmini 'cat /tmp/hermes-20260630_081522_c6e18380.jsonl'   > specs/research/artifacts/macmini-moa-export-20260630_081522_c6e18380.jsonl
ssh macmini 'sqlite3 -json ~/.hermes/state.db "select id,parent_session_id,source,model,billing_provider,billing_base_url,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,tool_call_count,estimated_cost_usd,cost_source,pricing_version from sessions where id=\"20260630_081522_c6e18380\" or parent_session_id=\"20260630_081522_c6e18380\" order by estimated_cost_usd desc;"'   > specs/research/artifacts/macmini-moa-lineage-20260630_081522_c6e18380.json
```

Remaining artifact needed: if Hermes has a live event/trace sink for `moa.reference` and `moa.aggregating`, capture it for the same session shape. The T2 session export alone does not persist those events.

### Smallest spec correction

```md
Cost/MoA detection MUST NOT rely on guessed tool names. Real Mac mini T2/state.db evidence confirms delegation appears as `delegate_task` in assistant `tool_calls[].function.name` and tool result `tool_name`; treat this as the canonical delegation detector and add `specs/research/artifacts/macmini-delegate-task-20260630_142436_667c9b.json` as the first fixture seed. Real MoA detection MUST use session metadata (`billing_provider=moa` or `billing_base_url=moa://local`); T2 message exports do not persist `moa.reference` / `moa.aggregating` live events. Phase 4 cost MUST read Hermes `sessions.estimated_cost_usd`, `cost_source`, and `pricing_version`, then compute chain cost by summing session lineage once; however, MoA parent rows with `moa://local`, `estimated_cost_usd=0.0`, and `cost_source=none` are a cost blind spot and MUST be reported as `unknown/unreconciled`, not authoritative free spend. Guardrails MUST key primarily on cumulative input/cache tokens, tool-call count, duration, lineage cost, and `billing_provider=moa`; `delegate_task` is a secondary fan-out signal. For OpenRouter estimates, cite `/api/v1/models` pricing as per-token prompt/completion/cache/request pricing. For router models such as `openrouter/fusion` or any price `-1`, use provider `usage.cost`/generation stats or mark cost unknown.
```

---

## 3. Hermes structured-output feasibility

### Findings

- OpenRouter officially supports `response_format: {type:"json_schema", json_schema:{...}}` for compatible models; docs recommend `strict:true` and `require_parameters:true` provider preferences to avoid routing to unsupported providers.
- Anthropic officially supports structured outputs with `output_config.format` and strict tool use on current Claude models, with caveats for refusal, max-token truncation, schema complexity, and incompatibilities.
- Mac mini runtime/source evidence separates three paths. Evidence artifact: `specs/research/artifacts/macmini-structured-output-runtime-source.txt`.
  1. **Normal Hermes CLI chat path:** `hermes chat --help` exposes no `--json`, `--schema`, `--response-format`, or `--output-config` flag. A final `verify_claims` block requested through `hermes chat -q` is prompt-only unless another mechanism is added.
  2. **OpenAI-compatible API server path:** `gateway/platforms/api_server.py` calls `_run_agent(user_message=..., conversation_history=..., ephemeral_system_prompt=..., session_id=...)` and the idempotency fingerprint includes only `model`, `messages`, `tools`, `tool_choice`, and `stream`; the source excerpt does not forward `response_format`, `output_config`, or `text.format` into `_run_agent`. Therefore API clients cannot currently prove final-answer schema enforcement through this path from T2 alone.
  3. **Plugin/host helper path:** `agent/plugin_llm.py` has `complete_structured(..., json_schema=..., json_mode=...)`; it builds `extra_body.response_format` with `type:"json_schema"`, adds a JSON-only system instruction, parses JSON, and validates with `jsonschema` when installed. This proves host-owned structured calls are feasible, but not that normal Hermes final responses are constrained.
- Prompt-only “emit a `verify_claims` JSON block” is useful but not reliable enough to be canonical. Valid JSON can still be unsupported by evidence and can be spoofed by the assistant.

### Recommendation

Treat structured assistant claims as **candidate-only** in the spec today:

- Canonical claims: deterministic `tool_execution`, `user_requirement`, and `artifact_delta` from T2 export.
- Candidate claims: schema-valid `verify_claims` blocks from final assistant output, unless the transcript proves they were produced by a forced schema mechanism (`response_format`, strict tool, dedicated `verify_claims` tool call, or a bridge-owned `plugin_llm.complete_structured` invocation recorded as such).
- Unavailable/cap lowered: prompt-only JSON without forced schema or evidence IDs.
- Smallest safe migration: do **not** ask normal Hermes final prose to be canonical JSON. Add `verify_claims` as either (a) a real Hermes tool/function whose call appears in T2, or (b) a bridge-side structured extraction pass using `plugin_llm.complete_structured` after T2 export, with the mechanism recorded on every `structured_assistant_claim`.

### Smallest spec correction

```md
`structured_assistant_claim` is candidate-only unless the T2 transcript or bridge audit row proves Hermes produced it through a constrained mechanism: provider `response_format`/`output_config.format`, strict tool use, a dedicated `verify_claims` tool/function call, or a bridge-owned `plugin_llm.complete_structured` call. Normal `hermes chat -q` / `hermes_submit` final prose is prompt-only today: the CLI exposes no schema flag and the API server source inspected on the Mac mini does not forward `response_format`/`output_config` into `_run_agent`. A prompt-only JSON block may be parsed and schema-validated, but it is NOT canonical and may not satisfy user-requirement completeness or PERFECT. The bridge MUST record `structuredOutputMechanism`; absent that field, classify as `assistant_assertion` or candidate `structured_assistant_claim` with cap <= 0.55.
```

---

## Evidence table

| Area | Evidence | Source/command | Confidence |
|---|---|---|---|
| MCP SDK production line | v1.x stable, v2 pre-release; v1 supports Streamable HTTP | `https://github.com/modelcontextprotocol/python-sdk`, `https://raw.githubusercontent.com/modelcontextprotocol/python-sdk/v1.x/README.md` | High |
| MCP bearer auth in official SDK | `FastMCP(... token_verifier=..., auth=AuthSettings(...)); mcp.run(transport="streamable-http")` | `https://raw.githubusercontent.com/modelcontextprotocol/python-sdk/v1.x/docs/authorization.md` | High |
| SDK v2 auth shape | `streamable_http_app(... auth=..., token_verifier=...)`, but pre-release | `https://py.sdk.modelcontextprotocol.io/v2/api/mcp/server/` | Medium: current docs but not production stable |
| FastMCP 2 HTTP/auth | Direct HTTP, ASGI app, `StaticTokenVerifier`, JWT/introspection verifiers, client bearer auth | `https://gofastmcp.com/deployment/http`, `https://gofastmcp.com/servers/auth/token-verification`, `https://gofastmcp.com/clients/auth/bearer` | High for separate `fastmcp` library |
| Current bridge runtime gap | Active Mac mini launchd service runs `supergateway --stdio ... --host 0.0.0.0 --port 8081`; `/healthz` is live; bridge docs say no auth; tasks spawn `hermes chat ... --yolo --source tool`; venv has `mcp 1.26.0`, no separate `fastmcp`, and `FastMCP` supports `token_verifier`/`auth` | `specs/research/artifacts/macmini-async-bridge-runtime-evidence.txt`; `ssh macmini plutil -p ~/Library/LaunchAgents/com.aojdevstudio.hermes-async-bridge.plist`; `ssh macmini curl http://127.0.0.1:8081/healthz` | High for current runtime |
| MCP 1.26 auth patch feasibility | `TokenVerifier.verify_token(token)->AccessToken|None`; `AuthSettings(issuer_url, resource_server_url, required_scopes=...)`; `FastMCP.run(transport="streamable-http")`; static bearer verifier instantiation succeeds on Mac mini | `specs/research/artifacts/macmini-mcp126-auth-api-evidence.txt`; `ssh macmini ~/.hermes/hermes-agent/venv/bin/python3 ... inspect.signature(FastMCP)` | High for minimal official-SDK patch shape |
| Delegation tool source name | `DELEGATE_TASK_SCHEMA["name"] == "delegate_task"`; `registry.register(name="delegate_task")` | `/Users/ossieirondi/.hermes/hermes-agent/tools/delegate_tool.py` | High for source-defined tool name |
| MoA live event names | `moa.reference` and `moa.aggregating` emitted by Hermes UI path | `/Users/ossieirondi/.hermes/hermes-agent/tui_gateway/server.py`, `/Users/ossieirondi/.hermes/hermes-agent/agent/moa_loop.py` | High for UI events, not transcript export names |
| Real Mac mini delegation export evidence | Session `20260630_142436_667c9b` has assistant `tool_calls[].function.name="delegate_task"` and tool result `tool_name="delegate_task"`; lineage total cost `28.62754006` USD | `ssh macmini sqlite3 ~/.hermes/state.db ...`; `specs/research/artifacts/macmini-delegate-task-20260630_142436_667c9b.json`; `specs/research/artifacts/macmini-delegate-lineage-20260630_142436_667c9b.json` | High |
| Real Mac mini MoA export evidence | Session `20260630_081522_c6e18380` has `billing_provider=moa`, `billing_base_url=moa://local`; exported messages contain normal tool rows and no persisted `moa.reference`/`moa.aggregating`; parent cost is `estimated_cost_usd=0.0`, `cost_source=none` despite large tokens | `hermes sessions export ... --session-id 20260630_081522_c6e18380`; `specs/research/artifacts/macmini-moa-export-20260630_081522_c6e18380.jsonl`; `specs/research/artifacts/macmini-moa-lineage-20260630_081522_c6e18380.json` | High |
| OpenRouter pricing semantics | `pricing.prompt` input token, `pricing.completion` output token, optional request/image/cache/etc.; usage has token counts and cost | `https://openrouter.ai/docs/api/reference/overview`, `https://openrouter.ai/docs/guides/overview/models`, `https://openrouter.ai/api/v1/models` | High |
| Hermes OpenRouter pricing path | Fetches `https://openrouter.ai/api/v1/models`; converts per-token to per-million; returns `amount_usd` estimates | `/Users/ossieirondi/.hermes/hermes-agent/hermes_constants.py`, `agent/model_metadata.py`, `agent/usage_pricing.py` | High for local Hermes source |
| OpenRouter structured outputs | `response_format` JSON schema, compatible models only, use `require_parameters:true` | `https://openrouter.ai/docs/guides/features/structured-outputs` | High |
| Anthropic structured outputs | `output_config.format`, strict tool use, constrained decoding; refusal/max-token caveats | `https://platform.claude.com/docs/en/build-with-claude/structured-outputs` | High |
| Hermes structured helper | `plugin_llm.complete_structured()` passes `extra_body.response_format`, parses and validates JSON | `/Users/ossieirondi/.hermes/hermes-agent/agent/plugin_llm.py`; `specs/research/artifacts/macmini-structured-output-runtime-source.txt` | Medium: plugin path only |
| Normal Hermes final-response schema | Not proven for `hermes chat -q` / MCP bridge final answer; `hermes chat --help` exposes no schema flag and API server source excerpt does not forward `response_format`/`output_config` into `_run_agent` | `ssh macmini hermes chat --help`; `/Users/aojdevstudio/.hermes/hermes-agent/gateway/platforms/api_server.py`; `specs/research/artifacts/macmini-structured-output-runtime-source.txt` | High for current inspected runtime/source |

---

## Remaining decisions vs research facts

### Research facts

- Native Streamable HTTP MCP is supported in Python.
- The current live Mac mini async bridge still uses `supergateway` + stdio on `0.0.0.0:8081` with no auth, even though installed `mcp 1.26.0` already exposes `FastMCP(token_verifier=..., auth=...)`; a static bearer verifier instantiation test works with `AccessToken` and `AuthSettings`.
- Bearer auth should be handled by SDK token verification/auth providers, not a global header hack.
- `delegate_task` is both the source-defined and real Mac mini durable transcript delegation tool name.
- MoA source emits live UI events `moa.reference` and `moa.aggregating`; a true MoA parent export was found, but those live events are not persisted in T2 messages. MoA detection in T2 must use session metadata (`billing_provider=moa`, `billing_base_url=moa://local`).
- OpenRouter model pricing is per token for prompt/completion/cache plus optional per-request/tool dimensions; Hermes stores USD estimates in `sessions.estimated_cost_usd`. The observed expensive delegation lineage totals `28.62754006` USD and is driven primarily by context bloat, cache reads, tool-call count, and duration rather than MoA. The observed MoA parent row is a cost blind spot because it reports `estimated_cost_usd=0.0` with `cost_source=none`.
- Provider structured outputs exist, and Hermes has a plugin structured-output helper, but normal Hermes chat/bridge final-output enforcement is not proven and currently lacks visible CLI/API forwarding hooks in the inspected Mac mini source.

### Remaining decisions

1. Stay on official MCP Python SDK v1.x with `TokenVerifier` and remove `supergateway`, or switch the bridge to separate `fastmcp` 2.x for simpler static token/JWT auth.
2. Whether Phase 4 accepts static bearer tokens on Tailscale or requires OAuth/JWT issuer/audience validation.
3. Whether Phase 4 should fix Hermes MoA accounting upstream or merely mark MoA virtual rows as unknown/unreconciled.
4. Whether `verify_claims` should be a real forced tool/function call in Hermes or a bridge-side `plugin_llm.complete_structured` post-pass; optional prompt output should not be canonical.
5. Whether router models like `openrouter/fusion` are allowed before `usage.cost`/generation-stat capture is wired.

## Commands run

```bash
rg -n "delegate_task|MoA|mixture|OpenRouter|estimated_cost_usd|cost_source|verify_claims|structured_output|response_format|json_schema" -S . ~/.hermes/hermes-agent
sqlite3 ~/.hermes/state.db ".schema sessions"
sqlite3 ~/.hermes/state.db ".schema messages"
sqlite3 ~/.hermes/state.db 'select json_extract(j.value,"$.function.name") ... from messages, json_each(messages.tool_calls) j ...'
ssh macmini 'sqlite3 -header -column ~/.hermes/state.db "select json_extract(j.value,"$.function.name") as name, count(*) n from messages, json_each(messages.tool_calls) j where messages.tool_calls is not null group by name having name like "%delegate%" or name like "%moa%" order by n desc;"'
ssh macmini 'sqlite3 -json ~/.hermes/state.db "select ... from messages where session_id="20260630_142436_667c9b" and (tool_name="delegate_task" or tool_calls like "%delegate_task%")"' > specs/research/artifacts/macmini-delegate-task-20260630_142436_667c9b.json
ssh macmini 'sqlite3 -json ~/.hermes/state.db "select ... from sessions where id="20260630_142436_667c9b" or parent_session_id="20260630_142436_667c9b""' > specs/research/artifacts/macmini-delegate-lineage-20260630_142436_667c9b.json
ssh macmini 'plutil -p ~/Library/LaunchAgents/com.aojdevstudio.hermes-async-bridge.plist; curl -fsS http://127.0.0.1:8081/healthz; ~/.hermes/hermes-agent/venv/bin/python3 - <<"PY"
from mcp.server.fastmcp import FastMCP
import inspect, importlib.metadata as md
print(md.version("mcp"))
print(inspect.signature(FastMCP))
PY' > specs/research/artifacts/macmini-async-bridge-runtime-evidence.txt
ssh macmini '~/.hermes/hermes-agent/venv/bin/python3 - <<"PY"
from mcp.server.fastmcp import FastMCP
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
class StaticBearerVerifier:
    async def verify_token(self, token: str):
        return AccessToken(token=token, client_id="hermes-bridge", scopes=["hermes:submit"]) if token == "redacted" else None
mcp = FastMCP("hermes-async", host="127.0.0.1", port=8081, streamable_http_path="/mcp", token_verifier=StaticBearerVerifier(), auth=AuthSettings(issuer_url="https://hermes.local", resource_server_url="http://127.0.0.1:8081", required_scopes=["hermes:submit"]))
print("OK", mcp.settings.host, mcp.settings.port, mcp.settings.streamable_http_path)
PY' > specs/research/artifacts/macmini-mcp126-auth-api-evidence.txt
python3 - <<'PY'
import json, urllib.request
url='https://openrouter.ai/api/v1/models'
data=json.load(urllib.request.urlopen(url, timeout=20))['data']
for m in data:
    if 'opus' in m['id'].lower() or m['id'] in ('z-ai/glm-5.2','openrouter/fusion'):
        print(m['id'], m['pricing'], m.get('supported_parameters'))
PY
```
