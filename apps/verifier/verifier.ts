/**
 * Pi Verifier Agent — verifier-side extension.
 *
 * Loaded into the *child* Pi instance that runs inside the tmux window the
 * launcher created. The default-export factory is invoked by Pi at startup
 * with `pi -e ./apps/verifier/verifier.ts --child --builder-session <sid>
 * --agent <path> --system-prompt <rendered>`.
 *
 * Responsibilities:
 *
 *   1. Replace the input editor with a colored full-width status bar
 *      (`VerifierStatusBar`) that swallows typing but preserves operational
 *      shortcuts (Esc, Ctrl+D, model switch). Defense-in-depth `pi.on("input")`
 *      blocks any non-extension-source input that slips through.
 *
 *   2. Connect over the unix domain socket the builder bound at
 *      `/tmp/pi-verifier/<sid>.sock`. Send `hello`, await `hello_ack`, then
 *      stream `event` envelopes (start / stop / error) back from the builder.
 *
 *   3. Drive the local verifier agent: on every `event { name: "stop" }`,
 *      template `.pi/verifier/prompts/verify_on_stop.md` and inject it via
 *      `pi.sendUserMessage(...)` (extension-source — passes our input lock).
 *
 *   4. Expose the `verifier_prompt` tool — the only thing the local agent
 *      can use to push corrective feedback back to the builder. It writes a
 *      `prompt` envelope and awaits the matching `prompt_ack` (60s timeout).
 *
 *   5. On the verifier's own `agent_end`, parse the last assistant message's
 *      `## Report` block and ship it back to the builder as a `report`
 *      envelope. Update the status bar phase based on STATUS line.
 *
 *   6. Liveness: 10s ping interval; 2 missed pongs → exit cleanly so the
 *      tmux window goes away when the parent dies.
 *
 * NOT this file's job:
 *   - Templating the system prompt (the launcher does that before spawn).
 *   - Spawning anything (we're the spawnee).
 *   - Reading the builder's session JSONL (the persona body tells the agent
 *     to do that via the `read` tool — the extension only carries the
 *     transport).
 */

import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { loadDotEnv } from "./_shared/env.js";
import { parseVerifierPersona, templateBody } from "./_shared/frontmatter.js";
import {
  assertDirection,
  encodeEnvelope,
  readEnvelopes,
  type Confidence,
  type Envelope,
  type Event as BuilderEvent,
  type Hello,
  type Ping,
  type Pong,
  type Prompt,
  type PromptAck,
  type Report,
} from "./_shared/ipc.js";
import { resolveSocketPath } from "./_shared/socket-path.js";

// ─── Module state ────────────────────────────────────────────────────────────

type Phase =
  | "connecting"
  | "connected"
  | "verifying"
  | "verified"
  | "failed"
  | "unsure"
  | "error"
  | "disconnected";

interface ParsedReport {
  status: "verified" | "failed" | "unsure";
  /**
   * Confidence ladder grade (highest → lowest):
   *   PERFECT  — every claim verified, zero unverifiable, zero feedback   (green)
   *   VERIFIED — all checked passed; minor non-blocking gaps allowed       (green)
   *   PARTIAL  — no failures but significant unverifiable gaps              (orange)
   *   UNSURE   — couldn't verify enough to judge; escalating                (orange)
   *   FAILED   — at least one claim failed; verifier_prompt called          (red)
   * Defaults to a status-derived value if the agent omits the CONFIDENCE: line.
   */
  confidence: Confidence;
  summary: string;
  sections: Record<string, string>;
}

interface VerifierState {
  phase: Phase;
  builderSessionId: string;
  socketPath: string;
  parentConn: net.Socket | null;
  agentPath: string;
  /**
   * Persona file name (basename of agentPath, no `.md`, UPPERCASED). Rendered
   * as the left segment of the status bar so it's obvious WHICH persona is
   * driving this verifier. Empty string until session_start populates it.
   */
  personaName: string;
  maxLoops: number;
  currentTurnIndex: number;
  /** Last error detail surfaced from a builder `event { name: "error" }`. */
  errorDetail: string;
  /** ms epoch of last inbound traffic — drives "last ack <n>ms ago" footer. */
  lastAckTimestamp: number;
  pingInterval: NodeJS.Timeout | null;
  pendingPongs: number;
  pendingPromptAcks: Map<string, (ack: PromptAck) => void>;
  /** True if `verifier_prompt` was called during the current verification cycle. */
  promptedThisCycle: boolean;
  /**
   * Confidence grade from the most recent Report. Drives the status-bar
   * background color (green / orange / red). `null` means we haven't received
   * a Report yet (idle, connecting, or mid-verifying on the first turn).
   */
  confidence: Confidence | null;
  /** Reference to the live UI ctx so the status bar can re-render on phase changes. */
  uiCtx: ExtensionContext | null;
  /** Set once the `connecting` → `connected` transition has been observed. */
  helloAcked: boolean;
  /** Suppress cleanup re-entry on shutdown. */
  shuttingDown: boolean;
}

