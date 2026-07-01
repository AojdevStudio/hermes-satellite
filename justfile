# Pi Verifier Agent — justfile
#
# Recipes for the v1 verifier system.
#
# Conventions per /just skill:
#   - `default` recipe lists available commands (silent listing).
#   - `set dotenv-load` so a project-local `.env` is loaded automatically.

set dotenv-load := true

# Show available recipes (default when running bare `just`)
default:
    @just --list

# Launch builder + auto-spawn verifier (generic `verifier` persona)
verifier:
    pi -e ./apps/verifier/verifiable.ts -e ./apps/verifier/cross-agent.ts --verifiable

# Shortcut alias — `j v` ≡ `j verifier`
v: verifier

# Prime context in an interactive Claude Code session
prime:
    claude --dangerously-skip-permissions --model "opus[1m]" "/prime"

# Prime context in an interactive pi session (prefers `ipi` shell function if defined, else `pi`)
primepi:
    @zsh -ic 'if typeset -f ipi >/dev/null 2>&1 || command -v ipi >/dev/null 2>&1; then ipi "/prime"; else pi "/prime"; fi'

# Kill any stale verifier tmux sessions, sockets, and breadcrumbs from prior runs
clean:
    -tmux ls 2>/dev/null | grep '^verifier-' | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
    -rm -f /tmp/pi-verifier/*.sock
    -rm -f .pi/state/verifier-*.sock.ref
    @echo "clean: stale verifier state removed"

# Vendor this verifier into another local repo.
install-local target:
    @scripts/install-local.sh "{{target}}"

# Run a vendored verifier from another local repo after install-local.
run-local target:
    @cd "{{target}}" && just -f justfile.verifier v
