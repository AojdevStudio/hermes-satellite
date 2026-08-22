/**
 * Tmux + new-OS-window launcher for the Pi Verifier Agent (`$TMUX`-aware).
 *
 * Single shared implementation for both `--verifiable` auto-spawn and the
 * `/verify` slash command. Idempotent: a second call when the verifier is
 * already running is a no-op + return, never a duplicate spawn.
 *
 * Two branches, intentionally:
 *
 *   1. IN-TMUX BRANCH (`$TMUX` set) — the builder is already running inside
 *      a tmux session. We add the verifier as a *sibling window* in that
 *      same session.
 *
 *      Primary reason this branch exists: `/drive` (the tmux-based E2E
 *      harness) can only observe panes/windows in tmux sessions it owns.
 *      Without this branch, the launcher would spin up a *separate* tmux
 *      session that drive cannot reach, breaking end-to-end validation.
 *      Three callers benefit, in order of importance:
 *        (1) /drive E2E test                        [primary motivation]
 *        (2) CI / tmux-based automation              [same plumbing]
 *        (3) tmux power users running pi day-to-day  [incidental win]
 *
 *   2. NEW-OS-WINDOW BRANCH (`$TMUX` unset) — normal native-terminal user
 *      (Ghostty / iTerm / Terminal.app / Wezterm / gnome-terminal / etc.).
 *      The user wants two visible terminal windows. The detached tmux
 *      session is the source of truth (survives window close, can be
 *      re-attached); the OS window is just an attached client.
 *
 * The persona system prompt is rendered HERE, before spawn — frontmatter
 * vars (BUILDER_SESSION_ID, SOCKET_PATH, etc.) are substituted into the
 * persona body and passed to the verifier child via `--system-prompt`.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { parseVerifierPersona, templateBody } from "./frontmatter.js";
import { ensureSocketDir, resolveSocketPath, writeSocketRef } from "./socket-path.js";

const execFileP = promisify(execFile);

// ─── Public types ────────────────────────────────────────────────────────────

export interface SpawnOpts {
  /** `ctx.sessionManager.getSessionId()` — the canonical session id. */
  sessionId: string;
  /** Absolute path to `.pi/verifier/agents/verify_<domain>.md`. */
  agentPath: string;
  /** Absolute path to repo root, used to resolve `apps/verifier/verifier.ts`. */
  runtimeRoot: string;
  /** `ctx.cwd` — used for `.pi/state/` breadcrumb resolution. */
  cwd: string;
  /** `.pi/settings.json` — only `verifier.terminalCommand` is consulted. */
  settings?: { verifier?: { terminalCommand?: string } };
  /** Absolute path to `~/.pi/agent/sessions/<sid>.jsonl` — fed into `<BUILDER_SESSION_FILE>`. */
  builderSessionFile: string;
}

export type SpawnMode = "in-tmux" | "new-window";

export interface SpawnResult {
  tmuxSession: string;
  mode: SpawnMode;
  /** Auto-generated bash wrapper that exports env + runs the verifier pi child. */
  wrapperPath: string;
  /**
   * File the wrapper redirects pi's stderr into (mirrored to the terminal
   * via `tee` so the tmux pane still shows it). Read on spawn-failure to
   * surface pi's actual error in the builder — far more useful than the
   * generic "verifier didn't connect in time" timeout.
   */
  stderrLogPath: string;
}

// ─── spawnVerifierChild ──────────────────────────────────────────────────────

/**
 * Spawn (or re-attach to) the verifier child for `opts.sessionId`.
 *
 * Idempotent: if a tmux session/window with the expected name already
 * exists, returns early without spawning a duplicate.
 */
