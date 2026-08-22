/**
 * Verifier persona frontmatter parser + body templating.
 *
 * Wraps `parseFrontmatter` from `@mariozechner/pi-coding-agent`, layering
 * verifier-specific shape validation on top:
 *
 *   - Required scalar fields: name, description, tools, model, domain.
 *   - Optional: max_loops (number), verification_focus (string[]).
 *
 * Templating is deliberately the dumbest possible thing — global string
 * replace on `<UPPER_SNAKE>` placeholders. No Jinja, no Mustache, no
 * conditionals. The verifier persona body is markdown that the LLM reads;
 * we substitute spawn-time values (BUILDER_SESSION_ID, BUILDER_SESSION_FILE,
 * SOCKET_PATH, etc.) into angle-bracketed slots and pass the result to
 * `pi --system-prompt` as a full overwrite.
 */

import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import Type from "typebox";
import { Errors, Parse } from "typebox/value";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VerifierFrontmatter {
  name: string;
  description: string;
  tools: string; // comma-separated, parsed downstream by the verifier extension
  model: string;
  domain: string;
  max_loops?: number;
  verification_focus?: string[];
}

export interface ParsedVerifierPersona {
  frontmatter: VerifierFrontmatter;
  body: string;
}

const FrontmatterSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  tools: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  domain: Type.String({ minLength: 1 }),
  max_loops: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  verification_focus: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.Null()]),
  ),
});

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a `.pi/verifier/agents/<name>.md` persona file into typed
 * frontmatter + raw body. Throws with a clear, field-naming message on
 * any missing required field — these are user-authored files, so the
 * error needs to point a human at exactly what's wrong.
 *
 * Note: we do NOT validate `tools` content (e.g. "is `bash` actually a
 * known Pi tool name") here — that's the verifier extension's job at
 * spawn time, where it has access to the Pi runtime tool registry.
 */
export function parseVerifierPersona(content: string): ParsedVerifierPersona {
  const { frontmatter: raw, body } = parseFrontmatter(content);

  const [issue] = Errors(FrontmatterSchema, raw);
  if (issue) {
    const field = issue.instancePath.slice(1);
    throw new Error(
      `Verifier persona frontmatter${field ? ` field "${field}"` : ""}: ${issue.message}.`,
    );
  }

  const parsed = Parse(FrontmatterSchema, raw);
  const frontmatter: VerifierFrontmatter = {
    name: parsed.name,
    description: parsed.description,
    tools: parsed.tools,
    model: parsed.model,
    domain: parsed.domain,
  };
  if (parsed.max_loops !== undefined && parsed.max_loops !== null) {
    frontmatter.max_loops = parsed.max_loops;
  }
  if (
    parsed.verification_focus !== undefined &&
    parsed.verification_focus !== null
  ) {
    frontmatter.verification_focus = parsed.verification_focus;
  }

  return { frontmatter, body };
}

// ─── Templating ──────────────────────────────────────────────────────────────

/**
 * Replace `<UPPER_SNAKE_CASE>` placeholders in `body` with values from
 * `vars`. Pure string replacement, global, case-sensitive.
 *
 * Keys in `vars` should be the placeholder name without the angle
 * brackets (e.g. `BUILDER_SESSION_ID`, not `<BUILDER_SESSION_ID>`).
 *
 * Placeholders that don't appear in `vars` are left untouched. This is
 * intentional: the body is templated in two stages (system-prompt vars
 * at spawn, user-prompt vars per cycle); the first stage shouldn't fail
 * on slots the second stage will fill.
 */
export function templateBody(body: string, vars: Record<string, string>): string {
  let out = body;
  for (const [key, value] of Object.entries(vars)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(
        `templateBody: variable name "${key}" must be UPPER_SNAKE_CASE (matches /^[A-Z][A-Z0-9_]*$/).`,
      );
    }
    const pattern = new RegExp(`<${key}>`, "g");
    out = out.replace(pattern, value);
  }
  return out;
}
