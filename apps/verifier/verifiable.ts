/**
 * Builder-side extension for the Pi Verifier Agent.
 *
 * Loaded via `pi -e ./apps/verifier/verifiable.ts`. Owns the unix-domain
 * socket SERVER side of the verifier IPC channel, spawns the verifier
 * child (in tmux), and forwards builder lifecycle ticks (`start`/`stop`/
 * `error`) over the socket. Receives `prompt` / `report` envelopes back
 * and routes them into the builder session via `pi.sendUserMessage` and
 * `pi.sendMessage` respectively.
 *
 * "Builder doesn't know the verifier exists" is enforced by minimizing
 * what we publish: only event ticks. The verifier pulls its own content
 * from the builder's session JSONL file. See `specs/PRE_INIT_DECISIONS.md`
 * Q2 for the full rationale.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  BuilderInputEditor,
  type ConnectionPhase as FooterConnectionPhase,
} from "./verifiable-footer.js";

import {
  type Envelope,
  type Prompt,
  type PromptAck,
  type Report,
  assertDirection,
  encodeEnvelope,
  isBye,
  isHello,
  isPing,
  isPong,
  isPrompt,
  isReport,
  readEnvelopes,
} from "./_shared/ipc.js";
import { loadDotEnv } from "./_shared/env.js";
import { parseVerifierPersona } from "./_shared/frontmatter.js";
import { killVerifierChild, spawnVerifierChild } from "./_shared/launcher.js";
import { cleanup, ensureSocketDir, resolveSocketPath } from "./_shared/socket-path.js";

// ─── Module-local state (closure-captured, not global) ───────────────────────

type ConnectionPhase = FooterConnectionPhase;

interface VerifiableState {
  phase: ConnectionPhase;
  sessionId: string;
  socketPath: string;
  refPath: string;
  socketServer: net.Server | null;
  verifierConn: net.Socket | null;
  pendingPongs: number;
  pingInterval: NodeJS.Timeout | null;
  pingNonces: Set<string>;
  pendingPromptAcks: Map<string, (ack: PromptAck) => void>;
  loopCount: number;
  maxLoops: number;
  lastReportRaw: string;
  attached: boolean;
  spawnInFlight: boolean;
  turnIndex: number;
  injectedNext: boolean;
  /** Resolved path to the builder's session JSONL — for turn-byte-offset capture. */
  sessionFilePath: string;
  /** Most recent NON-extension user prompt text (captured from input event). */
  lastUserPrompt: string;
  /** Line count at before_agent_start — start line of this turn's slice in the session JSONL. */
  turnStartLine: number;
  uncaughtListener: ((cause: unknown) => void) | null;
  unhandledListener: ((cause: unknown) => void) | null;
  /**
   * Bound `tui.requestRender` captured from the editor factory. Pi only
   * redraws on input by default — without nudging it, phase changes (e.g.
   * `connected` after `hello_ack`) don't reach the input-bar border until
   * the user types something. Call this after every `state.phase` mutation.
   */
  requestRender: (() => void) | null;
  /**
   * Timer that fires if the verifier child fails to send `hello` within
   * SPAWN_HELLO_TIMEOUT_MS. Without this, a child that crashes silently on
   * startup (e.g. invalid persona `model:` id, missing dependency, broken
   * tmux env) leaves the builder stuck on "spawning" forever. On fire, we
   * diagnose tmux session liveness and surface a system message in the
   * builder's chat so the operator can act. Cleared on hello receipt.
   */
  spawnTimeout: NodeJS.Timeout | null;
  /**
   * Path to the auto-generated wrapper script the launcher writes for the
   * current spawn. Stashed so the spawn-timeout diagnostic can tell the
   * user how to reproduce the spawn manually (`bash <wrapperPath>`) and
   * see pi's actual error directly.
   */
  spawnWrapperPath: string;
  /**
   * Path to the file the wrapper redirects pi's stderr into. Read on
   * spawn-timeout / verifier-died so the surfaced system message includes
   * pi's actual error output (e.g. `model "moonshot/kimi-k2.6" not found`).
   */
  spawnStderrLogPath: string;
}

/** How long to wait for the verifier child's `hello` before surfacing a diagnostic. */
const SPAWN_HELLO_TIMEOUT_MS = 3000;