const state: VerifierState = {
  phase: "connecting",
  builderSessionId: "",
  socketPath: "",
  parentConn: null,
  agentPath: "",
  personaName: "",
  maxLoops: 3,
  currentTurnIndex: 0,
  errorDetail: "",
  lastAckTimestamp: 0,
  pingInterval: null,
  pendingPongs: 0,
  pendingPromptAcks: new Map(),
  promptedThisCycle: false,
  confidence: null,
  uiCtx: null,
  helloAcked: false,
  shuttingDown: false,
};

// ─── Status-bar helpers (copied verbatim from full-bar-editor.ts) ────────────
//
// These two helpers implement ASCII-safe truncation + width padding for a
// three-segment status bar. Copied verbatim from
// `ai_docs/pi/hide-ui-bar/full-bar-editor.ts`. Do not modify.

function truncateAscii(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return text.slice(0, width - 1) + "…";
}

function fullWidthAsciiBar(width: number, left: string, center: string, right: string): string {
  if (width <= 0) return "";

  // Keep this ASCII/simple-width for reliability. Apply ANSI styling only after
  // the raw line has been padded to exactly `width` cells.
  const minGap = " ";
  const fixedRight = right;
  const fixedCenter = center;

  let availableForLeft = width - fixedCenter.length - fixedRight.length - minGap.length * 2;
  if (availableForLeft < 0) availableForLeft = 0;

  const safeLeft = truncateAscii(left, availableForLeft);
  let raw = safeLeft + minGap + fixedCenter + minGap + fixedRight;

  if (raw.length > width) raw = truncateAscii(raw, width);
  if (raw.length < width) raw = raw + " ".repeat(width - raw.length);

  return raw;
}

// ─── Phase formatting ────────────────────────────────────────────────────────

function formatPhase(phase: Phase): string {
  switch (phase) {
    case "connecting":
      return "◌ connecting...";
    case "connected":
      return "● connected to builder";
    case "verifying":
      return "… verifying...";
    case "verified":
      return "✓ verified";
    case "failed":
      return state.promptedThisCycle
        ? "✗ failed · prompted builder"
        : "✗ failed";
    case "unsure":
      return "⚠ unsure";
    case "error":
      return `⚠ builder error: ${truncateAscii(state.errorDetail || "(no detail)", 40)}`;
    case "disconnected":
      return "✗ socket dropped — exiting in 5s";
  }
}

function ageMs(timestamp: number): number {
  if (!timestamp) return 0;
  return Math.max(0, Date.now() - timestamp);
}

function shortSid(sid: string): string {
  return sid.length <= 8 ? sid : `${sid.slice(0, 8)}...`;
}

/**
 * Pick a background color (ANSI 256) for the verifier status bar based on the
 * confidence grade from the most recent Report. Falls back to purple while
 * idle / connecting / verifying — i.e. before any Report has come in, OR if
 * the verifier is mid-cycle on a new turn (we keep the prior color until the
 * new Report lands, but reset to purple while actively verifying so the user
 * can tell something's in flight).
 *
 *   PERFECT / VERIFIED → green   (success)
 *   PARTIAL / FEEDBACK → orange  (working as designed, intermediate state)
 *   FAILED             → red     (verifier itself stuck; escalation needed)
 */
function bgForConfidence(confidence: Confidence | null, phase: Phase): string {
  // While actively running a verification cycle, show purple — the prior
  // confidence isn't "current" anymore. The bar will switch to the verdict
  // color when agent_end fires and the Report is parsed.
  if (phase === "verifying") return "\x1b[48;5;57m"; // purple
  if (phase === "connecting" || phase === "disconnected" || phase === "error") {
    return "\x1b[48;5;57m"; // purple — also for transient/error states
  }
  switch (confidence) {
    case "perfect":
    case "verified":
      return "\x1b[48;5;28m"; // green
    case "partial":
    case "feedback":
      return "\x1b[48;5;130m"; // orange
    case "failed":
      return "\x1b[48;5;124m"; // red
    default:
      return "\x1b[48;5;57m"; // purple — null / no Report yet
  }
}

// ─── VerifierStatusBar ───────────────────────────────────────────────────────

