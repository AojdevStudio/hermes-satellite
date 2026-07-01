# Hermes MCP bridge — architecture and gaps

The custom MCP bridge lives mostly under your Hermes home, not in the homelab repo. It is documented reasonably well as a Hermes skill plus a standalone doc, but the current implementation is still “prototype/service” quality for observability and the closed-loop verification flow we want next.

---

## Documentation

The custom Hermes MCP bridge script:

```text
/Users/<user>/.hermes/scripts/hermes_async_bridge.py
```

It is currently running via:

```bash
/Users/<user>/.hermes/hermes-agent/venv/bin/python3 \
  /Users/<user>/.hermes/scripts/hermes_async_bridge.py
```

The HTTP bridge is exposed through **supergateway** on **port 8081** (`http://<bridge-host>:8081/mcp`).

Standalone doc (on the Mac mini): `/Users/<user>/.hermes/docs/hermes-async-bridge.md`

Related: [`hermes-polling.md`](./hermes-polling.md) — client-side poll algorithm after `hermes_submit`.

---

## Filesystem / important paths

| Role | Path |
|------|------|
| Active MCP server script | `/Users/<user>/.hermes/scripts/hermes_async_bridge.py` |
| Python interpreter (runtime) | `/Users/<user>/.hermes/hermes-agent/venv/bin/python3` |
| SQLite task DB | `/Users/<user>/.hermes/async_bridge.db` |
| launchd service | `/Users/<user>/Library/LaunchAgents/<launchd-label>.plist` |
| Service logs | `/Users/<user>/Library/Logs/hermes-async-bridge.log` |
| Service error log | `/Users/<user>/Library/Logs/hermes-async-bridge.err.log` |
| Documentation | `/Users/<user>/.hermes/docs/hermes-async-bridge.md` |
| Hermes skill docs | `/Users/<user>/.hermes/skills/autonomous-ai-agents/hermes-mcp-bridge/SKILL.md` |
| Skill architecture ref | `/Users/<user>/.hermes/skills/autonomous-ai-agents/hermes-mcp-bridge/references/async-bridge-architecture.md` |
| Skill’s copy of the script | `/Users/<user>/.hermes/skills/autonomous-ai-agents/hermes-mcp-bridge/scripts/hermes_async_bridge.py` |

**Note:** The active script and skill-copy script are not byte-identical right now.

---

## Target architecture (client/server-agnostic)

The pattern is generic. The **Mac mini runs the MCP server**; **any MCP-capable coding agent** on any machine is the client.

### Generic topology

```text
[Any MCP client]
  Cursor, Claude Code, Codex, Pi, custom agent, etc.
  [Any machine — MacBook, laptop, CI runner, …]
        │
        │  MCP over Streamable HTTP (or SSE)
        │  + auth on every request
        │
        ▼
[Mac mini — MCP server]
  hermes_async_bridge.py (native HTTP — target state)
        │
        ├── SQLite task state
        └── subprocess: hermes chat …
```

The client doesn’t matter as long as it speaks **remote MCP** (Streamable HTTP is the current standard). Configure it with a **URL + headers**, not a local command.

### What the client needs

| Requirement | Example |
|-------------|---------|
| Remote MCP support | URL-based server config |
| Network path to Mac mini | Tailscale `<bridge-host>`, or LAN `<bridge-host>` when home |
| Shared secret | `Authorization: Bearer …` (or mTLS) |

Conceptual config (exact shape varies by client):

```json
{
  "url": "http://<bridge-host>:8081/mcp",
  "headers": {
    "Authorization": "Bearer <token>"
  }
}
```

Same server, many possible clients — each gets the same URL and token (or per-client tokens if we add that later).

### What the Mac mini server should be

| Layer | Choice |
|-------|--------|
| Transport | **Native HTTP MCP** (StreamableHTTP) in Python |
| Process model | One long-lived **launchd** service |
| Bind address | Tailscale IP and/or LAN IP — **not** blind `0.0.0.0` unless firewalled |
| Middle layers | **None** — drop supergateway and stdio |
| Application API | Keep async tools: `submit`, `status`, `result`, `respond`, `cancel`, … |
| Security | Auth required; TLS optional on Tailscale, required if exposed via Traefik/public edge |

