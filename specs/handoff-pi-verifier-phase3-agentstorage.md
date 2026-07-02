# Handoff: Pi Verifier — pnpm migration, Hermes wiring, Phase 3, then Hermes Phase 4 handoff

**From:** Operator (Ossie) + prior scaffold/Phase-2 agents  
**To:** Pi coding agent (verifier / Hermes satellite work)  
**Repo (NEW location):** `/volumes/agentstorage/the-bridge/the-verifier-agent`  
**Prior path (deprecated):** `~/Projects/agents/the-verifier-agent`  
**Date:** 2026-07-01  
**Primary spec:** `specs/hermes-satellite-verify.md`

---

## Mission (in order)

1. **Acknowledge repo move** — open workspace at `/volumes/agentstorage/the-bridge/the-verifier-agent`.
2. **Migrate `apps/verifier` from npm → pnpm** (operator preference).
3. **Use CodeGraph + codebase memory MCP** for exploration (not grep-first).
4. **Verify Phase 2 Hermes wiring**, finish anything incomplete, run live PONG smoke.
5. **Implement Phase 3** — verify loop + transcript + decompose tool registration.
6. **Write a Phase 4 handoff for Hermes** (Mac mini operator) when Phase 3 exit criteria are met.

---

## Repo move (operator FYI)

The entire repo lives on shared agent storage so Hermes and all agents see one tree:

```
/volumes/agentstorage/the-bridge/the-verifier-agent
```

After opening there:

```bash
cd /volumes/agentstorage/the-bridge/the-verifier-agent/apps/verifier
pnpm install          # after migration — see Task 1
pnpm run typecheck
pnpm test
just --list
```

Copy `.env` from old checkout if needed (never commit). Required for live bridge:

```bash
HERMES_MCP_URL=http://<bridge-host>:8081/mcp  # Tailscale bind; LAN <bridge-host> is not exposed
HERMES_MCP_TOKEN=<redacted — operator provides>
HERMES_CALLBACK_URL=                          # optional until Phase 4
```

---

## Task 1 — pnpm migration (do first)

**Scope:** `apps/verifier` only. Do not rewrite `ai_docs/pi/` (vendored upstream docs).

| Action | Detail |
|--------|--------|
| Remove | `apps/verifier/package-lock.json`, `node_modules/` |
| Add | `pnpm-lock.yaml`, optional `"packageManager": "pnpm@9.x"` in `package.json` |
| Update scripts/docs | See file list below |
| Verify | `pnpm install && pnpm run typecheck && pnpm test` |

**Files to update (npm → pnpm):**

- `apps/verifier/package.json` — scripts unchanged; add `packageManager` if desired
- `README.md` — install/typecheck/test lines + Hermes section
- `specs/hermes-satellite-verify.md` — checklist lines mentioning `npm run typecheck`
- `scripts/install-local.sh` — `pnpm install` (rename `SKIP_NPM` → `SKIP_PNPM` or keep flag name + update message)
- `.claude/commands/install.md` — step 6 install command
- `apps/verifier/hermes/decompose.test.ts` — header comment
- Prior handoff docs — ignore; this doc supersedes

**Do not change:** Pi global install docs in `ai_docs/pi/` (still `npm install -g @mariozechner/pi-coding-agent`).

---

## Task 2 — Exploration tools (mandatory)

Use these **before** editing; prefer over grep/read loops for structure.

### CodeGraph (`codegraph_*` MCP)

| Intent | Tool |
|--------|------|
| Hermes / verifier area context | `codegraph_context` with task description |
| Flow builder → Hermes client | `codegraph_trace` (e.g. `hermes-dispatch` → `waitForHermes`) |
| Symbol bodies | `codegraph_explore` (one call, multiple symbols) |
| Impact before parser changes | `codegraph_impact` |

### Codebase memory MCP (`user-codebase-memory-mcp`)