export default function verifiable(pi: ExtensionAPI): void {
  const state: VerifiableState = {
    phase: "idle",
    sessionId: "",
    socketPath: "",
    refPath: "",
    socketServer: null,
    verifierConn: null,
    pendingPongs: 0,
    pingInterval: null,
    pingNonces: new Set<string>(),
    pendingPromptAcks: new Map<string, (ack: PromptAck) => void>(),
    loopCount: 0,
    maxLoops: 3,
    lastReportRaw: "",
    attached: false,
    spawnInFlight: false,
    turnIndex: 0,
    injectedNext: false,
    sessionFilePath: "",
    lastUserPrompt: "",
    turnStartLine: 0,
    uncaughtListener: null,
    unhandledListener: null,
    requestRender: null,
    spawnTimeout: null,
    spawnWrapperPath: "",
    spawnStderrLogPath: "",
  };

  // ─── Flag + slash command registration ────────────────────────────────

  pi.registerFlag("verifiable", {
    type: "boolean",
    description: "Auto-spawn verifier child on session_start",
  });

  pi.registerFlag("verifier-agent", {
    type: "string",
    description:
      "Persona name under .pi/verifier/agents/ (without .md). Default: verifier.",
  });

  pi.registerCommand("verify", {
    description: "Spawn the verifier (or report 'already attached')",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (state.attached) {
        safeNotify(ctx, "verifier already attached", "info");
        return;
      }
      await attach(ctx);
    },
  });

  // ─── Lifecycle wiring ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    state.sessionId = ctx.sessionManager.getSessionId();

    // Resolve the session JSONL path once. Used by start/stop event handlers
    // to capture per-turn byte offsets so the verifier can seek directly to
    // [start..end) in a potentially large session file instead of scanning.
    const sessionFile = ctx.sessionManager.getSessionFile();
    state.sessionFilePath =
      sessionFile ?? path.join(os.homedir(), ".pi/agent/sessions", `${state.sessionId}.jsonl`);

    // Load .env from the user's cwd into process.env BEFORE anything else.
    // Existing env vars are preserved (env-already-set wins); .env fills gaps.
    // The launcher forwards process.env to the verifier via tmux `-e`, so
    // whatever we load here propagates to the verifier child too.
    // Notify rule: silent on success (no news is good news); warn only when
    // we couldn't find OR couldn't parse the file — so a missing .env in a
    // project that expects one is visible.
    const envResult = await loadDotEnv(ctx.cwd);
    if (!envResult.loaded && envResult.reason) {
      safeNotify(ctx, `verifier: ${envResult.reason}`, "warning");
    }

    setFooter(ctx, "idle");

    // Replace pi's default input editor with one that embeds verifier
    // status / model / ctx info into the input box's border lines.
    // See `verifiable-footer.ts` and `ai_docs/pi/embed-text-in-ui-bar/`.
    if (ctx.hasUI) {
      ctx.ui.setEditorComponent(
        (tui, theme, kb) => {
          // Capture the TUI handle so we can nudge a re-render whenever
          // verifier-connection phase changes (otherwise the input-bar
          // border only refreshes on the next keystroke).
          state.requestRender = () => {
            try {
              tui.requestRender();
            } catch {
              // best-effort — pi may have torn down the TUI by now
            }
          };
          return new BuilderInputEditor(
            tui,
            theme,
            kb,
            {
              getPhase: () => state.phase,
              getSessionId: () => state.sessionId,
            },
            ctx,
          );
        },
      );

      // Hide pi's default footer entirely. The input-bar borders already
      // carry model + ctx % + verifier-status; pi's default footer (model +
      // thinking level + token stats) would just duplicate part of that and
      // add visual noise. setFooter(undefined) RESTORES the default; we
      // need to install a custom factory that renders zero lines to hide
      // it. Restored on session_shutdown.
      try {
        ctx.ui.setFooter(() => ({
          dispose: () => {},
          invalidate() {},
          render: () => [],
        }));
      } catch {
        // best-effort — non-critical
      }
    }

    if (pi.getFlag("verifiable")) {
      // Don't await — let the spawn happen in background. Failures are
      // surfaced via footer + notify; we don't want session_start to block.
      void attach(ctx);
    }
  });

  // Track the source of the most recent input so before_agent_start can
  // tell whether the upcoming agent run was triggered by a real user
  // prompt or by our own pi.sendUserMessage injection. The ExtensionAPI
  // does not propagate `source` onto BeforeAgentStartEvent directly, so
  // we capture it here.
  pi.on("input", async (event, _ctx) => {
    state.injectedNext = event.source === "extension";
    // Capture the user's prompt text for non-extension inputs so we can
    // forward it to the verifier on `start`/`stop`. The verifier uses this
    // to ground each verification cycle in the original ask without parsing
    // the session JSONL just to extract it.
    if (event.source !== "extension" && event.text) {
      state.lastUserPrompt = event.text;
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    try {
      if (state.injectedNext) {
        // Verifier-corrective turn — don't reset loopCount, don't fire
        // a `start` event. Clear the flag so the NEXT turn (if it's a
        // real user prompt) is treated normally.
        state.injectedNext = false;
        return;
      }

      // Genuine user prompt: fresh "verification cycle" begins here.
      state.loopCount = 0;
      state.turnIndex += 1;

      // Capture the session-file line count BEFORE pi appends this turn's
      // user message. Start of this turn = next line written = current
      // count + 1 (since pi will append the user message as the next line).
      // The verifier reads [startLine..endLine] on stop with pi's `read`
      // tool, no full-file scan needed.
      const linesBefore = await currentSessionFileLineCount(state.sessionFilePath);
      state.turnStartLine = linesBefore + 1;

      sendEnvelope({
        type: "event",
        name: "start",
        sessionId: state.sessionId,
        turnIndex: state.turnIndex,
        timestamp: Date.now(),
        userPrompt: state.lastUserPrompt,
        sessionFileStartLine: state.turnStartLine,
      });
    } catch (err) {
      reportEventError(err);
    }
  });

  pi.on("agent_end", async (_event, _ctx) => {
    try {
      // Capture the session-file line count NOW — pi has appended everything
      // for this turn. Slice [turnStartLine..endLine] is exactly this turn.
      const endLine = await currentSessionFileLineCount(state.sessionFilePath);

      sendEnvelope({
        type: "event",
        name: "stop",
        sessionId: state.sessionId,
        turnIndex: state.turnIndex,
        timestamp: Date.now(),
        userPrompt: state.lastUserPrompt,
        sessionFileStartLine: state.turnStartLine,
        sessionFileEndLine: endLine,
      });
    } catch (err) {
      reportEventError(err);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Restore pi's default editor + footer on shutdown so a subsequent
    // `pi -e ./apps/verifier/verifiable.ts` (without --verifiable) still
    // sees a clean baseline.
    if (ctx?.hasUI) {
      try {
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.setFooter(undefined);
      } catch {
        // ignore
      }
    }
    state.requestRender = null;
    clearSpawnTimeout();
    await detach();
  });

  // ─── Internal: attach() — the lifecycle entry point ───────────────────

  async function attach(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    if (state.attached || state.spawnInFlight) {
      safeNotify(ctx, "verifier already attached", "info");
      return;
    }
    state.spawnInFlight = true;
    state.phase = "spawning";
    setFooter(ctx, "spawning");

    try {
      // Resolve repo root from this file's location: apps/verifier/verifiable.ts
      // → repo root is three levels up.
      const here = fileURLToPath(import.meta.url);
      const runtimeRoot = path.resolve(path.dirname(here), "..", "..");

      // Persona — defaults to the generic `verifier`, overridable via the
      // --verifier-agent <name> launch flag. The flag value is the bare
      // persona name (no .md, no path); we resolve it under
      // .pi/verifier/agents/ relative to the project cwd.
      const agentNameRaw = pi.getFlag("verifier-agent");
      const agentName = agentNameRaw && agentNameRaw !== true ? agentNameRaw : "verifier";
      const agentPath = path.resolve(
        ctx.cwd,
        ".pi/verifier/agents",
        `${agentName}.md`,
      );

      // Pull max_loops from the persona before spawning so the builder-side
      // counter matches the verifier's authoritative limit.
      try {
        const personaContent = await fs.readFile(agentPath, "utf8");
        const { frontmatter } = parseVerifierPersona(personaContent);
        if (frontmatter.max_loops !== undefined && frontmatter.max_loops > 0) {
          state.maxLoops = frontmatter.max_loops;
        }
      } catch (cause) {
        // Persona is required for spawn; bail loudly via notify AND a
        // sticky system message so the user sees it in scrollback (not
        // just a transient toast).
        const msg = errMessage(cause);
        safeNotify(ctx, `verifier: failed to read persona at ${agentPath}: ${msg}`, "error");
        surfaceVerifierError(
          [
            `Could not load verifier persona at:`,
            `  ${agentPath}`,
            ``,
            `Reason: ${msg}`,
            ``,
            `Check that the file exists and the frontmatter is well-formed`,
            `(required: name, description, tools, model, domain).`,
          ].join("\n"),
        );
        state.phase = "error";
        setFooter(ctx, "error");
        state.spawnInFlight = false;
        return;
      }

      // Resolve the builder session file. Fall back to the conventional
      // location if the session manager doesn't expose one (in-memory
      // sessions, e.g. ephemeral RPC mode).
      const sessionFile = ctx.sessionManager.getSessionFile();
      const builderSessionFile =
        sessionFile ?? path.join(os.homedir(), ".pi/agent/sessions", `${state.sessionId}.jsonl`);

      // Resolve socket paths up-front so we can stash them on state for
      // cleanup, then bind the server before launching the child so the
      // child's `hello` always lands on a listening peer.
      const { socketPath, refPath } = resolveSocketPath(state.sessionId, ctx.cwd);
      state.socketPath = socketPath;
      state.refPath = refPath;

      await startSocketServer(ctx);

      // Launcher writes the breadcrumb + ensures /tmp/pi-verifier/.
      // Stash the artifact paths it returns so the spawn-timeout diagnostic
      // can read pi's actual stderr AND tell the user how to reproduce the
      // spawn manually (`bash <wrapperPath>`).
      try {
        const spawnResult = await spawnVerifierChild({
          sessionId: state.sessionId,
          agentPath,
          runtimeRoot,
          cwd: ctx.cwd,
          settings: undefined,
          builderSessionFile,
        });
        state.spawnWrapperPath = spawnResult.wrapperPath;
        state.spawnStderrLogPath = spawnResult.stderrLogPath;
      } catch (cause) {
        const msg = errMessage(cause);
        safeNotify(ctx, `verifier: launcher failed: ${msg}`, "error");
        surfaceVerifierError(
          [
            `Verifier launcher threw before tmux could start the child.`,
            ``,
            `Reason: ${msg}`,
            ``,
            `This usually means tmux isn't installed, the persona file is`,
            `unreadable, or the resolved socket path exceeds macOS's 104-byte`,
            `sun_path limit.`,
          ].join("\n"),
        );
        state.phase = "error";
        setFooter(ctx, "error");
        // Tear the server back down — no peer will ever connect.
        await stopSocketServer();
        state.spawnInFlight = false;
        return;
      }

      state.attached = true;
      // The verifier child has been spawned, but won't appear on the
      // socket until it sends `hello` — so the footer stays "spawning"
      // here. The dispatch handler flips it to "connected" on hello.
      setFooter(ctx, "spawning");
      installCrashForwarders();

      // Arm the spawn-hello timeout. If the child fails to come up cleanly
      // (most common cause: invalid `model:` in the persona — pi exits with
      // an "unknown model" error before binding the socket), the builder
      // would otherwise sit on "spawning" forever with no signal. Diagnose
      // on fire and surface a system message.
      armSpawnTimeout(ctx);
    } finally {
      state.spawnInFlight = false;
    }
  }

  // ─── Internal: socket server ──────────────────────────────────────────

  async function startSocketServer(ctx: ExtensionContext): Promise<void> {
    // Ensure /tmp/pi-verifier/ exists with 0700 perms BEFORE listen().
    // The launcher's spawnVerifierChild also calls this, but it runs after
    // we bind — and on macOS, listen() against a non-existent parent dir
    // returns EACCES (not ENOENT), which masks the real cause.
    await ensureSocketDir();

    // If a stale socket file is present (previous crash), unlink it so
    // listen() doesn't EADDRINUSE.
    try {
      await fs.unlink(state.socketPath);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
        // Permissions or other I/O — surface but keep going; listen()
        // will report the real error if any.
        safeNotify(ctx, 
          `verifier: failed to unlink stale socket: ${errMessage(cause)}`,
          "warning",
        );
      }
    }

    const server = net.createServer((conn) => handleConnection(conn, ctx));
    state.socketServer = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(state.socketPath);
    });
  }

  function handleConnection(conn: net.Socket, ctx: ExtensionContext): void {
    if (state.verifierConn) {
      // Only one verifier per builder. Refuse second connections.
      try {
        conn.write(encodeEnvelope({ type: "bye", reason: "duplicate connection" }));
      } catch {
        // ignore
      }
      conn.destroy();
      return;
    }
    state.verifierConn = conn;

    conn.on("close", () => {
      cleanupConnection(ctx);
    });
    conn.on("error", (err) => {
      safeNotify(ctx, `verifier: socket error: ${err.message}`, "warning");
    });

    void readEnvelopeLoop(conn, ctx);
  }

  async function readEnvelopeLoop(conn: net.Socket, ctx: ExtensionContext): Promise<void> {
    try {
      for await (const envelope of readEnvelopes(conn)) {
        try {
          assertDirection(envelope, "verifier-to-builder");
        } catch (cause) {
          safeNotify(ctx, `verifier: dropped envelope (${errMessage(cause)})`, "warning");
          continue;
        }
        try {
          await dispatch(envelope, conn, ctx);
        } catch (cause) {
          safeNotify(ctx, 
            `verifier: dispatch error on ${envelope.type}: ${errMessage(cause)}`,
            "warning",
          );
        }
      }
    } catch (cause) {
      // Parser errors (bad JSONL) end up here; log and let `close` fire.
      safeNotify(ctx, `verifier: read loop ended: ${errMessage(cause)}`, "warning");
    }
  }

  async function dispatch(
    envelope: Envelope,
    conn: net.Socket,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (isHello(envelope)) {
      conn.write(
        encodeEnvelope({ type: "hello_ack", sessionId: state.sessionId }),
      );
      // Hello arrived in time — disarm the diagnostic timer.
      clearSpawnTimeout();
      state.phase = "connected";
      setFooter(ctx, "connected");
      startLiveness(conn, ctx);
      return;
    }

    if (isPrompt(envelope)) {
      await handlePrompt(envelope, conn, ctx);
      return;
    }

    if (isReport(envelope)) {
      handleReport(envelope);
      return;
    }

    if (isPing(envelope)) {
      conn.write(encodeEnvelope({ type: "pong", nonce: envelope.nonce }));
      return;
    }

    if (isPong(envelope)) {
      state.pendingPongs = 0;
      state.pingNonces.delete(envelope.nonce);
      return;
    }

    if (isBye(envelope)) {
      safeNotify(ctx, `verifier: bye (${envelope.reason})`, "info");
      cleanupConnection(ctx);
      return;
    }

    // hello_ack / prompt_ack / event / pong on this side would already
    // have been rejected by assertDirection. Safety net:
    safeNotify(ctx, `verifier: unexpected envelope type "${envelope.type}"`, "warning");
  }

  async function handlePrompt(
    envelope: Prompt,
    conn: net.Socket,
    _ctx: ExtensionContext,
  ): Promise<void> {
    if (envelope.sessionId !== state.sessionId) {
      const ack: PromptAck = {
        type: "prompt_ack",
        sessionId: state.sessionId,
        correlationId: envelope.correlationId,
        ok: false,
        error: `sessionId mismatch (got ${envelope.sessionId}, expected ${state.sessionId})`,
      };
      conn.write(encodeEnvelope(ack));
      return;
    }

    state.loopCount += 1;

    if (state.loopCount > state.maxLoops) {
      const ack: PromptAck = {
        type: "prompt_ack",
        sessionId: state.sessionId,
        correlationId: envelope.correlationId,
        ok: false,
        error: "max loops exceeded",
      };
      conn.write(encodeEnvelope(ack));

      const escalation =
        `Verifier failed ${state.loopCount - 1} times — escalating to human.\n\n` +
        (state.lastReportRaw.length > 0
          ? `Latest report:\n\n${state.lastReportRaw}`
          : "(no report content captured)");
      // `deliverAs: "nextTurn"` so the escalation lands in the builder's
      // scrollback at a clean turn boundary — never interleaved between
      // the builder's tool calls mid-stream.
      pi.sendMessage(
        {
          customType: "verifier-escalation",
          content: escalation,
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
      return;
    }

    // Mark the upcoming injected message as extension-sourced so our
    // before_agent_start handler will skip resetting loopCount.
    state.injectedNext = true;
    try {
      pi.sendUserMessage(envelope.message, {
        deliverAs: envelope.deliverAs ?? "followUp",
      });
    } catch (cause) {
      // Roll back the flag; the injection failed.
      state.injectedNext = false;
      const ack: PromptAck = {
        type: "prompt_ack",
        sessionId: state.sessionId,
        correlationId: envelope.correlationId,
        ok: false,
        error: `sendUserMessage failed: ${errMessage(cause)}`,
      };
      conn.write(encodeEnvelope(ack));
      return;
    }

    const ack: PromptAck = {
      type: "prompt_ack",
      sessionId: state.sessionId,
      correlationId: envelope.correlationId,
      ok: true,
    };
    conn.write(encodeEnvelope(ack));
  }

  function handleReport(envelope: Report): void {
    // The verifier already renders its full `## Report` block in its own
    // window's scrollback. We intentionally do NOT echo it into the builder's
    // chat — engineers reading the builder pane don't want a duplicate of
    // what's already visible in the verifier window. We just stash the raw
    // text so the max-loops escalation path can include it inline.
    state.lastReportRaw = envelope.raw;
  }

  // ─── Internal: spawn diagnostic (failure path only) ───────────────────

  /**
   * Surface an inline system message in the builder's chat. Failure-path
   * only — the happy path (hello arrives in time) is silent because the
   * input-bar status already conveys "connected." Persistent in scrollback
   * (unlike `notify(...)` toasts) so the operator can scroll back and see
   * the error after looking away.
   */
  function surfaceVerifierError(content: string): void {
    try {
      // `deliverAs: "nextTurn"` so this lands in the builder's scrollback
      // for the operator to see WITHOUT interrupting whatever the builder
      // agent might currently be streaming. Default ("steer") would inject
      // between the builder's tool calls and pollute its context.
      pi.sendMessage(
        {
          customType: "verifier-error",
          content,
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
    } catch {
      // best-effort — fall back to stderr if pi's send path is broken
      process.stderr.write(`[verifier-error]\n${content}\n`);
    }
  }

  function armSpawnTimeout(ctx: ExtensionContext): void {
    clearSpawnTimeout();
    state.spawnTimeout = setTimeout(() => {
      // Re-check inside the firing closure — phase may have transitioned
      // out of `spawning` between when we armed and when we fire.
      if (state.phase !== "spawning") return;
      void diagnoseSpawnFailure(ctx);
    }, SPAWN_HELLO_TIMEOUT_MS);
  }

  function clearSpawnTimeout(): void {
    if (state.spawnTimeout) {
      clearTimeout(state.spawnTimeout);
      state.spawnTimeout = null;
    }
  }

  /**
   * The verifier child failed to send `hello` within the timeout. Read the
   * captured stderr (the wrapper redirects pi's stderr to a log file via
   * `tee`), check tmux liveness, and surface a system message that names
   * pi's actual error — not a generic timeout. Reset state so the user
   * can retry via `/verify`.
   */
  async function diagnoseSpawnFailure(ctx: ExtensionContext): Promise<void> {
    const tmuxSession = `verifier-${state.sessionId}`;
    let alive = false;
    try {
      await execFileP("tmux", ["has-session", "-t", tmuxSession]);
      alive = true;
    } catch {
      alive = false;
    }

    const stderrTail = await readStderrTail(state.spawnStderrLogPath);

    const sections: string[] = [];
    if (alive) {
      sections.push(
        `Verifier did not connect within ${SPAWN_HELLO_TIMEOUT_MS / 1000}s.`,
        ``,
        `The tmux session \`${tmuxSession}\` is still alive — pi is running`,
        `but never reached the socket-connect path. Likely cause: the verifier`,
        `extension threw before \`net.createConnection\`, OR the socket dir`,
        `permissions changed.`,
      );
    } else {
      sections.push(
        `Verifier child died before connecting.`,
        ``,
        `The tmux session \`${tmuxSession}\` is gone — pi exited shortly`,
        `after spawn. The captured stderr below should name the cause.`,
      );
    }

    if (stderrTail) {
      sections.push(``, `── pi stderr (tail) ──`, stderrTail.trimEnd());
    } else {
      sections.push(
        ``,
        `── pi stderr ──`,
        `(no stderr captured — log at ${state.spawnStderrLogPath} is empty or unreadable)`,
      );
    }

    sections.push(
      ``,
      `Reproduce manually:  bash ${state.spawnWrapperPath}`,
    );

    surfaceVerifierError(sections.join("\n"));

    state.phase = "error";
    state.attached = false;
    setFooter(ctx, "error");
    removeCrashForwarders();
    await stopSocketServer().catch(() => undefined);
    // Best-effort kill of any straggler tmux session (no-op if already gone).
    void killVerifierChild(state.sessionId).catch(() => undefined);
  }

  /**
   * Read the tail of the wrapper's stderr log, capped to keep the system
   * message readable. Returns "" if the file is missing/empty/unreadable —
   * the caller surfaces a fallback note in that case.
   *
   * 4 KB / 60 lines is enough for pi's typical "model not found" / import
   * traceback / argparse error without flooding the chat. The wrapper
   * truncates the log on each spawn so we never serve up stale content
   * from a previous run.
   */
  async function readStderrTail(logPath: string): Promise<string> {
    if (!logPath) return "";
    try {
      const buf = await fs.readFile(logPath, "utf8");
      if (!buf) return "";
      const MAX_BYTES = 4096;
      const MAX_LINES = 60;
      let tail = buf.length > MAX_BYTES ? buf.slice(buf.length - MAX_BYTES) : buf;
      const lines = tail.split("\n");
      if (lines.length > MAX_LINES) {
        tail = lines.slice(lines.length - MAX_LINES).join("\n");
      }
      return tail;
    } catch {
      return "";
    }
  }

  // ─── Internal: liveness ───────────────────────────────────────────────

  function startLiveness(conn: net.Socket, ctx: ExtensionContext): void {
    if (state.pingInterval) return;
    state.pingInterval = setInterval(() => {
      sendPing(conn, ctx);
    }, 10_000);
  }

  function sendPing(conn: net.Socket, ctx: ExtensionContext): void {
    if (state.verifierConn !== conn || conn.destroyed) {
      stopLiveness();
      return;
    }
    const nonce = randomUUID();
    state.pingNonces.add(nonce);

    try {
      conn.write(encodeEnvelope({ type: "ping", nonce }));
    } catch {
      // write failed — the close handler will tear down state.
      return;
    }

    setTimeout(() => {
      if (state.pingNonces.has(nonce)) {
        state.pingNonces.delete(nonce);
        state.pendingPongs += 1;
        if (state.pendingPongs >= 2) {
          safeNotify(ctx, "verifier: 2 missed pongs — declaring dead", "warning");
          declareDead(ctx);
        }
      }
    }, 10_000);
  }

  function stopLiveness(): void {
    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = null;
    }
    state.pingNonces.clear();
    state.pendingPongs = 0;
  }

  function declareDead(ctx: ExtensionContext): void {
    stopLiveness();
    if (state.verifierConn) {
      try {
        state.verifierConn.destroy();
      } catch {
        // ignore
      }
    }
    void killVerifierChild(state.sessionId).catch(() => undefined);
    state.phase = "disconnected";
    state.attached = false;
    state.verifierConn = null;
    removeCrashForwarders();
    setFooter(ctx, "disconnected");
  }

  function cleanupConnection(ctx: ExtensionContext): void {
    stopLiveness();
    state.verifierConn = null;
    state.attached = false;
    state.phase = "disconnected";
    removeCrashForwarders();
    setFooter(ctx, "disconnected");
  }

  // ─── Internal: detach (session_shutdown teardown) ─────────────────────

  async function detach(): Promise<void> {
    if (state.verifierConn) {
      try {
        state.verifierConn.write(
          encodeEnvelope({ type: "bye", reason: "session_shutdown" }),
        );
      } catch {
        // ignore
      }
    }
    stopLiveness();

    if (state.verifierConn) {
      try {
        state.verifierConn.end();
      } catch {
        // ignore
      }
      state.verifierConn = null;
    }

    await stopSocketServer();

    if (state.socketPath && state.refPath) {
      try {
        await cleanup(state.socketPath, state.refPath);
      } catch {
        // best-effort
      }
    }

    try {
      await killVerifierChild(state.sessionId);
    } catch {
      // best-effort
    }

    state.attached = false;
    state.phase = "disconnected";
    removeCrashForwarders();
  }

  async function stopSocketServer(): Promise<void> {
    const server = state.socketServer;
    if (!server) return;
    state.socketServer = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  // ─── Internal: crash forwarders (only while attached) ─────────────────

  function installCrashForwarders(): void {
    if (state.uncaughtListener || state.unhandledListener) return;
    const onUncaught = (cause: unknown): void => {
      sendEnvelope({
        type: "event",
        name: "error",
        sessionId: state.sessionId,
        detail: errMessage(cause),
        timestamp: Date.now(),
      });
    };
    const onUnhandled = (cause: unknown): void => {
      sendEnvelope({
        type: "event",
        name: "error",
        sessionId: state.sessionId,
        detail: errMessage(cause),
        timestamp: Date.now(),
      });
    };
    state.uncaughtListener = onUncaught;
    state.unhandledListener = onUnhandled;
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);
  }

  function removeCrashForwarders(): void {
    if (state.uncaughtListener) {
      process.removeListener("uncaughtException", state.uncaughtListener);
      state.uncaughtListener = null;
    }
    if (state.unhandledListener) {
      process.removeListener("unhandledRejection", state.unhandledListener);
      state.unhandledListener = null;
    }
  }

  function reportEventError(cause: unknown): void {
    sendEnvelope({
      type: "event",
      name: "error",
      sessionId: state.sessionId,
      detail: errMessage(cause),
      timestamp: Date.now(),
    });
  }

  /**
   * Notify the user via ctx.ui.notify if possible; otherwise fall back to
   * stderr. The captured ctx from `session_start` can become stale across
   * async boundaries (pi marks it stale on internal session replacement),
   * so we never let a notify call crash the verifier — the message is more
   * important than the channel.
   */
  function safeNotify(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void {
    try {
      ctx.ui.notify(message, level);
    } catch {
      const prefix = level === "error" ? "ERROR" : level === "warning" ? "WARN" : "INFO";
      process.stderr.write(`[${prefix}] ${message}\n`);
    }
  }

  // ─── Internal: low-level send ─────────────────────────────────────────

  function sendEnvelope(envelope: Envelope): void {
    const conn = state.verifierConn;
    if (!conn || conn.destroyed) return;
    try {
      assertDirection(envelope, "builder-to-verifier");
    } catch {
      // Programming error — silently drop rather than crash the builder.
      return;
    }
    try {
      conn.write(encodeEnvelope(envelope));
    } catch {
      // ignore — close handler will clean up
    }
  }

  // ─── Internal: footer rendering ───────────────────────────────────────

  /**
   * Update the verifier-connection phase. Was named `setFooter` historically
   * because it used to ALSO install a bottom-of-screen custom footer that
   * showed the same info. The footer was redundant once the input-bar
   * border embedding (BuilderInputEditor) started rendering model / ctx %
   * / verifier-state on the editor's borders directly — we dropped the
   * footer install to avoid the duplicate display.
   *
   * The editor's `render()` reads `state.phase` on every TUI tick, so a
   * bare state mutation is enough to trigger the visual refresh — we don't
   * need to nudge pi explicitly.
   */
  function setFooter(
    _ctx: ExtensionContext,
    label: ConnectionPhase,
  ): void {
    state.phase = label;
    // Nudge pi to re-render so the input-bar border picks up the new phase
    // immediately. Without this, the border keeps showing the prior phase
    // (e.g. `spawning`) until the user types something.
    state.requestRender?.();
  }

  /**
   * Return the current line count of the builder's session JSONL file.
   * 0 if the file doesn't exist yet (pi creates it on first write — for the
   * very first turn, before_agent_start may fire before the file exists).
   * Errors propagate as 0 rather than throwing — losing the line offset is
   * preferable to crashing the lifecycle event handler. The verifier
   * tolerates 0 by falling back to a full-file read.
   *
   * For typical session sizes (KB-MB) this is negligible cost; for sessions
   * that grow into hundreds of MB, consider a streaming line counter or
   * caching the last-known count and counting only NEW bytes.
   */
  async function currentSessionFileLineCount(sessionPath: string): Promise<number> {
    if (!sessionPath) return 0;
    try {
      const buf = await fs.readFile(sessionPath);
      // Count `\n` bytes. JSONL entries always end with a newline (pi
      // appends one), so this gives us the number of complete lines.
      let count = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a /* \n */) count++;
      }
      return count;
    } catch {
      return 0;
    }
  }

  function errMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return JSON.stringify(cause) ?? String(cause);
  }
}