The server is **client-agnostic by design**: it exposes standard MCP tools over HTTP. It doesn’t care whether the caller is Cursor or something else.

### What does *not* apply here

| Pattern | Why it doesn’t fit |
|---------|-------------------|
| **Unix domain sockets** | Only for clients on the **same machine** as the server. The AFK Mac mini is the server; clients are elsewhere → **network HTTP**. |
| **stdio MCP** | For when the **client spawns** the server as a child process (typical local IDE setup). Wrong model when the server lives on a headless box. |

### Robust stack (target)

```text
Any MCP client  →  HTTP MCP + auth  →  Mac mini MCP server  →  Hermes subprocess + SQLite
```

That’s the right replacement for supergateway + stdio: **one protocol, one server, many possible clients**, with auth at the boundary because the server can run arbitrary Hermes work.

---

## Current implementation (today)

| Layer | Detail |
|-------|--------|
| Python MCP SDK | `mcp.server.fastmcp.FastMCP` |
| Transport | stdio MCP only (inside the Python process) |
| HTTP bridge | **supergateway** wraps stdio and exposes StreamableHTTP |
| Active endpoint | `http://<bridge-host>:8081/mcp` |
| Health endpoint | `http://<bridge-host>:8081/healthz` |
| Auth | **Not implemented yet** |

**launchd command (today):**

```bash
/Users/<user>/.volta/bin/npx -y supergateway \
  --stdio /Users/<user>/.hermes/scripts/hermes_async_bridge.py \
  --port 8081 \
  --host 0.0.0.0 \
  --outputTransport streamableHttp \
  --healthEndpoint /healthz \
  --logLevel info
```

**Gap vs target:** supergateway + stdio + `0.0.0.0` + no auth. Migrate to native HTTP MCP in Python and bind to Tailscale/LAN with bearer auth.

---

## Scoped dispatch (what it means)

**Scoped dispatch is role separation, not Hermes tool lockdown.**

The dispatch agent (Claude Code, Codex, Pi — whichever is the MCP client) should:

1. **Craft structured prompts** that give Hermes everything it needs to finish the job on the Mac mini.
2. **Not attempt to do the work locally** — no parallel “I’ll just edit this file here while Hermes also runs.”
3. **Switch to satellite verifier on return** — the MCP client (not Hermes) wears persona `satellite-verifier.md`; decompose Hermes’s claims, check evidence, send corrective prompts via `hermes_respond`.

Hermes keeps full capability (MoA, delegation, skills, etc.). The dispatch agent’s job is to be **explicit in the prompt** when expensive modes are intended. A vague “use mixture of experts” prompt that burns $47 in tokens is a dispatch/prompting failure, not a reason to block MoA at the bridge by default.

We may still add **observability and optional cost guardrails** later (token capture, budget caps, preflight warnings). Those are operational safety nets — not the definition of scoped dispatch.

---

## Target closed loop (dispatch → execute → verify → correct)

Today the bridge is mostly one-way: client submits, client polls, client reads result. See [`hermes-polling.md`](./hermes-polling.md) for the client-side poll algorithm (30s initial, 120s interval, 600s cap).

