# Hermes MCP bridge — architecture and gaps

The canonical Phase 4 bridge source now lives in this repo at `apps/hermes-async-bridge/`. The Mac mini launchd service has been cut over from `supergateway` to the native Python Streamable HTTP bridge bound to Tailscale `<bridge-host>:8081`. Treat the repo copy as source of truth for the native HTTP/auth implementation.

---

## Documentation

Canonical repo bridge script:

```text
apps/hermes-async-bridge/hermes_async_bridge.py
```

Legacy/deployed script path: `/Users/<user>/.hermes/scripts/hermes_async_bridge.py`.

It is currently launched via wrapper script:

```bash
/Users/<user>/.hermes/scripts/run_hermes_async_bridge.sh
```

The HTTP bridge is exposed directly by native Python FastMCP on **Tailscale port 8081** (`http://<bridge-host>:8081/mcp`). Bearer auth is configured in the Python SDK and has been proven from another tailnet node: no token returns HTTP 401, bearer token returns HTTP 200 with a clean MCP initialize. No `supergateway` layer should be in front.

Standalone doc (on the Mac mini): `/Users/<user>/.hermes/docs/hermes-async-bridge.md`

Related: [`hermes-polling.md`](./hermes-polling.md) — client-side poll algorithm after `hermes_submit`.

Main-machine install handoff: [`specs/hermes-mcp-main-machine-install.md`](./specs/hermes-mcp-main-machine-install.md).

---

## Filesystem / important paths

| Role | Path |
|------|------|
| Canonical repo script | `apps/hermes-async-bridge/hermes_async_bridge.py` |
| Active MCP server script (legacy/deploy symlink target) | `/Users/<user>/.hermes/scripts/hermes_async_bridge.py` |
| launchd wrapper | `/Users/<user>/.hermes/scripts/run_hermes_async_bridge.sh` |
| Python interpreter (runtime) | `/Users/<user>/.hermes/hermes-agent/venv/bin/python3` |
| SQLite task DB | `/Users/<user>/.hermes/async_bridge.db` |
| launchd service | `/Users/<user>/Library/LaunchAgents/<launchd-label>.plist` |
| Service logs | `/Users/<user>/Library/Logs/hermes-async-bridge.log` |
| Service error log | `/Users/<user>/Library/Logs/hermes-async-bridge.err.log` |
| Documentation | `/Users/<user>/.hermes/docs/hermes-async-bridge.md` |
| Hermes skill docs | `/Users/<user>/.hermes/skills/autonomous-ai-agents/hermes-mcp-bridge/SKILL.md` |
| Skill architecture ref | `/Users/<user>/.hermes/skills/autonomous-ai-agents/hermes-mcp-bridge/references/async-bridge-architecture.md` |
| Skill’s copy of the script | `/Users/<user>/.hermes/skills/autonomous-ai-agents/hermes-mcp-bridge/scripts/hermes_async_bridge.py` |
| Runtime token cache | `/Users/<user>/.hermes/secrets/hermes_async_bridge_token` (`0600`, mirrored to BWS as `HERMES_ASYNC_BRIDGE_TOKEN`) |

**Note:** The active runtime path is the wrapper + symlink to the repo script. The skill-copy script may lag; update the skill docs/scripts after deployment verification.

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
| Network path to Mac mini | Tailscale `<bridge-host>` is the deployed bind; LAN `<bridge-host>` is only a future/alternate bind |
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
| Transport | Native Streamable HTTP (`mcp.run(transport="streamable-http")`) |
| HTTP bridge | None — `supergateway` removed from launchd path |
| Active endpoint | `http://<bridge-host>:8081/mcp` |
| Health endpoint | `http://<bridge-host>:8081/healthz` |
| Auth | SDK bearer auth configured via `token_verifier` + `AuthSettings`; verified no-token 401 and bearer-token initialize 200 from MBP13 |

**launchd command (today):**

```bash
/Users/<user>/.hermes/scripts/run_hermes_async_bridge.sh
```

**Verified:** transport cutover is complete and auth is proven from MBP13 as a separate tailnet client: unauthenticated `/mcp` returned 401; authenticated initialize returned 200. The listener is bound to the Tailscale IP only, so the old unauthenticated LAN exposure is gone.

**Smoke-test quirk:** the Mac mini cannot reliably curl its own Tailscale IP. Test `http://<bridge-host>:8081/mcp` from another tailnet node, not from the Mac mini itself.

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
- `hermes_transcript` — export session from `state.db` / `hermes sessions export`
- `hermes_decompose` — T2 export → `AtomicClaim[]` JSON via repo TypeScript decomposition
- `hermes_task_cost` — latest/history token/model/USD snapshot per task + respond loop

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

The bridge gives remote callers “full Hermes Agent” access per submit. Phase 4 now adds SQLite observability tables and post-task cost capture from Hermes `state.db`; live verification still needs to exercise those paths with an authenticated PONG task.

**Cost telemetry target:** see [`specs/hermes-satellite-verify.md`](./specs/hermes-satellite-verify.md#cost-telemetry) — bridge reads session token counters from **`~/.hermes/state.db`** on terminal, persists to **`task_costs`**, returns `TaskCostSnapshot` on `hermes_result` and callbacks.

Hermes config currently has MoA enabled (`moa.enabled: true`, OpenRouter Opus aggregator). That is fine when the **prompt explicitly asks for it**. The gap is **visibility**: without per-task cost capture, an expensive run looks the same as a cheap one until the bill arrives.

### Documentation quality

**Good enough to understand/rebuild the current bridge**

- Architecture, paths, service management, tools, FastMCP, supergateway, StreamableHTTP vs SSE, state DB, retention, limitations.

**Still to verify for satellite + verify workflow**

- Live PONG task needs to prove `hermes_result.cost`, `hermes_transcript`, and `hermes_decompose`
- Per-caller identity is still caller-string level, not per-token principal mapping
- Completion callback endpoint/client listener still needs end-to-end proof
- No UI

---

## Useful next build-out

### 1. Migrate transport

- Done in launchd: native HTTP MCP in Python (no supergateway/stdio wrapper)
- Done in config: bearer auth via SDK token verifier
- Done in launchd: bind Tailscale `<bridge-host>`, not blind `0.0.0.0`
- Verified from MBP13: no-token `/mcp` returns 401 and bearer-token initialize returns 200

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

- `apps/hermes-async-bridge/` is the repo home.
- Keep launchd using the repo script or a deployed symlink.
- Docs live in repo, not only `~/.hermes`.