| Intent | Tool |
|--------|------|
| Architecture overview | `get_architecture` project `Users-<user>-Projects-agents-the-verifier-agent` (re-index if path changed after move) |
| Find symbols | `search_graph` |
| Call paths | `trace_path` |
| Source snippet | `get_code_snippet` after search |

**Note:** After repo move, run `index_repository` on the new path if architecture queries are stale.

---

## Task 3 — Verify Phase 2 (reported complete; confirm on agentstorage)

Prior agent reported **Phase 2 Pi wiring implemented**:

| File | Expected state |
|------|----------------|
| `apps/verifier/hermes/client.ts` | Streamable HTTP JSON-RPC MCP client, Bearer auth, initialize + session headers |
| `apps/verifier/hermes/poll.ts` | Working `waitForHermes`; constants 30 / 120 / 600; `hermes_result` once on terminal |
| `apps/verifier/hermes-dispatch.ts` | Real Pi tool wrappers; internal poll after submit; dotenv load |
| `apps/verifier/hermes/decompose.test.ts` | Client + poll tests (**11/11** reported) |

**Your verification:**

```bash
cd /volumes/agentstorage/the-bridge/the-verifier-agent/apps/verifier
pnpm run typecheck && pnpm test
just --dry-run hermes-dispatch
```

**Live smoke (required to close Phase 2):**

```bash
# .env loaded via justfile set dotenv-load
just hermes-dispatch
# Prompt: "Reply with the word PONG and nothing else."
```

**Exit Phase 2:** PONG returned via Hermes; poll behavior matches `hermes-polling.md`.

---

## Live bridge (operator FYI — do not duplicate into code)

| Item | Value |
|------|--------|
| Service | `<launchd-label>` (launchd, running) |
| Transport today | Native Python FastMCP Streamable HTTP via `~/.hermes/scripts/run_hermes_async_bridge.sh` |
| Health | `http://<bridge-host>:8081/healthz` ✓ from another tailnet node; Mac mini cannot reliably curl its own Tailscale IP |
| MCP URL | `http://<bridge-host>:8081/mcp` |
| Tools today | `hermes_submit`, `hermes_status`, `hermes_result`, `hermes_respond`, `hermes_cancel`, `hermes_list`, `hermes_sessions`, `hermes_transcript`, `hermes_decompose`, `hermes_task_cost` |
| Auth | Proven from MBP13: no-token initialize → 401; bearer-token initialize → 200 |

Script is symlinked at **`/Users/<user>/.hermes/scripts/hermes_async_bridge.py`** on Mac mini; launchd runs the wrapper script above.

---

## Task 4 — Phase 3 verify loop

**Spec:** `specs/hermes-satellite-verify.md` → § Phase 3

**Goal:** After Hermes completes → decompose → verify → `hermes_respond` → re-verify until VERIFIED or `max_loops`.

### Pi coding agent deliverables

1. **`hermes-verify-trigger.ts`** (finish stub)
   - Terminal poll → fetch transcript → `hermes_decompose` → inject `verify_on_satellite_complete.md`
   - Loop: failed claims → `hermes_respond` → poll → re-verify
   - Escalate at `max_loops`

2. **`hermes/transcript.ts`**
   - T1/T2 fetch (MCP `hermes_sessions` today; `hermes_transcript` when bridge adds it)

3. **`hermes/decompose.ts`**
   - Extend v1 rules; more golden fixtures under `hermes/__fixtures__/`
   - Register **`hermes_decompose`** Pi tool

4. **Phase 0.5 (recommended before trusting verify loop)** — `apps/verifier/verifier.ts`:
   - `\Z` end-anchor bug (~line 1057)
   - Confidence-absence launder (~1046–1049)
   - Satellite Report headers: `Cost`, `Evidence tier`, require `EVIDENCE_TIER` + `CONFIDENCE`
   - See spec § Phase 0.5

### Phase 3 exit