export async function spawnVerifierChild(opts: SpawnOpts): Promise<SpawnResult> {
  const tmuxSession = `verifier-${opts.sessionId}`;

  // Resolve socket paths up-front — we need SOCKET_PATH for system-prompt
  // templating, and the breadcrumb so the verifier child can find the
  // socket by --builder-session alone.
  const { socketPath, refPath } = resolveSocketPath(opts.sessionId, opts.cwd);
  await ensureSocketDir();
  await writeSocketRef(socketPath, refPath);

  // ─── Render the persona system prompt before spawn ───────────────────
  const personaContent = await fs.readFile(opts.agentPath, "utf8");
  const { frontmatter, body } = parseVerifierPersona(personaContent);

  const rendered = templateBody(body, {
    BUILDER_SESSION_ID: opts.sessionId,
    BUILDER_SESSION_FILE: opts.builderSessionFile,
    DOMAIN: frontmatter.domain,
    MAX_LOOPS: String(frontmatter.max_loops ?? 3),
    SOCKET_PATH: socketPath,
  });

  // Stash the rendered prompt in a tempfile so it's inspectable post-mortem
  // AND so the wrapper script can load it via `$(cat ...)` instead of having
  // it embedded in the tmux command line. macOS ARG_MAX (~256KB for argv +
  // envp combined) is easily blown by a 10KB system prompt + ~50 -e KEY=VAL
  // env flags inline — embedding the prompt in a file keeps tmux's command
  // line short.
  const systemPromptFile = path.join(os.tmpdir(), `pi-verifier-${opts.sessionId}.system.md`);
  await fs.writeFile(systemPromptFile, rendered, { encoding: "utf8", mode: 0o600 });

  // ─── Build the spawn wrapper ─────────────────────────────────────────
  // Instead of passing all the env via tmux `-e` flags AND the system prompt
  // inline AND the long pi command — all of which combine to blow ARG_MAX
  // on macOS — we write a tiny wrapper shell script that exports the env
  // and exec's pi. tmux then just runs `bash <wrapper>`. Wrapper file size
  // doesn't count toward exec()'s ARG_MAX; only the tmux command's argv does.
  //
  // Pi defaults to its full tool set; we forward only what the persona's
  // `tools:` field declares (architectural read-only guarantee).
  const verifierEntry = path.join(opts.runtimeRoot, "apps", "verifier", "verifier.ts");
  const wrapperPath = path.join(os.tmpdir(), `pi-verifier-${opts.sessionId}.spawn.sh`);
  const stderrLogPath = path.join(os.tmpdir(), `pi-verifier-${opts.sessionId}.stderr.log`);
  const wrapperContent = buildSpawnWrapper({
    env: process.env,
    systemPromptFile,
    verifierEntry,
    sessionId: opts.sessionId,
    agentPath: opts.agentPath,
    tools: normalizeToolsList(frontmatter.tools),
    model: frontmatter.model,
    stderrLogPath,
  });
  await fs.writeFile(wrapperPath, wrapperContent, { encoding: "utf8", mode: 0o700 });

  // ─── Idempotency check ───────────────────────────────────────────────
  if (await verifierAlreadyRunning(tmuxSession)) {
    return {
      tmuxSession,
      mode: process.env.TMUX ? "in-tmux" : "new-window",
      wrapperPath,
      stderrLogPath,
    };
  }

  // The actual command tmux runs is a single short string: `bash <wrapper>`.
  // Env exports + system-prompt-from-file happen inside the wrapper, so
  // tmux's own argv stays well under ARG_MAX regardless of how chunky the
  // calling process's env or the rendered persona is.
  const verifierCommand = `bash ${shellSingleQuote(wrapperPath)}`;

  // ─── Branch on $TMUX ─────────────────────────────────────────────────
  if (process.env.TMUX) {
    // ── IN-TMUX BRANCH ──────────────────────────────────────────────
    // This branch primarily exists so /drive can validate the system
    // end-to-end (drive is tmux-based and can only observe panes in
    // tmux sessions it owns); also incidentally helps users who live
    // in tmux daily. Three callers benefit:
    //   (1) /drive E2E test                       [primary]
    //   (2) CI / tmux-based automation
    //   (3) tmux power users                      [incidental]
    // We create the verifier as a sibling window in the existing tmux
    // session — same parent tmux process, same observability surface.
    // `-c <cwd>` makes the new window inherit the builder's cwd.
    // Env propagates via the wrapper script, NOT tmux `-e` flags
    // (those would re-introduce the ARG_MAX blowup we just avoided).
    await execFileP("tmux", [
      "new-window",
      "-n", tmuxSession,
      "-c", opts.cwd,
      verifierCommand,
    ]);
    return { tmuxSession, mode: "in-tmux", wrapperPath, stderrLogPath };
  }

  // ── NEW-OS-WINDOW BRANCH ───────────────────────────────────────────
  // Native terminal — user wants two visible terminal windows. Detached
  // tmux is the source of truth (survives window close, re-attachable
  // by sessionId); the OS window is just an attached client.
  // `-c <cwd>` and `-e KEY=VAL ...` mirror the in-tmux branch above:
  // verifier inherits builder's cwd and env.
  await execFileP("tmux", [
    "new-session",
    "-d",
    "-s", tmuxSession,
    "-c", opts.cwd,
    verifierCommand,
  ]);
  // Apply verifier-friendly tmux options scoped to THIS session only.
  // The in-tmux branch above leaves the user's existing session config
  // untouched on purpose; only sessions we create get our defaults.
  await applyVerifierTmuxOptions(tmuxSession);
  await openOsWindowAttachedTo(tmuxSession, opts.settings);
  return { tmuxSession, mode: "new-window", wrapperPath, stderrLogPath };
}

