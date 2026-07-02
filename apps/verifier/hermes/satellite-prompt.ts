/**
 * Satellite verify prompt templating — non-empty defaults for every slot.
 *
 * `templateBody` leaves unmatched `<UPPER_SNAKE>` literals in output; this
 * module merges caller vars with defaults before templating.
 */

import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { templateBody } from "../_shared/frontmatter.js";
import type { EvidenceTier } from "./types.js";

export interface SatelliteVerifyPromptVars {
  HERMES_TASK_ID: string;
  HERMES_SESSION_ID: string;
  ORIGINAL_PROMPT: string;
  HERMES_RESULT_TEXT: string;
  HERMES_TRANSCRIPT: string;
  HERMES_CLAIMS: string;
  EVIDENCE_TIER: EvidenceTier;
  TURN_INDEX: string;
  MAX_LOOPS: string;
}

export const SATELLITE_VERIFY_DEFAULTS: SatelliteVerifyPromptVars = {
  HERMES_TASK_ID: "(no task id)",
  HERMES_SESSION_ID: "(no session id)",
  ORIGINAL_PROMPT: "(dispatch prompt unavailable)",
  HERMES_RESULT_TEXT: "(hermes_result text unavailable)",
  HERMES_TRANSCRIPT: "(transcript unavailable — T2 not fetched)",
  HERMES_CLAIMS: "(hermes_decompose not run)",
  EVIDENCE_TIER: "T0",
  TURN_INDEX: "0",
  MAX_LOOPS: "3",
};

const PROMPT_REL = path.join(".pi", "verifier", "prompts", "verify_on_satellite_complete.md");

let cachedTemplate: string | null = null;

export function loadSatelliteVerifyTemplate(cwd: string): string {
  if (cachedTemplate) return cachedTemplate;
  const promptPath = path.join(cwd, PROMPT_REL);
  cachedTemplate = readFileSync(promptPath, "utf8");
  return cachedTemplate;
}

/** Resolve template path by walking up from this module (source or dist). */
export function defaultSatelliteVerifyTemplatePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, PROMPT_REL);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `verify_on_satellite_complete.md not found walking up from ${here}`,
  );
}

export function renderSatelliteVerifyPrompt(
  vars: Partial<SatelliteVerifyPromptVars>,
  template: string,
): string {
  const merged: Record<string, string> = { ...SATELLITE_VERIFY_DEFAULTS, ...vars };
  return templateBody(template, merged);
}

/** @internal test helper — clear cached template between tests. */
export function _clearTemplateCache(): void {
  cachedTemplate = null;
}