Deliberately bad Hermes answer → decompose surfaces failed tool row → `hermes_respond` → second pass VERIFIED.

### Bridge gap for Phase 3

If `hermes_transcript` / `hermes_decompose` are not on the bridge yet, Phase 3 can:
- Client-side: fetch via `hermes_sessions` + local `decompose.ts` (Pi path)
- Document bridge MCP additions needed for Claude/Codex path

Spec prefers bridge shelling to `bun apps/verifier/hermes/decompose.ts` for non-Pi clients — use **bun on Mac mini**, **pnpm on dev MacBook** (both fine).

---

## Task 5 — End deliverable: Hermes Phase 4 handoff

When Phase 3 exit criteria pass, **write a new handoff** to OS temp (same skill as this doc) for **Hermes (Mac mini operator)**.

**Handoff must include (reference spec, don't duplicate):**

- Phase 4 task table from `specs/hermes-satellite-verify.md` § Phase 4
- `hermes-mcp.md` §5 — move canonical bridge to `apps/hermes-async-bridge/` in this repo
- Symlink plan: `~/.hermes/scripts/hermes_async_bridge.py` → agentstorage copy
- launchd plist update path
- Auth gap: today **no bearer auth** on supergateway; mandatory before broad exposure
- Research: `.auto/research/hermes-phase4-blockers.md`
- Tools Phase 4 must add: `hermes_transcript`, cost capture (`task_costs`), callback payload
- Current launchd command (supergateway line) for Hermes to replace
- What Pi client already expects after Phase 3 (tool shapes, poll contract)

**Suggested skills for Hermes handoff author:** `handoff`, `homelab`

---

## Phase ownership (reference)

| Phase | Owner |
|-------|--------|
| 0.5 | Pi coding agent |
| 1 | Scaffold agent ✓ |
| 2 | Pi coding agent (verify + PONG) |
| 3 | Pi coding agent ← **you** |
| 4 | Hermes (Mac mini) ← **your handoff at end** |
| 5 | Claude Code + Codex |

---

## Suggested skills (Pi agent)

| Skill | When |
|-------|------|
| **`verify-this`** | Confirm Phase 2 on agentstorage before Phase 3 |
| **`check-compiler-errors`** | After pnpm migration and each module change |
| **`homelab`** | Bridge access, Mac mini paths, operator questions |
| **`review-and-ship`** | Before declaring Phase 3 done |
| **`diagnosing-bugs`** | MCP client / poll / verify loop failures |
| **`handoff`** | Write Hermes Phase 4 doc at end |
| **`find-docs`** | Pi extension API, Streamable HTTP MCP |

---

## References

- `specs/hermes-satellite-verify.md` — phases 0.5–5
- `hermes-polling.md` — poll constants
- `hermes-mcp.md` — bridge architecture + repo migration
- `.auto/research/hermes-phase4-blockers.md`
- `.auto/research/hermes-decompose-accuracy.md`
- `.pi/verifier/agents/satellite-verifier.md`
- `.pi/verifier/prompts/verify_on_satellite_complete.md`

---

## Success criteria for your session

- [x] Workspace at `/volumes/agentstorage/the-bridge/the-verifier-agent`
- [x] pnpm migration complete; `pnpm run typecheck` + `pnpm test` green
- [x] Phase 2 PONG smoke passes with `.env` (`55eb9d59-e1c` → `PONG`)
- [ ] Phase 3 verify loop exit criteria met
  - Partial: verify-trigger loop scaffold, transcript fallback, local `hermes_decompose` Pi tool, and parser hardening are implemented.
  - Not complete: deliberate bad-answer → `hermes_respond` → second-pass VERIFIED smoke remains, pending bridge-side `hermes_transcript`/server `hermes_decompose` or an equivalent T2 fixture path.
- [x] Hermes Phase 4 handoff written to OS temp directory: `/tmp/hermes-phase4-handoff-2026-07-02.md`