/**
 * Build a wrapper shell script that exports the calling process's env (minus
 * a small skip list) and exec's pi as the verifier child.
 *
 * Why a wrapper instead of `tmux -e KEY=VAL ...`:
 *   macOS's `exec*()` syscalls enforce ARG_MAX (~256KB combined argv + envp).
 *   With ~50 env vars (some kilobytes long like PATH and API keys) AND the
 *   ~10KB rendered system prompt embedded inline, the tmux command line
 *   easily blows ARG_MAX. The wrapper sidesteps it: file size doesn't count
 *   toward exec()'s argv limit, only the live argv passed to tmux does.
 *
 *   Tmux's command becomes simply `bash <wrapper>`. All the bulk lives in
 *   the file — env exports, system-prompt-from-tempfile, the pi invocation.
 *
 * Why every env var, not a curated subset: the verifier behaves exactly like
 * the builder for LLM/tool resolution. Any API key, locale, PATH addition,
 * or feature flag the user sets at the shell level needs to reach the
 * verifier. Filtering risks silently dropping something the verifier needs.
 *
 * Excluded keys: process-tied (`_`, `OLDPWD`, `PWD` — `-c` covers cwd) and
 * `TMUX*` (so the new session doesn't think it's nested in the parent tmux).
 */
interface BuildSpawnWrapperOpts {
  env: NodeJS.ProcessEnv;
  systemPromptFile: string;
  verifierEntry: string;
  sessionId: string;
  agentPath: string;
  /** Comma-separated tool list. Empty / `"*"` → omit `--tools` (pi defaults). */
  tools: string;
  /**
   * Persona's `model:` frontmatter value, passed to pi via `--model` so the
   * verifier child uses the persona-declared model regardless of what the
   * user's pi config has selected globally. Without this, a user running
   * deepseek-v4-pro as their default would get a deepseek verifier even when
   * the persona declares anthropic/claude-sonnet-4-6.
   */
  model: string;
  /**
   * File to capture pi's stderr into. The wrapper redirects stderr through
   * `tee`, so the file gets pi's actual error output (e.g. "model not
   * found: moonshot/kimi-k2.6") AND the tmux pane still shows it. The
   * builder reads this file when the spawn-hello timeout fires so the
   * surfaced system message names the real cause instead of just "didn't
   * connect in time."
   */
  stderrLogPath: string;
}

