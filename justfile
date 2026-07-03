# Hermes Satellite — justfile
#
# Remote Hermes execution and satellite verification over authenticated MCP.

set dotenv-load := true

# Show available recipes (default when running bare `just`)
default:
    @just --list

# Type-check the TypeScript verifier/client modules
typecheck:
    cd apps/verifier && pnpm run typecheck

# Compile and run the Hermes decomposition/unit tests
test:
    cd apps/verifier && pnpm test

# Check the native Python bridge can be parsed and FastMCP can be instantiated
bridge-check:
    #!/usr/bin/env bash
    set -euo pipefail
    python3 -m py_compile apps/hermes-async-bridge/hermes_async_bridge.py
    PYTHON="${HERMES_PYTHON:-python3}"
    "$PYTHON" -c "import importlib.util, sys; from pathlib import Path; path = Path('apps/hermes-async-bridge/hermes_async_bridge.py'); spec = importlib.util.spec_from_file_location('bridge_check', path); mod = importlib.util.module_from_spec(spec); sys.modules['bridge_check'] = mod; spec.loader.exec_module(mod); server = mod.create_mcp_server(host='127.0.0.1', port=18081, token='test-token'); print('FastMCP created', server.settings.host, server.settings.port, server.settings.streamable_http_path)"

# Run all local checks that do not require a live MCP client smoke test
check: typecheck test bridge-check

# Record a changeset for the next release (semver bump + changelog entry)
changeset:
    pnpm changeset

# Show pending changesets since HEAD
changeset-status:
    pnpm changeset status --since=HEAD

# Apply accumulated changesets: bump package versions and update changelogs
version-packages:
    pnpm version-packages

# Hermes satellite dispatch: Pi session with Hermes MCP tools/persona
hermes-dispatch:
    pi -e ./apps/verifier/hermes-dispatch.ts -e ./apps/verifier/cross-agent.ts --hermes-dispatch

# Launch the legacy local builder + auto-spawn verifier harness
verifier:
    pi -e ./apps/verifier/verifiable.ts -e ./apps/verifier/cross-agent.ts --verifiable

# Shortcut alias — `j v` ≡ `j verifier`
v: verifier

# Kill stale verifier tmux sessions, sockets, and breadcrumbs from prior runs
clean:
    -tmux ls 2>/dev/null | grep '^verifier-' | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
    -rm -f /tmp/pi-verifier/*.sock
    -rm -f .pi/state/verifier-*.sock.ref
    @echo "clean: stale verifier state removed"

# Prime context in an interactive Claude Code session
prime:
    claude --dangerously-skip-permissions --model "opus[1m]" "/prime"

# Prime context in an interactive pi session (prefers `ipi` shell function if defined, else `pi`)
primepi:
    @zsh -ic 'if typeset -f ipi >/dev/null 2>&1 || command -v ipi >/dev/null 2>&1; then ipi "/prime"; else pi "/prime"; fi'

# Vendor the legacy local verifier harness into another local repo
install-local target:
    @scripts/install-local.sh "{{target}}"

# Run a vendored verifier from another local repo after install-local
run-local target:
    @cd "{{target}}" && just -f justfile.verifier v
