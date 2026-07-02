/**
 * T2 transcript → AtomicClaim[] decomposition (deterministic rules v1).
 *
 * Rules (specs/hermes-satellite-verify.md):
 *   1. tool_call + tool_result → tool_execution (embeddedEvidence from tool row only)
 *   2. Final assistant message → assistant_assertion (best-effort, advisory)
 *   3. Dispatch prompt ## Acceptance bullets → user_requirement
 *
 * Canonical logic — bridge must not re-implement in Python.
 */

import { createHash } from "node:crypto";

import type {
  AtomicClaim,
  DecomposeInput,
  DecomposeOutput,
  HermesExportMessage,
} from "./types.js";

let claimCounter = 0;

function nextClaimId(prefix: string): string {
  claimCounter += 1;
  return `${prefix}-${claimCounter}`;
}

function resetClaimCounter(): void {
  claimCounter = 0;
}

function toolCallName(
  tc: NonNullable<HermesExportMessage["tool_calls"]>[number],
): string {
  return tc.name ?? tc.function?.name ?? "unknown_tool";
}

function toolCallId(
  tc: NonNullable<HermesExportMessage["tool_calls"]>[number],
): string {
  return tc.id;
}

/** Rule 3 — parse `## Acceptance` bullet list from dispatch prompt. */
export function parseAcceptanceBullets(originalPrompt: string): string[] {
  const match = originalPrompt.match(/(?:^|\n)## Acceptance\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (!match?.[1]) return [];

  const section = match[1];
  const bullets: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet?.[1]) {
      bullets.push(bullet[1].trim());
    }
  }
  return bullets;
}

/** Rule 2 — extract assertion-like sentences from final assistant text (advisory). */
export function extractAssistantAssertions(text: string): string[] {
  const assertions: string[] = [];
  const normalized = text.trim();
  if (!normalized) return assertions;

  // Bullet lines
  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet?.[1]) {
      assertions.push(bullet[1].trim());
      continue;
    }
  }

  // Sentence splits on . ! ? when line looks like prose (not code fence)
  const sentences = normalized
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10 && !s.startsWith("```"));

  for (const sentence of sentences) {
    if (/^(done|completed|finished|success|all tests pass)/i.test(sentence)) {
      assertions.push(sentence);
    }
  }

  return [...new Set(assertions)];
}

function stableId(parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
  return hash;
}

/**
 * Decompose a T2 export + original dispatch prompt into AtomicClaim[].
 */
export function decomposeTranscript(input: DecomposeInput): DecomposeOutput {
  resetClaimCounter();
  const claims: AtomicClaim[] = [];
  const { transcript, originalPrompt } = input;
  const messages = transcript.messages;

  // Rule 3 — user requirements from acceptance block
  for (const bullet of parseAcceptanceBullets(originalPrompt)) {
    claims.push({
      id: nextClaimId("req"),
      kind: "user_requirement",
      source: { messageIndex: 0 },
      text: bullet,
      suggestedOracle: "manual",
    });
  }

  // Rule 1 — pair assistant tool_calls with tool result rows
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;

    for (const tc of msg.tool_calls) {
      const callId = toolCallId(tc);
      const toolName = toolCallName(tc);
      const resultIndex = messages.findIndex(
        (m, idx) =>
          idx > i &&
          m.role === "tool" &&
          (m.tool_call_id === callId || m.name === toolName),
      );

      let embeddedEvidence: string | undefined;
      if (resultIndex >= 0) {
        embeddedEvidence = messages[resultIndex]?.content ?? "";
      }

      claims.push({
        id: stableId(["tool", String(i), callId, toolName]),
        kind: "tool_execution",
        source: {
          messageIndex: i,
          toolName,
          toolCallId: callId,
        },
        text: `${toolName}(${tc.function?.arguments ?? ""})`.trim(),
        ...(embeddedEvidence !== undefined ? { embeddedEvidence } : {}),
        suggestedOracle: "tool_result",
      });
    }
  }

  // Rule 2 — final assistant message assertions (advisory)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.content?.trim()) continue;
    if (msg.tool_calls?.length) continue;

    for (const assertion of extractAssistantAssertions(msg.content)) {
      claims.push({
        id: nextClaimId("assert"),
        kind: "assistant_assertion",
        source: { messageIndex: i },
        text: assertion,
        suggestedOracle: "manual",
      });
    }
    break;
  }

  return { claims };
}

/** @internal test helper */
export const _testing = {
  resetClaimCounter,
  parseAcceptanceBullets,
  extractAssistantAssertions,
};