function buildSpawnWrapper(opts: BuildSpawnWrapperOpts): string {
  const skip = new Set(["_", "OLDPWD", "PWD"]);
  const exports: string[] = [];
  for (const [k, v] of Object.entries(opts.env)) {
    if (v === undefined) continue;
    if (skip.has(k)) continue;
    if (k.startsWith("TMUX")) continue; // don't leak parent tmux state
    // Skip identifiers shells can't validly export (e.g. with `(` or `=`).
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    exports.push(`export ${k}=${shellSingleQuote(v)}`);
  }

  const piArgs = [
    `-e ${shellSingleQuote(opts.verifierEntry)}`,
    "--child",
    `--builder-session ${shellSingleQuote(opts.sessionId)}`,
    `--agent ${shellSingleQuote(opts.agentPath)}`,
    `--system-prompt "$(cat ${shellSingleQuote(opts.systemPromptFile)})"`,
    `--model ${shellSingleQuote(opts.model)}`,
  ];
  if (opts.tools && opts.tools !== "*") {
    piArgs.push(`--tools ${shellSingleQuote(opts.tools)}`);
  }

  // Notes on the wrapper shape:
  //
  // - We deliberately do NOT use `set -e` and do NOT `exec` pi: we need
  //   lines past the `pi` invocation to run on a non-zero exit so we can
  //   record pi's exit code into the stderr log. With `set -e` + `exec`,
  //   the wrapper would die mid-pipeline and the builder's diagnosis
  //   would only ever see whatever pi flushed before the kill.
  //
  // - Stderr is redirected through `tee -a "$STDERR_LOG" >&2` (bash
  //   process substitution). That writes pi's stderr to the log file
  //   AND mirrors it back to fd 2, so anyone attached to the tmux pane
  //   still sees the error in real time. Stdout is left alone because
  //   pi's interactive TUI uses the terminal directly (ioctl on
  //   /dev/tty), and tee'ing stdout would mangle ANSI escape sequences.
  //
  // - Truncate the log on each spawn (`: > "$STDERR_LOG"`) so the
  //   builder doesn't surface a stale error from a previous run.
  return [
    "#!/usr/bin/env bash",
    "# Auto-generated by Pi Verifier launcher.ts.",
    "# Sets up env, runs the verifier pi child, captures stderr to a log.",
    "# Wrapped in a script so the tmux command line stays tiny (avoids",
    "# ARG_MAX on macOS with verbose env).",
    "",
    `STDERR_LOG=${shellSingleQuote(opts.stderrLogPath)}`,
    `: > "$STDERR_LOG"`,
    "",
    "# ─── Env (forwarded from the builder process) ────────────────────────",
    ...exports,
    "",
    "# ─── Run the verifier (capture stderr; mirror to terminal) ───────────",
    // Every piArg line gets a `\` continuation so the `2> >(tee ...)`
    // redirect on the next line attaches to THIS pi invocation rather
    // than starting a separate command. Without the continuation on the
    // last arg, bash would parse the redirect as its own statement and
    // the stderr capture would silently miss pi's actual output.
    "pi \\",
    ...piArgs.map((a) => `  ${a} \\`),
    `  2> >(tee -a "$STDERR_LOG" >&2)`,
    "",
    "EXIT_CODE=$?",
    `echo "" >> "$STDERR_LOG"`,
    `echo "[wrapper] pi exited with code $EXIT_CODE" >> "$STDERR_LOG"`,
    "exit $EXIT_CODE",
    "",
  ].join("\n");
}

/**
 * Apply verifier-friendly tmux options to a session WE just created.
 *
 * These are session-scoped — they don't leak into the user's other tmux
 * sessions. Each set-option call is best-effort; older tmux versions or
 * unrecognized options shouldn't block the spawn.
 *
 * Defaults chosen for engineer ergonomics:
 *   - mouse on:          scroll wheel scrolls scrollback, click selects panes.
 *   - status off:        hide tmux's bottom green status bar — the verifier's
 *                        own status chip already shows connection state, so
 *                        the tmux bar is just visual noise (and steals a row).
 *   - history-limit:     10000 lines instead of tmux's default 2000 — useful
 *                        when scrolling back across multiple verification cycles.
 *
 * Power users can override by setting `verifier.terminalCommand` in
 * `.pi/settings.json` to a template that pipes through their own tmux config,
 * or by editing this list.
 */