class VerifierStatusBar extends CustomEditor {
  override render(width: number): string[] {
    // Minimal bar — persona name (so it's obvious which agent is loaded),
    // the live phase, and the confidence grade (if a Report has come in).
    // Model/ctx live in the footer; sid is omitted; the input lock is
    // enforced architecturally so we don't need a visual cue.
    const left = ` ${state.personaName || "VERIFIER"} `;
    const phase = formatPhase(state.phase);
    const conf = state.confidence
      ? ` · ${state.confidence.toUpperCase()}`
      : "";
    const center = ` ${phase}${conf} `;
    const right = " ";

    const raw = fullWidthAsciiBar(width, left, center, right);

    // Background color reflects the verifier's confidence grade — green for
    // PERFECT/VERIFIED, orange for PARTIAL/UNSURE, red for FAILED, and the
    // default purple while idle/connecting/verifying (no Report yet).
    const bg = bgForConfidence(state.confidence, state.phase);
    const fgWhite = "\x1b[38;5;231m";
    const bold = "\x1b[1m";
    const reset = "\x1b[0m";

    return [`${bg}${fgWhite}${bold}${raw}${reset}`];
  }

  override handleInput(data: string): void {
    // The CustomEditor base class declares `keybindings` as private, so we
    // reach through `unknown`/`any` here to use it the same way the reference
    // editor does. This is intentional: we are deliberately mirroring the
    // shortcut-preservation logic from `full-bar-editor.ts` verbatim.
    const self = this as unknown as {
      keybindings: { matches(data: string, action: string): boolean };
    };

    // Preserve extension shortcuts.
    if (this.onExtensionShortcut?.(data)) return;

    // Preserve paste-image shortcut if configured.
    if (self.keybindings.matches(data, "app.clipboard.pasteImage")) {
      this.onPasteImage?.();
      return;
    }

    // Preserve Escape / interrupt.
    if (self.keybindings.matches(data, "app.interrupt")) {
      if (!this.isShowingAutocomplete()) {
        const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
        if (handler) {
          handler();
          return;
        }
      }
      super.handleInput(data);
      return;
    }

    // Preserve Ctrl+D / exit when empty.
    if (self.keybindings.matches(data, "app.exit")) {
      if (this.getText().length === 0) {
        const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
        if (handler) handler();
      }
      return;
    }

    // Preserve other app-level actions, such as model switch shortcuts.
    for (const [action, handler] of this.actionHandlers) {
      if (
        action !== "app.interrupt" &&
        action !== "app.exit" &&
        self.keybindings.matches(data, action)
      ) {
        handler();
        return;
      }
    }

    // Swallow all normal typing/Enter/etc. This is not an input field anymore.
  }
}

// ─── Default factory ─────────────────────────────────────────────────────────

