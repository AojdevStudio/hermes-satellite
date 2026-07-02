/**
 * Hermes satellite verify trigger — stub (Phase 1 scaffold).
 *
 * Phase 3: on terminal poll result → fetch transcript → hermes_decompose →
 * inject verify_on_satellite_complete.md → run satellite-verifier persona.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { Confidence } from "./_shared/ipc.js";
import type { HermesResult as RemoteHermesResult } from "./hermes/types.js";
import {
  loadSatelliteVerifyTemplate,
  renderSatelliteVerifyPrompt,
  type SatelliteVerifyPromptVars,
} from "./hermes/satellite-prompt.js";
import { decomposeTranscript } from "./hermes/decompose.js";
import type { HermesExportTranscript } from "./hermes/types.js";

export interface VerifyTriggerContext {
  cwd: string;
  result: RemoteHermesResult;
  originalPrompt: string;
  transcript: HermesExportTranscript | null;
  evidenceTier: SatelliteVerifyPromptVars["EVIDENCE_TIER"];
  turnIndex: number;
  maxLoops: number;
  /** Optional runner for a satellite verifier LLM/session. If omitted, this returns the prompt to inject. */
  runSatelliteVerifier?: (prompt: string, turnIndex: number) => Promise<string>;
  /** Optional corrective channel; normally wraps hermes_respond. */
  respond?: (message: string, turnIndex: number) => Promise<void>;
  /** Optional poll-after-correction; normally wraps waitForHermes. */
  pollAgain?: (turnIndex: number) => Promise<RemoteHermesResult>;
  /** Optional transcript refresh after a correction pass. */
  fetchTranscript?: (result: RemoteHermesResult, turnIndex: number) => Promise<HermesExportTranscript | null>;
}

export interface SatelliteVerifyReport {
  status: "verified" | "failed" | "unsure";
  confidence: Confidence;
  evidenceTier: VerifyTriggerContext["evidenceTier"];
  correctiveMessage: string | null;
  raw: string;
}

export interface VerifyLoopOutcome {
  status: "verified" | "failed" | "unsure" | "needs-verifier" | "max-loops";
  prompt: string;
  reports: SatelliteVerifyReport[];
  result: RemoteHermesResult;
}

/**
 * Build the verify user prompt from terminal Hermes result + evidence.
 */
export function buildSatelliteVerifyPrompt(ctx: VerifyTriggerContext): string {
  const template = loadSatelliteVerifyTemplate(ctx.cwd);

  const claims =
    ctx.transcript !== null
      ? decomposeTranscript({
          transcript: ctx.transcript,
          originalPrompt: ctx.originalPrompt,
        }).claims
      : [];

  const claimsText =
    claims.length > 0
      ? claims
          .map(
            (c) =>
              `- [${c.kind}] ${c.text}${c.embeddedEvidence ? ` (evidence: ${c.embeddedEvidence.slice(0, 120)}…)` : ""}`,
          )
          .join("\n")
      : "(no claims decomposed)";

  return renderSatelliteVerifyPrompt(
    {
      HERMES_TASK_ID: ctx.result.taskId,
      HERMES_SESSION_ID: ctx.result.sessionId ?? "(unknown session)",
      ORIGINAL_PROMPT: ctx.originalPrompt,
      HERMES_RESULT_TEXT: ctx.result.text,
      HERMES_TRANSCRIPT: ctx.transcript
        ? JSON.stringify(ctx.transcript, null, 2)
        : "(transcript unavailable)",
      HERMES_CLAIMS: claimsText,
      EVIDENCE_TIER: ctx.evidenceTier,
      TURN_INDEX: String(ctx.turnIndex),
      MAX_LOOPS: String(ctx.maxLoops),
    },
    template,
  );
}

export function parseSatelliteVerifyReport(raw: string): SatelliteVerifyReport | null {
  const reportIdx = raw.search(/^##\s+Report\s*$/m);
  if (reportIdx === -1) return null;
  const body = raw.slice(reportIdx);
  const status = body.match(/^\s*STATUS\s*:\s*(verified|failed|unsure)\b/im)?.[1]?.toLowerCase() as
    | SatelliteVerifyReport["status"]
    | undefined;
  const confidence = body.match(/^\s*CONFIDENCE\s*:\s*(perfect|verified|partial|feedback|failed)\b/im)?.[1]?.toLowerCase() as
    | Confidence
    | undefined;
  const evidenceTier = body.match(/^\s*EVIDENCE_TIER\s*:\s*(T0|T1|T2|T3)\b/im)?.[1]?.toUpperCase() as
    | VerifyTriggerContext["evidenceTier"]
    | undefined;
  if (!status || !confidence || !evidenceTier) return null;

  const feedbackMatch = body.match(
    /^###\s+What feedback did you give\?\s*$([\s\S]*?)(?=^###\s|^##\s|(?![\s\S]))/im,
  );
  const feedback = feedbackMatch?.[1]?.trim() ?? "";
  const correctiveMessage = feedback && !/^none$/i.test(feedback) ? feedback : null;
  return { status, confidence, evidenceTier, correctiveMessage, raw };
}

/**
 * Phase 3 entry — build/inject satellite verification and optionally loop
 * correction through hermes_respond + poll. In Pi extension mode, callers can
 * omit `runSatelliteVerifier`; the returned `prompt` is what should be
 * injected with `pi.sendUserMessage()`.
 */
export async function onHermesTerminalStatus(
  ctx: VerifyTriggerContext,
): Promise<VerifyLoopOutcome> {
  let result = ctx.result;
  let transcript = ctx.transcript;
  const reports: SatelliteVerifyReport[] = [];
  let prompt = buildSatelliteVerifyPrompt({ ...ctx, result, transcript });

  for (let turn = ctx.turnIndex; turn < ctx.maxLoops; turn++) {
    prompt = buildSatelliteVerifyPrompt({ ...ctx, result, transcript, turnIndex: turn });
    if (!ctx.runSatelliteVerifier) {
      return { status: "needs-verifier", prompt, reports, result };
    }

    const rawReport = await ctx.runSatelliteVerifier(prompt, turn);
    const report = parseSatelliteVerifyReport(rawReport);
    if (!report) {
      return { status: "unsure", prompt, reports, result };
    }
    reports.push(report);

    if (report.status === "verified") {
      return { status: "verified", prompt, reports, result };
    }

    if (
      report.correctiveMessage &&
      ctx.respond &&
      ctx.pollAgain &&
      turn + 1 < ctx.maxLoops
    ) {
      await ctx.respond(report.correctiveMessage, turn);
      result = await ctx.pollAgain(turn + 1);
      transcript = ctx.fetchTranscript
        ? await ctx.fetchTranscript(result, turn + 1)
        : transcript;
      continue;
    }

    return { status: report.status, prompt, reports, result };
  }

  return { status: "max-loops", prompt, reports, result };
}

/** Pi extension hook — no-op until Phase 3. */
export default function hermesVerifyTriggerExtension(_pi: ExtensionAPI): void {
  // Registered alongside hermes-dispatch in Phase 3.
}