async function applyVerifierTmuxOptions(tmuxSession: string): Promise<void> {
  // Defaults chosen for engineer ergonomics:
  //   - mouse on:           scroll wheel + click-to-focus
  //   - status off:         hide the bottom green status bar (the verifier's
  //                         own footer + status bar already convey state)
  //   - history-limit:      10k lines (tmux default 2000 runs out fast)
  //   - set-clipboard on:   pushes mouse selections to the OS clipboard via
  //                         OSC52. Modern macOS terminals (iTerm, Ghostty,
  //                         Terminal.app, WezTerm) all support OSC52, so a
  //                         normal mouse-drag-to-select inside the verifier
  //                         pane Just Works for copy-paste — no need to
  //                         enter tmux copy-mode. Hold Option (macOS) /
  //                         Shift (some emulators) while dragging if you
  //                         want to bypass tmux mouse mode entirely for a
  //                         given selection (purely native terminal select).
  const opts: Array<[string, string]> = [
    ["mouse", "on"],
    ["status", "off"],
    ["history-limit", "10000"],
    ["set-clipboard", "on"],
  ];
  for (const [name, value] of opts) {
    try {
      await execFileP("tmux", ["set-option", "-t", tmuxSession, name, value]);
    } catch {
      // Non-fatal — older tmux may not recognize an option, or the
      // session might already be torn down. Don't block the spawn.
    }
  }
}

// ─── killVerifierChild ───────────────────────────────────────────────────────

/**
 * Best-effort teardown. Swallows "session/window not found" errors so it's
 * safe to call from `session_shutdown` regardless of whether the verifier
 * was ever spawned.
 */
export async function killVerifierChild(sessionId: string): Promise<void> {
  const tmuxSession = `verifier-${sessionId}`;
  if (process.env.TMUX) {
    // In-tmux mode: kill just the sibling window. The parent tmux session
    // (the one the user is in) keeps running.
    await tmuxSwallowMissing(["kill-window", "-t", tmuxSession]);
    return;
  }
  // New-OS-window mode: the entire detached session is ours to destroy.
  await tmuxSwallowMissing(["kill-session", "-t", tmuxSession]);
}

// ─── Verifier command construction ───────────────────────────────────────────
//
// (Previously a `buildVerifierCommand` helper inlined the pi invocation.
// Replaced by `buildSpawnWrapper` above — the wrapper-script approach keeps
// the tmux argv tiny, sidestepping macOS ARG_MAX. The command tmux runs is
// just `bash <wrapperPath>`; everything else lives inside the wrapper.)

/**
 * Normalize the persona's `tools:` frontmatter field into a comma-separated
 * string with no whitespace (matches Pi's `--tools` flag format), and ALWAYS
 * append `verifier_prompt` — that tool is registered by `verifier.ts` and is
 * the system-required transport for sending corrective feedback back to the
 * builder. Persona authors shouldn't have to remember to list it; if it's
 * missing from `--tools`, pi filters it out and the LLM sees "tool not
 * found" when the persona's body tells it to call `verifier_prompt`.
 *
 *   "read, grep, find, ls, bash"  →  "read,grep,find,ls,bash,verifier_prompt"
 *   "read"                        →  "read,verifier_prompt"
 *   ""                            →  "" (caller skips --tools entirely;
 *                                        pi defaults include the extension's
 *                                        tools, so verifier_prompt is visible)
 */
function normalizeToolsList(toolsField: string): string {
  const tools = toolsField
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tools.length === 0) return "";
  if (!tools.includes("verifier_prompt")) tools.push("verifier_prompt");
  return tools.join(",");
}

/**
 * POSIX single-quote shell escaping. Single-quote runs are literal in sh,
 * so we close, emit an escaped quote (`'\''`), and re-open. Result is a
 * single quoted token that round-trips any byte sequence except NUL.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ─── Idempotency helpers ─────────────────────────────────────────────────────

/**
 * Detect whether a verifier with this session name is already running.
 *
 * In-tmux mode: list windows in the current session; match on name.
 * Out-of-tmux mode: ask tmux whether a session by that name exists.
 *
 * Both forms swallow "no server" / "no such session" — those just mean
 * "not running yet", which is the happy-path spawn case.
 */
