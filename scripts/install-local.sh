#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-local.sh <target-repo>

Copies the Pi Verifier Agent into another local repo as vendored files.

Env:
  FORCE=1     overwrite same-name vendored files in the target repo
  SKIP_NPM=1  copy files but skip npm install
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -ne 1 ]]; then
  usage
  exit $([[ $# -eq 1 ]] && [[ "${1:-}" =~ ^(-h|--help)$ ]] && echo 0 || echo 2)
fi

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TARGET_INPUT="$1"

if [[ ! -d "$TARGET_INPUT" ]]; then
  echo "install-local: target repo does not exist: $TARGET_INPUT" >&2
  exit 1
fi

TARGET="$(cd "$TARGET_INPUT" && pwd -P)"

for required in \
  "$SOURCE_ROOT/apps/verifier" \
  "$SOURCE_ROOT/.pi/verifier" \
  "$SOURCE_ROOT/.pi/settings.json" \
  "$SOURCE_ROOT/.claude/commands"; do
  if [[ ! -e "$required" ]]; then
    echo "install-local: source file missing: $required" >&2
    exit 1
  fi
done

check_collision() {
  local path="$1"
  if [[ -e "$path" && "${FORCE:-0}" != "1" ]]; then
    cat >&2 <<EOF
install-local: refusing to overwrite existing path:
  $path

Re-run with FORCE=1 to replace same-name vendored verifier files.
EOF
    exit 1
  fi
}

check_collision "$TARGET/apps/verifier"
check_collision "$TARGET/.pi/verifier"
check_collision "$TARGET/justfile.verifier"

while IFS= read -r source_file; do
  rel="${source_file#"$SOURCE_ROOT/.claude/commands/"}"
  check_collision "$TARGET/.claude/commands/$rel"
done < <(find "$SOURCE_ROOT/.claude/commands" -type f)

if ! command -v rsync >/dev/null 2>&1; then
  echo "install-local: rsync is required" >&2
  exit 1
fi

mkdir -p "$TARGET/apps" "$TARGET/.pi" "$TARGET/.claude/commands"

if [[ "${FORCE:-0}" == "1" ]]; then
  rm -rf "$TARGET/apps/verifier" "$TARGET/.pi/verifier" "$TARGET/justfile.verifier"
fi

rsync -a --exclude node_modules "$SOURCE_ROOT/apps/verifier/" "$TARGET/apps/verifier/"
rsync -a "$SOURCE_ROOT/.pi/verifier/" "$TARGET/.pi/verifier/"
rsync -a "$SOURCE_ROOT/.claude/commands/" "$TARGET/.claude/commands/"

node - "$SOURCE_ROOT/.pi/settings.json" "$TARGET/.pi/settings.json" <<'NODE'
const fs = require("node:fs");
const [sourcePath, targetPath] = process.argv.slice(2);
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
let target = {};
if (fs.existsSync(targetPath)) {
  target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
}
const merged = { ...source, ...target };
const wantedSkillPaths = Array.isArray(source.skills) ? source.skills : [];
const currentSkillPaths = Array.isArray(target.skills) ? target.skills : [];
merged.skills = [...new Set([...currentSkillPaths, ...wantedSkillPaths])];
if (target.sessionDir === undefined && source.sessionDir !== undefined) {
  merged.sessionDir = source.sessionDir;
}
fs.mkdirSync(require("node:path").dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`);
NODE

cat > "$TARGET/justfile.verifier" <<'JUST_EOF'
set dotenv-load := true

# Launch builder + auto-spawn verifier.
verifier:
    pi -e ./apps/verifier/verifiable.ts -e ./apps/verifier/cross-agent.ts --verifiable

v: verifier

# Remove stale verifier tmux/socket state.
clean-verifier:
    -tmux ls 2>/dev/null | grep '^verifier-' | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
    -rm -f /tmp/pi-verifier/*.sock
    -rm -f .pi/state/verifier-*.sock.ref
    @echo "clean: stale verifier state removed"
JUST_EOF

if [[ "${SKIP_NPM:-0}" != "1" ]]; then
  (cd "$TARGET/apps/verifier" && npm install)
else
  echo "install-local: SKIP_NPM=1, skipped npm install"
fi

cat <<EOF

Pi Verifier Agent vendored into:
  $TARGET

Run it from that repo with:
  just -f justfile.verifier v

Copied:
  apps/verifier/
  .pi/verifier/
  .pi/settings.json (merged)
  .claude/commands/
  justfile.verifier
EOF
