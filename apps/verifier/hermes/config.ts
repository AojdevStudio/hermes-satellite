/**
 * Hermes MCP client configuration from environment.
 *
 * Matches `_shared/env.ts` precedence: existing process.env wins; `.env` fills
 * gaps when extensions call `loadDotEnv` on session_start (Phase 2).
 */

export interface HermesConfig {
  /** Streamable HTTP MCP endpoint, e.g. http://100.x.x.x:8081/mcp */
  mcpUrl: string;
  /** Bearer token for bridge auth. */
  mcpToken: string;
  /** Optional webhook for bridge completion callbacks (Phase 4). */
  callbackUrl?: string;
}

export class HermesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesConfigError";
  }
}

/**
 * Read Hermes config from `process.env`.
 * Throws `HermesConfigError` when required vars are missing.
 */
export function loadHermesConfig(env: NodeJS.ProcessEnv = process.env): HermesConfig {
  const mcpUrl = env.HERMES_MCP_URL?.trim();
  const mcpToken = env.HERMES_MCP_TOKEN?.trim();
  const callbackUrl = env.HERMES_CALLBACK_URL?.trim();

  if (!mcpUrl) {
    throw new HermesConfigError(
      "HERMES_MCP_URL is required (e.g. http://100.x.x.x:8081/mcp)",
    );
  }
  if (!mcpToken) {
    throw new HermesConfigError("HERMES_MCP_TOKEN is required (bridge bearer token)");
  }

  return {
    mcpUrl,
    mcpToken,
    ...(callbackUrl ? { callbackUrl } : {}),
  };
}

/** True when both required Hermes env vars are set (non-throwing probe). */
export function isHermesConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HERMES_MCP_URL?.trim() && env.HERMES_MCP_TOKEN?.trim());
}