export default function verifierExtension(pi: ExtensionAPI): void {
  pi.registerFlag("child", {
    type: "boolean",
    description: "Run as verifier child",
  });
  pi.registerFlag("builder-session", {
    type: "string",
    description: "Builder session ID to attach to",
  });
  pi.registerFlag("agent", {
    type: "string",
    description: "Path to verifier persona file",
  });

  // Render the `🪝 builder event ...` system messages we emit on every
  // received `event` envelope. Single-line, faded, ANSI-aware truncation
  // is handled by `Text` itself.
  pi.registerMessageRenderer("builder-event", (message, _options, theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("");
    return new Text(theme.fg("muted", content), 0, 0);
  });

  // ── verifier_prompt tool ─────────────────────────────────────────────────
  // The agent's only outbound channel back to the builder. Writes a
  // `prompt` envelope to the parent socket and awaits the matching
  // `prompt_ack` by `correlationId`. 60s timeout in case the builder is
  // hung; the agent treats a timeout as a genuine failure.
  pi.registerTool({
    name: "verifier_prompt",
    label: "Verifier Prompt",
    description:
      "Send a corrective user-style prompt to the builder agent. Use this to " +
      "request a follow-up action when verification fails. The message is " +
      "delivered to the builder via pi.sendUserMessage.",
    promptSnippet:
      "Send a corrective prompt to the builder when verification fails.",
    parameters: Type.Object({
      session_id: Type.String({
        description:
          "Builder session id (uuid). Use the value from your system Variables; never invent.",
      }),
      message: Type.String({
        description:
          "User-style corrective prompt to inject into the builder. Be specific and actionable.",
      }),
      deliver_as: Type.Optional(
        Type.Union([Type.Literal("followUp"), Type.Literal("steer")]),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!state.parentConn || state.parentConn.destroyed) {
        return {
          content: [
            {
              type: "text",
              text:
                "✗ verifier_prompt rejected: not connected to builder (socket closed). " +
                "Cannot deliver corrective prompt right now.",
            },
          ],
          details: { ok: false, reason: "socket_closed" },
        };
      }

      const correlationId = crypto.randomUUID();
      const envelope: Prompt = {
        type: "prompt",
        sessionId: params.session_id,
        message: params.message,
        deliverAs: params.deliver_as ?? "followUp",
        correlationId,
      };

      // Set up the ack waiter before writing — the parent could in
      // principle reply faster than the next event-loop tick on a hot
      // local socket.
      const ackPromise = new Promise<PromptAck>((resolve, reject) => {
        const timeout = setTimeout(() => {
          state.pendingPromptAcks.delete(correlationId);
          reject(new Error("prompt_ack timeout (60s) — builder did not respond"));
        }, 60_000);

        state.pendingPromptAcks.set(correlationId, (ack) => {
          clearTimeout(timeout);
          resolve(ack);
        });
      });

      try {
        assertDirection(envelope, "verifier-to-builder");
        state.parentConn.write(encodeEnvelope(envelope));
      } catch (err) {
        state.pendingPromptAcks.delete(correlationId);
        return {
          content: [
            {
              type: "text",
              text: `✗ verifier_prompt failed to send: ${(err as Error).message}`,
            },
          ],
          details: { ok: false, reason: "write_failed", correlationId },
        };
      }

      try {
        const ack = await ackPromise;
        // Mark the cycle so the status bar can show "prompted builder" on
        // the subsequent `failed` phase.
        state.promptedThisCycle = true;
        return {
          content: [
            {
              type: "text",
              text: ack.ok
                ? `✓ ack: prompt delivered to builder`
                : `✗ rejected: ${ack.error ?? "(no reason given)"}`,
            },
          ],
          details: { correlationId, ok: ack.ok, error: ack.error },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `✗ verifier_prompt failed: ${(err as Error).message}` },
          ],
          details: { ok: false, reason: "timeout", correlationId },
        };
      }
    },
  });

  // ── Defense-in-depth input lock (Q7) ─────────────────────────────────────
  // Block any input event that didn't originate from `pi.sendUserMessage`
  // (extension source). The CustomEditor swallows typing already; this is
  // belt-and-suspenders for RPC clients and other surprise sources.
  pi.on("input", async (event: InputEvent, ctx): Promise<InputEventResult> => {
    if (event.source === "extension") return { action: "continue" };
    ctx.ui.notify(
      "Verifier input is disabled — driven by builder events only.",
      "warning",
    );
    return { action: "handled" };
  });

  // ── Verifier's own agent_end → emit Report envelope ──────────────────────
  pi.on("agent_end", async (_event: AgentEndEvent, ctx) => {
    if (!state.parentConn || state.parentConn.destroyed) return;

    // Pull the most recent assistant message text out of the session.
    const entries = ctx.sessionManager.getEntries();
    let raw = "";
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "assistant") continue;
      raw = extractAssistantText(msg.content);
      break;
    }
    if (!raw) {
      // No assistant text at all — nothing to report on.
      state.phase = "error";
      state.errorDetail = "no assistant message";
      requestStatusRender(ctx);
      return;
    }

    const report = parseReport(raw, state.currentTurnIndex);
    if (!report) {
      // Couldn't find a `## Report` block — surface the failure but don't
      // crash. The builder-side won't get a `report` envelope, which is the
      // signal that something went wrong.
      state.phase = "error";
      state.errorDetail = "report parse failed";
      requestStatusRender(ctx);
      return;
    }

    state.phase =
      report.status === "verified"
        ? "verified"
        : report.status === "failed"
          ? "failed"
          : "unsure";
    state.confidence = report.confidence; // drives the bar's bg color
    requestStatusRender(ctx);

    const envelope: Report = {
      type: "report",
      sessionId: state.builderSessionId,
      turnIndex: state.currentTurnIndex,
      status: report.status,
      confidence: report.confidence,
      summary: report.summary,
      sections: report.sections,
      raw,
    };
    try {
      assertDirection(envelope, "verifier-to-builder");
      state.parentConn.write(encodeEnvelope(envelope));
    } catch (err) {
      ctx.ui.notify(
        `verifier: failed to send report envelope: ${(err as Error).message}`,
        "error",
      );
    }
  });

  // ── session_start: validate flags, install editor, connect socket ────────
  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    // No-op when the file is loaded standalone (without --child). Lets us
    // share the same extension on the builder PATH without side effects.
    if (!pi.getFlag("child")) return;

    state.uiCtx = ctx;

    // Defensive .env load. The launcher already forwards env from the builder
    // via tmux `-e`, but if the user starts the verifier manually (or tmux
    // strips something), `.env` from this cwd backfills any missing vars.
    // Existing process.env values win — we only fill gaps.
    // Notify rule: silent on success; warn only when missing or unparseable.
    const envResult = await loadDotEnv(ctx.cwd);
    if (!envResult.loaded && envResult.reason) {
      ctx.ui.notify(`verifier: ${envResult.reason}`, "warning");
    }

    const builderSession = pi.getFlag("builder-session");
    const agentPath = pi.getFlag("agent");
    if (typeof builderSession !== "string" || builderSession.length === 0) {
      ctx.ui.notify(
        "verifier: missing required flags --builder-session and --agent",
        "error",
      );
      return;
    }
    if (typeof agentPath !== "string" || agentPath.length === 0) {
      ctx.ui.notify(
        "verifier: missing required flags --builder-session and --agent",
        "error",
      );
      return;
    }
    state.builderSessionId = builderSession;
    state.agentPath = agentPath;
    // Derive the display name from the persona file: basename, strip `.md`,
    // uppercase. e.g. ".pi/verifier/agents/verifier.md" → "VERIFIER".
    state.personaName = path.basename(agentPath, ".md").toUpperCase();

    // Read frontmatter for runtime enforcement (bash policy + max_loops).
    // Body has already been templated by the launcher and passed via
    // --system-prompt; we don't re-template here.
    let maxLoops: number;
    try {
      const personaContent = readFileSync(state.agentPath, "utf-8");
      const persona = parseVerifierPersona(personaContent);
      maxLoops = persona.frontmatter.max_loops ?? 3;
    } catch (err) {
      ctx.ui.notify(
        `verifier: failed to load persona at ${state.agentPath}: ${(err as Error).message}`,
        "error",
      );
      return;
    }
    state.maxLoops = maxLoops;

    // Replace the input editor with the status bar and install our minimal
    // custom footer (overrides Pi's default — we only show what's relevant
    // to the verifier: model, ctx usage, sid, total turns, phase glyph).
    if (ctx.hasUI) {
      ctx.ui.setEditorComponent(
        (tui, theme, kb) => new VerifierStatusBar(tui, theme, kb, {}),
      );
      installVerifierFooter(ctx);
    }

    // Resolve the socket path. Prefer the canonical resolver — falling
    // back to the breadcrumb file would be marginally more robust against
    // a tmpdir reshuffle, but in v1 the builder writes the breadcrumb
    // pointing at the same canonical path the resolver computes here.
    try {
      const { socketPath } = resolveSocketPath(state.builderSessionId, ctx.cwd);
      state.socketPath = socketPath;
    } catch (err) {
      ctx.ui.notify(
        `verifier: socket path resolution failed: ${(err as Error).message}`,
        "error",
      );
      return;
    }

    // Connect.
    connectToParent(pi, ctx);
  });

  // ── session_shutdown: clean up socket + editor ───────────────────────────
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx) => {
    if (!pi.getFlag("child")) return;
    state.shuttingDown = true;
    teardown(ctx);
  });
}

