---
description: Install Pi Verifier Agent — prerequisites, deps, persona validation, and provider env
---

# Install Pi Verifier Agent

## Purpose

Set up the Pi Verifier Agent for development on a fresh clone. Walks the user through every check the system needs — runtime tools (node / tmux / pi), TypeScript dependencies, the verifier persona, and an LLM provider API key — without ever starting an interactive Pi session. Interactive: ask the user when a choice is needed (e.g., which API key to set), install what can be installed automatically.

## Variables

SOURCE_REPO: The repo root this command runs from
APP_DIR: `apps/verifier/`
PERSONA: `.pi/verifier/agents/verifier.md`
PROMPT_TEMPLATE: `.pi/verifier/prompts/verify_on_stop.md`
SETTINGS: `.pi/settings.json`

## Codebase Structure

```
the-verifier-agent/
├── apps/verifier/                  # TypeScript extensions (verifiable.ts + verifier.ts + _shared/)
│   ├── package.json
│   └── tsconfig.json
├── .pi/
│   ├── settings.json               # { skills, sessionDir }
│   └── verifier/
│       ├── agents/verifier.md      # the only persona — frontmatter declares model, max_loops, tools
│       └── prompts/                # verify_on_stop.md, builder_error.md
├── justfile                        # default | verifier | v | prime | primepi | clean
└── .env                            # NOT in repo; user creates with provider API keys
```

## Instructions

- Run every check via Bash — do not assume anything is installed.
- Show a one-line pass/fail status after each check.
- Critical deps (`node`, `pi`, `tmux`) gate the install — stop and instruct the user if missing.
- For the API key step: confirm a provider key is set in either `process.env` or `.env`. **Never read or print key values** — only confirm presence.
- Do NOT start `pi`, do NOT run `just verifier`, do NOT open windows — this command verifies readiness only.
- If a `.env` doesn't exist, offer to create one with the chosen provider's key as a placeholder (commented), but never write a real key.

## Workflow

### Step 1 — Critical prerequisites (gate)

If any of these are missing, stop and instruct the user before continuing.

1. Check `node`: `command -v node && node --version`. Need ≥ 20. If missing → `brew install node` (macOS) or use a Node version manager (nvm, fnm, volta).
2. Check `pi`: `command -v pi && pi --version`. The Pi Coding Agent CLI. If missing → `npm install -g @mariozechner/pi-coding-agent` (or the user's preferred install path; consult [Pi Coding Agent docs](https://github.com/mariozechner/pi-coding-agent)).
3. Check `tmux`: `command -v tmux && tmux -V`. Need 3.x+. If missing → `brew install tmux` (macOS) or `apt install tmux` (Debian/Ubuntu).

Stop and report each missing critical dep separately so the user can install incrementally.

### Step 2 — Recommended prerequisites

4. Check `just`: `command -v just && just --version`. Optional but every workflow command in the README runs through justfile recipes — strongly recommended. If missing → `brew install just` (macOS) or [installation instructions](https://github.com/casey/just#installation).

### Step 3 — Optional environment notes

5. Detect terminal emulator: `echo "$TERM_PROGRAM"`. The launcher's per-emulator dispatch knows about Ghostty, iTerm, Apple_Terminal, WezTerm. If `$TERM_PROGRAM` is something else (e.g., `vscode`, `WarpTerminal`), the launcher falls back to a Terminal.app window via `osascript` — also fine.

### Step 4 — Install TypeScript dependencies

6. Run `cd apps/verifier && pnpm install`. This installs `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `typebox`, `typescript`, `@types/node` into `apps/verifier/node_modules/`.

### Step 5 — Verify configuration files

7. Persona file exists and frontmatter is parseable:
   - `[ -f .pi/verifier/agents/verifier.md ] && echo persona-present`
   - The frontmatter must declare `name`, `description`, `tools`, `model`, `domain`, optionally `max_loops`. The exact contract is enforced at runtime by `apps/verifier/_shared/frontmatter.ts:parseVerifierPersona`.
8. User-prompt template exists:
   - `[ -f .pi/verifier/prompts/verify_on_stop.md ] && echo prompt-template-present`
9. Project settings exist:
   - `[ -f .pi/settings.json ] && node -e 'JSON.parse(require("fs").readFileSync(".pi/settings.json","utf8"))' && echo settings-valid-json`
10. TypeScript extension entry points exist (the justfile's `verifier` recipe loads all three via `pi -e`):
    - `[ -f apps/verifier/verifiable.ts ] && [ -f apps/verifier/verifier.ts ] && [ -f apps/verifier/cross-agent.ts ] && echo extension-entries-present`
    - If any are missing, `just v` will fail with a Pi extension-load error before the verifier ever spawns.

### Step 6 — Verify environment / provider API key

11. Read the persona's `model:` field from `.pi/verifier/agents/verifier.md` to know which provider key the user needs (e.g. `openai/...` → `OPENAI_API_KEY`, `anthropic/...` → `ANTHROPIC_API_KEY`). Check without printing the value:
    - `[ -n "${<PROVIDER>_API_KEY:-}" ] && echo "<PROVIDER>_API_KEY is set in shell env"`
    - If not in shell env, look for a project-local `.env`: `[ -f .env ] && grep -q '^<PROVIDER>_API_KEY=' .env && echo "<PROVIDER>_API_KEY is set in .env"` (don't print the value).
12. If neither check finds it: ask the user which provider they want to use. Both extensions auto-load `.env` from `ctx.cwd` on `session_start` and tmux forwards env via `-e KEY=VAL`, so dropping the key into a project-local `.env` Just Works for both agents.
13. If `.env` does not exist, offer to create a stub with placeholder lines for common providers (commented out — user fills in real values themselves):
    ```
    # ANTHROPIC_API_KEY=sk-ant-...
    # DEEPSEEK_API_KEY=sk-...
    # OPENAI_API_KEY=sk-...
    ```
    Never write a real key to disk.

### Step 7 — Final verification (no servers started)

14. Run `cd apps/verifier && pnpm run typecheck` — must exit 0. Confirms TypeScript compiles cleanly across both extensions and the shared substrate.

### Step 8 — Report

Present a status table per the Report section.

## Report

Present the install result in this format:

```
Pi Verifier Agent — install ready

  ── Critical prerequisites ──────────────────────
  node           ✓ v[version]
  pi             ✓ [version]
  tmux           ✓ [version]

  ── Recommended ─────────────────────────────────
  just           ✓ [version]

  ── Optional ────────────────────────────────────
  $TERM_PROGRAM  [value — recognized | falls back to Terminal.app]

  ── Configuration ───────────────────────────────
  apps/verifier/node_modules/                ✓
  apps/verifier/{verifiable,verifier,cross-agent}.ts  ✓
  .pi/settings.json (valid JSON)             ✓
  .pi/verifier/agents/verifier.md            ✓
  .pi/verifier/prompts/verify_on_stop.md     ✓

  ── Provider key ────────────────────────────────
  [PROVIDER]_API_KEY   ✓ set in [shell env | .env]

  ── Final verification ──────────────────────────
  tsc --noEmit   ✓ exit 0

  Ready: [N]/[total] checks passing.

  ── Next steps ──────────────────────────────────
  Prime a fresh agent session:     /prime
  Launch the verifier loop:        just v
```
