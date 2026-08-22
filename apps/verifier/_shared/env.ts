/**
 * `.env` loader for verifier extensions.
 *
 * Both `verifiable.ts` (builder) and `verifier.ts` (verifier) call this on
 * session_start with their `ctx.cwd`. Each agent loads `.env` from its own
 * working directory — defensive: even if tmux drops env vars between spawn
 * and child, the verifier independently loads the same `.env` because it
 * shares cwd (the launcher passes `-c <cwd>` to tmux).
 *
 * Precedence (matches dotenv conventions):
 *   1. Existing `process.env` values are preserved (env-vars-already-set wins).
 *   2. Values in `.env` fill in only the gaps.
 *
 * `process.loadEnvFile()` is a Node built-in (>= 21.7). We're on 24.x, so no
 * extra dep needed. If `.env` doesn't exist, this is a no-op (silent).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface LoadResult {
  loaded: boolean;
  path: string;
  reason?: string;
}

/**
 * Load `.env` from `cwd` into `process.env` if the file exists.
 *
 * - Non-existent `.env` → returns `{ loaded: false }` silently. Most projects
 *   don't have one; that's fine.
 * - Malformed `.env` → returns `{ loaded: false, reason }`. Caller decides
 *   whether to surface the warning to the user.
 * - Successful load → `{ loaded: true, path }`. Caller may choose to notify.
 *
 * Existing `process.env` keys are preserved by `process.loadEnvFile`'s
 * own semantics (it does not overwrite already-set vars).
 */
export async function loadDotEnv(cwd: string): Promise<LoadResult> {
  const envPath = path.join(cwd, ".env");
  try {
    await fs.access(envPath);
  } catch {
    return { loaded: false, path: envPath, reason: "no .env in cwd" };
  }
  try {
    process.loadEnvFile(envPath);
    return { loaded: true, path: envPath };
  } catch (cause) {
    return {
      loaded: false,
      path: envPath,
      reason: `failed to parse: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}