// ─── Connection management ───────────────────────────────────────────────────

function connectToParent(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const conn = net.createConnection(state.socketPath);
  state.parentConn = conn;

  conn.on("connect", () => {
    state.lastAckTimestamp = Date.now();
    const hello: Hello = {
      type: "hello",
      role: "verifier",
      sessionId: state.builderSessionId,
      pid: process.pid,
    };
    try {
      assertDirection(hello, "verifier-to-builder");
      conn.write(encodeEnvelope(hello));
    } catch (err) {
      ctx.ui.notify(
        `verifier: failed to send hello: ${(err as Error).message}`,
        "error",
      );
    }
    requestStatusRender(ctx);

    // Start liveness pings only after we've connected.
    startPingInterval(ctx);
  });

  conn.on("error", (err) => {
    if (state.shuttingDown) return;
    ctx.ui.notify(
      `verifier: socket error: ${(err as Error).message}`,
      "error",
    );
  });

  conn.on("close", () => {
    if (state.shuttingDown) return;
    state.phase = "disconnected";
    requestStatusRender(ctx);
    // Give the user a moment to see the disconnected status, then exit
    // cleanly. If the parent is genuinely gone, the tmux window dies with
    // us; if the user wanted to keep it, they can tmux-attach the corpse.
    setTimeout(() => {
      try {
        ctx.shutdown();
      } catch {
        // Best-effort — fall back to process.exit so the tmux window dies.
        process.exit(0);
      }
    }, 5000);
  });

  // JSONL reader. Wrapped in an async IIFE so we don't unhandle-reject the
  // top-level factory; per-frame errors are surfaced via notify.
  void (async () => {
    try {
      for await (const envelope of readEnvelopes(conn)) {
        try {
          dispatchEnvelope(envelope, pi, ctx);
        } catch (err) {
          ctx.ui.notify(
            `verifier: dispatch error: ${(err as Error).message}`,
            "error",
          );
        }
      }
    } catch (err) {
      if (state.shuttingDown) return;
      ctx.ui.notify(
        `verifier: read loop ended: ${(err as Error).message}`,
        "warning",
      );
    }
  })();
}

