/**
 * Hermes satellite verify — shared types.
 *
 * Contracts for MCP bridge payloads, evidence tiers, decomposition, and cost
 * telemetry. Phase 1: types only; wiring lands in Phase 2+.
 */

/** Bridge-assigned task identifier returned by `hermes_submit`. */
export type TaskId = string;

/** Hermes session id (`--pass-session-id` / state.db row). */
export type HermesSessionId = string;

/** Terminal and in-flight statuses from `hermes_status`. */
export type TaskStatus = "pending" | "running" | "completed" | "failed";

/** Evidence tier — normative caps in specs/hermes-satellite-verify.md. */
export type EvidenceTier = "T0" | "T1" | "T2" | "T3";

export type AtomicClaimKind =
  | "tool_execution"
  | "assistant_assertion"
  | "user_requirement"
  | "structured_assistant_claim";

export type SuggestedOracle =
  | "tool_result"
  | "file_path_in_result"
  | "git_in_result"
  | "manual";

export type StructuredOutputMechanism =
  | "response_format"
  | "strict_tool"
  | "verify_claims_tool"
  | "plugin_complete_structured";

export interface AtomicClaimSource {
  messageIndex: number;
  toolName?: string;
  toolCallId?: string;
}

/** Normative shape — see specs/hermes-satellite-verify.md § AtomicClaim. */
export interface AtomicClaim {
  id: string;
  kind: AtomicClaimKind;
  source: AtomicClaimSource;
  text: string;
  /** Present for tool_execution — sourced from T2 export tool_result row only. */
  embeddedEvidence?: string;
  suggestedOracle?: SuggestedOracle;
  /** Set only when kind === structured_assistant_claim. */
  structuredOutputMechanism?: StructuredOutputMechanism;
}

export interface TaskCostSnapshot {
  taskId: string;
  hermesSessionId: string;
  loopIndex: number;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedUsd?: number | null;
  perModelBreakdown?: Array<{
    model: string;
    promptTokens: number;
    completionTokens: number;
    estimatedUsd?: number | null;
  }>;
  expensiveToolsUsed?: string[];
  costSource?: "provider_models_api" | "none" | "estimated" | null;
  billingProvider?: string;
  billingMode?: string;
  pricingVersion?: string;
  costUnreconciled?: boolean;
  source: "state.db" | "hermes_usage_api" | "estimated";
  capturedAt: string;
}

/** Payload from `hermes_result` after terminal status (Phase 2+). */
export interface HermesResult {
  taskId: TaskId;
  status: "completed" | "failed";
  sessionId?: HermesSessionId;
  text: string;
  error?: string;
  /** Phase 1 stub — null until bridge captures state.db (Phase 4). */
  cost?: TaskCostSnapshot | null;
}

/** Poll timeout — last known status when MAX_WAIT_SEC exceeded. */
export interface HermesPollTimeout {
  timeout: true;
  taskId: TaskId;
  lastStatus: TaskStatus;
  elapsedMs: number;
}

export type HermesPollOutcome = HermesResult | HermesPollTimeout;

/** Reduced T2 export message row (scaffold — expand when fixtures land). */
export interface HermesExportMessage {
  role: "user" | "assistant" | "tool" | string;
  content?: string;
  tool_calls?: Array<{
    id: string;
    name?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface HermesExportTranscript {
  sessionId: string;
  messages: HermesExportMessage[];
}

/** Input to `decomposeTranscript`. */
export interface DecomposeInput {
  transcript: HermesExportTranscript;
  /** Original dispatch prompt — used for ## Acceptance bullets (rule 3). */
  originalPrompt: string;
}

export interface DecomposeOutput {
  claims: AtomicClaim[];
}