**Evidence gap:** `hermes_result` is final text only. Hermes’s canonical transcript lives in **`~/.hermes/state.db`**, not in `async_bridge.db`. The **satellite verifier** (MCP client, not Hermes) needs **T2 export** (`hermes sessions export`) or **`hermes_transcript`** — see [`specs/hermes-satellite-verify.md`](./specs/hermes-satellite-verify.md#evidence-model-critical).

The target flow adds a **return path** so verification is not “poll until done, trust the paragraph”:

```text
[Dispatch agent — MCP client]
  hermes_submit(structured prompt)
        │
        ▼
[Mac mini MCP server → Hermes subprocess]
  executes; writes artifacts + task state
        │
        │  on terminal status (completed/failed)
        ▼
[Callback / wake satellite verifier]
  same MCP client that dispatched (Obi / Codex / Pi) notified
        │
        ▼
[Satellite verifier — satellite-verifier.md]
  hermes_decompose → oracle claims → ## Report
        │
        ├── all verified → report done to user
        │
        └── failures → hermes_respond(corrective prompt)
                │
                ▼
            Hermes fixes → callback again → loop until verified or escalate
```

Polling stays as the **client-side safety net** (status checks while Hermes runs). The **callback/wake** is what closes the loop without the dispatch agent sitting in a blocking poll forever or missing completion.

---

## Tools exposed to MCP clients

- `hermes_submit`
- `hermes_status`
- `hermes_result`
- `hermes_respond`
- `hermes_cancel`
- `hermes_list`
- `hermes_sessions`
- `hermes_transcript` *(planned — export session from `state.db`)*
- `hermes_decompose` *(planned — T2 export → AtomicClaim[] JSON for verify checklist)*
- `hermes_task_cost` *(planned — token/model/USD snapshot per task + respond loop)*

---

## What each submit does

Client calls `hermes_submit(prompt, caller)`. The bridge stores the prompt in SQLite, then spawns:

```bash
hermes chat -q <prompt> -Q --yolo --pass-session-id --source tool
```

For follow-ups:

```bash
hermes chat -q <prompt> -Q --yolo --pass-session-id --source tool --resume <session_id>
```

`hermes_respond` is the hook for the verification loop — corrective prompts resume the same Hermes session.

---

## Cost and observability gaps

The bridge gives remote callers “full Hermes Agent” access per submit. It does not yet capture token/cost/model per task, structured tool-call transcripts, or durable audit beyond SQLite task rows (24h cleanup on restart).

**Cost telemetry target:** see [`specs/hermes-satellite-verify.md`](./specs/hermes-satellite-verify.md#cost-telemetry) — bridge reads session token counters from **`~/.hermes/state.db`** on terminal, persists to **`task_costs`**, returns `TaskCostSnapshot` on `hermes_result` and callbacks.

Hermes config currently has MoA enabled (`moa.enabled: true`, OpenRouter Opus aggregator). That is fine when the **prompt explicitly asks for it**. The gap is **visibility**: without per-task cost capture, an expensive run looks the same as a cheap one until the bill arrives.

### Documentation quality

**Good enough to understand/rebuild the current bridge**

- Architecture, paths, service management, tools, FastMCP, supergateway, StreamableHTTP vs SSE, state DB, retention, limitations.

**Not good enough yet for satellite + verify workflow**

- No durable append-only audit log
- SQLite tasks auto-clean after 24h on bridge restart
- No token/cost capture per task
- No model/provider capture per task
- No per-caller identity beyond `caller` string
- No structured tool-call transcript capture beyond final output/error and Hermes session lookup
- No completion callback / wake to **satellite verifier** (client must poll)
- No UI

---

## Useful next build-out

### 1. Migrate transport

- Native HTTP MCP in Python (drop supergateway + stdio)
- Bearer auth on every request
- Bind Tailscale/LAN, not blind `0.0.0.0`

### 2. Observability tables (SQLite or append-only log)

| Table | Purpose |
|-------|---------|
| `mcp_events` | Raw initialize/tools/call/status/result activity |
| `task_runs` | Subprocess command, model/provider, profile, toolsets, exit code |
| `task_costs` | Prompt tokens, completion tokens, provider, model, estimated cost |

### 3. Completion callback + transcript

- On terminal task status, wake the **satellite verifier** (MCP client webhook — TBD)
- Include `session_id`, optional `transcriptPath` from auto-export
- New tool **`hermes_transcript(session_id)`** → runs `hermes sessions export` against `state.db`, returns jsonl for T2 verification
- Verifier runs evidence checks on transcript tool rows; failures go through `hermes_respond`

### 4. Optional cost guardrails (not scoped-dispatch defaults)

- Preflight warning when prompt mentions MoA / expensive tools
- Per-caller budget caps
- Explicit `allow_expensive=true` flag for high-cost modes if we add policy later

### 5. Move source of truth into repo

- e.g. `apps/hermes-async-bridge/` or `mac-mini-server/hermes-agent/mcp-bridge/`
- Keep launchd using the repo script or a deployed symlink
- Docs live in repo, not only `~/.hermes`