function dispatchEnvelope(envelope: Envelope, pi: ExtensionAPI, ctx: ExtensionContext): void {
  // The verifier consumes builder→verifier traffic. ping/pong/bye are
  // bidirectional in the matrix (both sides run liveness intervals; either
  // side may initiate teardown); the typed envelopes (hello_ack /
  // prompt_ack / event) are strictly directional and validated here.
  assertDirection(envelope, "builder-to-verifier");
  state.lastAckTimestamp = Date.now();

  switch (envelope.type) {
    case "hello_ack": {
      state.helloAcked = true;
      state.phase = "connected";
      requestStatusRender(ctx);
      return;
    }
    case "prompt_ack": {
      const resolver = state.pendingPromptAcks.get(envelope.correlationId);
      if (resolver) {
        state.pendingPromptAcks.delete(envelope.correlationId);
        resolver(envelope);
      }
      return;
    }
    case "ping": {
      const pong: Pong = { type: "pong", nonce: envelope.nonce };
      // pong is bidirectional; this is the synchronous reply to a builder
      // ping. assertDirection is a programming-error guard.
      try {
        assertDirection(pong, "verifier-to-builder");
        state.parentConn?.write(encodeEnvelope(pong));
      } catch (err) {
        ctx.ui.notify(
          `verifier: failed to pong: ${(err as Error).message}`,
          "error",
        );
      }
      return;
    }
    case "pong": {
      state.pendingPongs = 0;
      return;
    }
    case "event": {
      handleBuilderEvent(envelope, pi, ctx);
      return;
    }
    case "bye": {
      state.shuttingDown = true;
      teardown(ctx);
      try {
        ctx.shutdown();
      } catch {
        process.exit(0);
      }
      return;
    }
    default:
      // Direction matrix excluded everything else, but TS still wants the
      // fallthrough.
      return;
  }
}

function handleBuilderEvent(
  envelope: BuilderEvent,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  // Render the event as a visible system message in the verifier's
  // scrollback. The custom renderer is registered above.
  //
  // `deliverAs: "nextTurn"` is critical here — without it, sendMessage
  // defaults to "steer", which INJECTS the message into the verifier's
  // current stream between tool calls. That makes the verifier's LLM see
  // "🪝 builder event · start · turn N+1" mid-reasoning on turn N's
  // verification cycle, and it gets confused thinking a new turn started
  // while it's mid-Report. With "nextTurn", the message is queued for the
  // NEXT user turn (which will be turn N+1's verify_on_stop prompt) and
  // does not interrupt or pollute the current run's context. The custom
  // renderer still places the row in scrollback for operator visibility.
  const turnLabel = envelope.turnIndex !== undefined ? String(envelope.turnIndex) : "—";
  const iso = new Date(envelope.timestamp).toISOString();
  pi.sendMessage(
    {
      customType: "builder-event",
      content: `🪝 builder event · ${envelope.name} · turn ${turnLabel} · ${iso}`,
      details: envelope,
      display: true,
    },
    { deliverAs: "nextTurn" },
  );

  switch (envelope.name) {
    case "start": {
      // Builder turn has begun. The Phase enum doesn't have a dedicated
      // "running" state (verifying covers the post-stop cycle), so we keep
      // state.phase at "connected" — our custom footer reads state.phase
      // and re-renders on tui.requestRender(). No setStatus needed.
      state.phase = "connected";
      requestStatusRender(ctx);
      return;
    }
    case "stop": {
      state.currentTurnIndex = envelope.turnIndex ?? state.currentTurnIndex;
      state.phase = "verifying";
      state.promptedThisCycle = false;
      // Reset confidence so the bar drops back to purple while we verify the
      // new turn. The next Report will set it again with the verdict color.
      state.confidence = null;
      requestStatusRender(ctx);

      // Fire the verify_on_stop user prompt.
      const promptPath = path.join(
        ctx.cwd,
        ".pi",
        "verifier",
        "prompts",
        "verify_on_stop.md",
      );
      let template: string;
      try {
        template = readFileSync(promptPath, "utf-8");
      } catch (err) {
        ctx.ui.notify(
          `verifier: failed to read ${promptPath}: ${(err as Error).message}`,
          "error",
        );
        return;
      }
      const rendered = templateBody(template, {
        TURN_INDEX: String(state.currentTurnIndex),
        TIMESTAMP: new Date(envelope.timestamp).toISOString(),
        USER_PROMPT: envelope.userPrompt ?? "(no captured user prompt)",
        SESSION_FILE_START_LINE: String(envelope.sessionFileStartLine ?? 1),
        SESSION_FILE_END_LINE: String(envelope.sessionFileEndLine ?? 0),
      });
      try {
        // extension-source — passes through the input lock on this side.
        // `deliverAs: "followUp"` queues the prompt if the verifier is
        // already mid-turn on a previous stop event. Without this, a fast
        // builder (multi-turn user prompt) could fire stop N+1 while we're
        // still verifying turn N — Pi would either drop or interrupt. With
        // followUp, Pi appends the new user message to its queue and runs
        // it as soon as the current agent run completes. Order is preserved.
        pi.sendUserMessage(rendered, { deliverAs: "followUp" });
      } catch (err) {
        ctx.ui.notify(
          `verifier: sendUserMessage failed: ${(err as Error).message}`,
          "error",
        );
      }
      return;
    }
    case "error": {
      state.phase = "error";
      state.errorDetail = envelope.detail ?? "(no detail)";
      requestStatusRender(ctx);
      return;
    }
  }
}