async function verifierAlreadyRunning(tmuxSession: string): Promise<boolean> {
  if (process.env.TMUX) {
    try {
      const { stdout } = await execFileP("tmux", ["list-windows", "-F", "#{window_name}"]);
      const names = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      return names.includes(tmuxSession);
    } catch {
      // No tmux server / not in a session we can list — treat as "not running".
      return false;
    }
  }
  try {
    await execFileP("tmux", ["has-session", "-t", tmuxSession]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxSwallowMissing(args: string[]): Promise<void> {
  try {
    await execFileP("tmux", args);
  } catch (cause) {
    const stderr =
      cause instanceof Error && "stderr" in cause ? String(cause.stderr).toLowerCase() : "";
    if (
      stderr.includes("can't find") ||
      stderr.includes("no such") ||
      stderr.includes("session not found") ||
      stderr.includes("window not found") ||
      stderr.includes("no server running")
    ) {
      return;
    }
    throw cause;
  }
}

// ─── OS-window dispatch (new-OS-window branch only) ──────────────────────────

/**
 * Open a visible OS-level terminal window attached to the given tmux session.
 *
 * Order of preference:
 *   1. settings.verifier.terminalCommand (template; `{cmd}` ← `tmux attach -t <session>`)
 *   2. macOS auto-detection by $TERM_PROGRAM
 *   3. Linux: $TERMINAL, then known emulators in PATH
 *   4. Fallback: print the manual `tmux attach` instruction (don't error)
 */
async function openOsWindowAttachedTo(
  tmuxSession: string,
  settings: SpawnOpts["settings"],
): Promise<void> {
  const attachCmd = `tmux attach -t ${tmuxSession}`;

  // 1. Settings override wins over auto-detection.
  const override = settings?.verifier?.terminalCommand;
  if (override && override.length > 0) {
    const expanded = override.replace(/\{cmd\}/g, attachCmd);
    // Run via `sh -c` so the user's template can use full shell syntax
    // (pipes, redirects, env-var expansion). This is the explicit escape
    // hatch — auto-detection tries to use `execFile` everywhere else.
    await execFileP("sh", ["-c", expanded]);
    return;
  }

  // 2. macOS dispatch.
  //
  // Strategy: try the user's $TERM_PROGRAM first (best UX when it works), then
  // ALWAYS fall through to Terminal.app via osascript. Terminal.app is
  // preinstalled on every macOS and `do script` reliably opens a visible
  // window — that's our "engineers can see this" guarantee.
  //
  // The per-emulator fast paths (Ghostty, WezTerm, etc.) are wrapped in
  // try/catch because their CLI args/behavior vary across versions; if they
  // throw OR if $TERM_PROGRAM is unknown (vscode, WarpTerminal, Hyper, …),
  // we fall through to Terminal.app. Power users who want their native
  // emulator can set `verifier.terminalCommand` in .pi/settings.json.
  if (process.platform === "darwin") {
    const term = process.env.TERM_PROGRAM;
    if (term && (await tryDispatchMacOS(term, attachCmd, tmuxSession))) {
      return;
    }
    // Universal fallback: Terminal.app via osascript. Always opens a visible
    // window so the verifier never runs headless.
    if (await tryOpenTerminalApp(attachCmd)) {
      return;
    }
    fallbackInstruction(tmuxSession);
    return;
  }

  // 3. Linux: $TERMINAL, then known emulators.
  if (process.platform === "linux") {
    const explicit = process.env.TERMINAL;
    if (explicit && (await commandExists(explicit))) {
      await spawnLinuxEmulator(explicit, attachCmd, tmuxSession);
      return;
    }
    for (const candidate of ["gnome-terminal", "konsole", "kitty", "alacritty", "xterm"]) {
      if (await commandExists(candidate)) {
        await spawnLinuxEmulator(candidate, attachCmd, tmuxSession);
        return;
      }
    }
    fallbackInstruction(tmuxSession);
    return;
  }

  // 4. Other platforms — no auto-detection, just print the instruction.
  fallbackInstruction(tmuxSession);
}

/**
 * Per-emulator argv shape on Linux. `gnome-terminal` and `konsole` use
 * `-e`/`--` conventions that are not universal — kitty/alacritty/xterm
 * accept the command after a literal `-e`.
 */
async function spawnLinuxEmulator(
  emulator: string,
  attachCmd: string,
  tmuxSession: string,
): Promise<void> {
  switch (path.basename(emulator)) {
    case "gnome-terminal":
      await execFileP(emulator, ["--", "tmux", "attach", "-t", tmuxSession]);
      return;
    case "konsole":
      await execFileP(emulator, ["-e", "tmux", "attach", "-t", tmuxSession]);
      return;
    case "kitty":
    case "alacritty":
    case "xterm":
      await execFileP(emulator, ["-e", "tmux", "attach", "-t", tmuxSession]);
      return;
    default:
      // Unknown $TERMINAL — assume it accepts `-e <cmd>` like xterm.
      await execFileP(emulator, ["-e", attachCmd]);
      return;
  }
}

/**
 * `which`-style lookup. Returns true iff `command` resolves to an
 * executable on the user's PATH.
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileP("sh", ["-c", `command -v ${shellSingleQuote(command)}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Last-resort: emit a manual-attach instruction. Don't throw — the
 * detached tmux session is already running and usable; we just couldn't
 * pop a window for the user.
 */
function fallbackInstruction(tmuxSession: string): void {
  process.stderr.write(
    `Verifier started in detached tmux session. Attach with: tmux attach -t ${tmuxSession}\n`,
  );
}

/**
 * Try to dispatch a new visible window for the user's detected $TERM_PROGRAM.
 * Each branch is wrapped in try/catch — if any throws (CLI flag mismatch, app
 * not installed, etc.), we return false so the caller falls through to the
 * Terminal.app universal fallback.
 *
 * Returns true if dispatch succeeded (no throw), false otherwise. Note: a
 * `true` return only means the spawned command exited 0; some emulators
 * (notably `open -na` against Ghostty) may exit 0 without actually opening a
 * window. That's documented in the SpawnOpts.settings.verifier.terminalCommand
 * escape hatch — set it explicitly if auto-detect doesn't open a window for
 * your emulator.
 */
async function tryDispatchMacOS(
  term: string,
  attachCmd: string,
  tmuxSession: string,
): Promise<boolean> {
  try {
    switch (term) {
      case "Apple_Terminal":
        await execFileP("osascript", [
          "-e",
          `tell application "Terminal"
             activate
             do script "${attachCmd}"
           end tell`,
        ]);
        return true;
      case "iTerm.app":
        await execFileP("osascript", [
          "-e",
          `tell application "iTerm"
             activate
             create window with default profile
             tell current session of current window to write text "${attachCmd}"
           end tell`,
        ]);
        return true;
      case "ghostty":
      case "Ghostty":
        // Prefer the `ghostty` CLI binary if available — most reliable across
        // versions. Falls back to `open -na` against the app bundle, which
        // works for some Ghostty builds and not others (caller falls through
        // to Terminal.app on failure either way).
        if (await commandExists("ghostty")) {
          await execFileP("ghostty", ["-e", attachCmd]);
        } else {
          await execFileP("open", ["-na", "Ghostty", "--args", "-e", attachCmd]);
        }
        return true;
      case "WezTerm":
        await execFileP("wezterm", [
          "cli",
          "spawn",
          "--new-window",
          "--",
          "tmux",
          "attach",
          "-t",
          tmuxSession,
        ]);
        return true;
      default:
        // Unknown $TERM_PROGRAM (vscode, WarpTerminal, Hyper, Tabby, …).
        // Don't try anything fancy — caller falls through to Terminal.app.
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Universal macOS fallback: open a Terminal.app window via AppleScript and
 * run the tmux attach command in it. Always works because Terminal.app is
 * preinstalled and `do script` is a stable AppleScript verb.
 *
 * Returns true on success. Caller falls through to printed instruction
 * only if even this fails (extremely unlikely on a working macOS).
 */
async function tryOpenTerminalApp(attachCmd: string): Promise<boolean> {
  try {
    await execFileP("osascript", [
      "-e",
      `tell application "Terminal"
         activate
         do script "${attachCmd}"
       end tell`,
    ]);
    return true;
  } catch {
    return false;
  }
}