// ─── Liveness ────────────────────────────────────────────────────────────────

function startPingInterval(ctx: ExtensionContext): void {
  if (state.pingInterval) {
    clearInterval(state.pingInterval);
  }
  state.pingInterval = setInterval(() => {
    if (!state.parentConn || state.parentConn.destroyed) return;
    state.pendingPongs += 1;
    if (state.pendingPongs >= 2) {
      // Two missed pongs → parent gone. Mark disconnected, then fall
      // through to the close handler's 5s exit.
      state.phase = "disconnected";
      requestStatusRender(ctx);
      try {
        state.parentConn.destroy();
      } catch {
        // ignore
      }
      return;
    }
    const ping: Ping = { type: "ping", nonce: crypto.randomUUID() };
    try {
      // ping is bidirectional; assert direction for symmetry with other
      // outbound writes. Will not throw since the matrix permits it.
      assertDirection(ping, "verifier-to-builder");
      state.parentConn.write(encodeEnvelope(ping));
    } catch {
      // Write failures will surface via the close handler.
    }
  }, 10_000);
}

// ─── Teardown ────────────────────────────────────────────────────────────────

function teardown(ctx: ExtensionContext): void {
  if (state.pingInterval) {
    clearInterval(state.pingInterval);
    state.pingInterval = null;
  }

  // Send `bye` if we still have a live socket.
  if (state.parentConn && !state.parentConn.destroyed) {
    try {
      state.parentConn.write(
        encodeEnvelope({ type: "bye", reason: "verifier shutting down" }),
      );
    } catch {
      // ignore
    }
    try {
      state.parentConn.end();
    } catch {
      // ignore
    }
  }

  // Restore the default editor. Defensive — `ctx.ui` may be a no-op in
  // print mode.
  if (ctx.hasUI) {
    try {
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
    } catch {
      // ignore
    }
  }
}

// ─── Custom footer ───────────────────────────────────────────────────────────

/**
 * Install the verifier's minimal footer. Replaces Pi's default footer entirely
 * (per Q-amendment: we only want model · ctx-bar · sid · turn · phase).
 *
 * Render reads from `state.*` directly, so any state mutation followed by
 * `requestStatusRender(ctx)` (which calls `ctx.ui.requestRender?.()`) refreshes
 * the line. Pattern adapted from the upstream `minimal.ts` reference.
 */
function installVerifierFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter((_tui, theme, _footerData) => ({
    dispose: () => {},
    invalidate() {},
    render(width: number): string[] {
      const model = ctx.model?.id ?? "no-model";
      const usage = ctx.getContextUsage?.();
      const pct = usage && usage.percent !== null ? usage.percent : 0;
      const filled = Math.round(pct / 10);
      const bar = "#".repeat(filled) + "-".repeat(Math.max(0, 10 - filled));

      // Verifier footer is now just model + ctx-bar. Phase lives ONLY in
      // the top status bar (VerifierStatusBar) — no duplication. sid and
      // turn are also omitted (sid: builder footer carries the canonical
      // one; turn: visible in scrollback as builder-event system messages).
      const left = theme.fg("dim", ` ${model}`);
      const right = theme.fg("dim", ` [${bar}] ${Math.round(pct)}% `);
      const padLen = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
      return [truncateToWidth(left + " ".repeat(padLen) + right, width)];
    },
  }));
}

/**
 * Trigger a footer re-render after mutating `state.*`. The footer reads from
 * state on each render, so we just nudge the TUI. Cheap and idempotent.
 */
function requestStatusRender(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  // Re-trigger render via setFooter (idempotent install). Pi's TUI batches
  // renders so calling this on every state change is fine.
  installVerifierFooter(ctx);
}

// ─── Report parsing ──────────────────────────────────────────────────────────

const REPORT_HEADERS = [
  "What did you verify?",
  "What could you not verify?",
  "What feedback did you give?",
  "What do you need from me to verify this next time?",
  "Cost",
  "Evidence tier",
  "Verification metadata",
] as const;

/**
 * Pull the `## Report` block out of the assistant's last message and split
 * it into its known H3 sections. Returns null if the block is missing or
 * the STATUS line can't be parsed — both of which the caller treats as
 * "no report this cycle".
 */
function parseReport(raw: string, _turnIndex: number): ParsedReport | null {
  const reportIdx = raw.search(/^##\s+Report\s*$/m);
  if (reportIdx === -1) return null;
  const reportBody = raw.slice(reportIdx);

  // STATUS line — case-insensitive, anywhere on its own line in the block.
  const statusMatch = reportBody.match(/^\s*STATUS\s*:\s*(verified|failed|unsure)\b/im);
  if (!statusMatch) return null;
  const status = statusMatch[1]!.toLowerCase() as ParsedReport["status"];

  // CONFIDENCE is required. Do not launder missing confidence into a
  // status-derived default; omission means the Report contract was not met.
  const confMatch = reportBody.match(/^\s*CONFIDENCE\s*:\s*(perfect|verified|partial|feedback|failed)\b/im);
  if (!confMatch) return null;

  // EVIDENCE_TIER is required so satellite reports can be deterministically
  // capped by available evidence. Local verifier personas also emit this.
  const tierMatch = reportBody.match(/^\s*EVIDENCE_TIER\s*:\s*(T0|T1|T2|T3)\b/im);
  if (!tierMatch) return null;

  const evidenceTier = tierMatch[1]!.toUpperCase() as "T0" | "T1" | "T2" | "T3";
  const confidence = clampConfidenceToEvidenceTier(
    confMatch[1]!.toLowerCase() as Confidence,
    evidenceTier,
  );

  // Split the body on H3 boundaries to populate sections.
  const sections: Record<string, string> = {};
  // We only collect sections matching the known header set; unknown H3s
  // are ignored.
  for (const header of REPORT_HEADERS) {
    const re = new RegExp(
      `^###\\s+${escapeRegex(header)}\\s*$([\\s\\S]*?)(?=^###\\s|^##\\s|(?![\\s\\S]))`,
      "m",
    );
    const m = reportBody.match(re);
    if (m && m[1]) {
      sections[header] = m[1].trim();
    }
  }

  // Summary — first non-empty line of "What did you verify?" or fallback.
  const verifiedSection = sections["What did you verify?"];
  let summary: string;
  if (verifiedSection) {
    const firstLine = verifiedSection.split("\n").find((l) => l.trim().length > 0);
    summary = (firstLine ?? "").trim();
  } else {
    summary = "";
  }
  if (!summary) {
    summary = `${status} for turn ${state.currentTurnIndex}`;
  }

  return { status, confidence, summary, sections };
}

function clampConfidenceToEvidenceTier(
  confidence: Confidence,
  tier: "T0" | "T1" | "T2" | "T3",
): Confidence {
  const rank: Record<Confidence, number> = {
    failed: 0,
    feedback: 1,
    partial: 2,
    verified: 3,
    perfect: 4,
  };
  const byRank = Object.fromEntries(
    Object.entries(rank).map(([name, value]) => [value, name]),
  ) as Record<number, Confidence>;
  const cap: Record<typeof tier, Confidence> = {
    T0: "partial",
    T1: "verified",
    T2: "perfect",
    T3: "perfect",
  };
  return byRank[Math.min(rank[confidence], rank[cap[tier]])]!;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Assistant content extraction ────────────────────────────────────────────

/**
 * Pull the concatenated text content out of an assistant message. We only
 * care about TextContent blocks — thinking and tool calls aren't part of
 * the user-facing "## Report" surface.
 */
function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}
