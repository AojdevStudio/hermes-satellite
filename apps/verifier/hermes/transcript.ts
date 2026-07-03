/**
 * T1/T2 evidence fetch for satellite verification.
 *
 * Phase 3 fetches MCP `hermes_transcript` when available, falls back to
 * `hermes_sessions` summary metadata, and parses post-task exports.
 */

import { readFile } from "node:fs/promises";

import type { HermesMcpClient } from "./client.js";
import type { EvidenceTier, HermesExportTranscript, HermesSessionId } from "./types.js";

export interface TranscriptFetchOptions {
  sessionId: HermesSessionId;
  /** When set, read export from disk instead of MCP (Mac-mini side export). */
  exportPath?: string;
  /** MCP client for hermes_transcript / hermes_sessions. */
  client?: Pick<HermesMcpClient, "transcript" | "sessions">;
  signal?: AbortSignal;
}

export interface TranscriptFetchResult {
  tier: EvidenceTier;
  transcript: HermesExportTranscript | null;
  rawText?: string;
}

/**
 * Fetch T2 transcript evidence for a Hermes session. Prefer a local exportPath
 * (already materialized on the Mac mini), otherwise call bridge
 * `hermes_transcript`. If that Phase-4 tool is absent, return T1 summary when
 * `hermes_sessions` is available.
 */
export async function fetchT2Transcript(
  opts: TranscriptFetchOptions,
): Promise<TranscriptFetchResult> {
  if (opts.exportPath) {
    const rawText = await readFile(opts.exportPath, "utf8");
    return { tier: "T2", transcript: parseExportJsonl(rawText), rawText };
  }

  if (!opts.client) {
    throw new Error(
      "fetchT2Transcript: provide exportPath or MCP client with hermes_transcript",
    );
  }

  try {
    const rawText = await opts.client.transcript(opts.sessionId, opts.signal);
    return { tier: "T2", transcript: parseExportJsonl(rawText), rawText };
  } catch (err) {
    const summary = await fetchT1Summary(opts.sessionId, opts.client, opts.signal);
    return {
      ...summary,
      rawText: `${summary.rawText ?? ""}\n\nT2 unavailable: ${(err as Error).message}`.trim(),
    };
  }
}

/** Fetch T1 session summary (hermes_sessions / bridge row metadata). */
export async function fetchT1Summary(
  sessionId: HermesSessionId,
  client?: Pick<HermesMcpClient, "sessions">,
  signal?: AbortSignal,
): Promise<TranscriptFetchResult> {
  if (!client) {
    throw new Error("fetchT1Summary: provide MCP client with hermes_sessions");
  }
  const raw = await client.sessions(sessionId, signal);
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  return { tier: "T1", transcript: null, rawText };
}

/**
 * Parse Hermes `sessions export` jsonl into normalized transcript shape.
 * Phase 1: accepts reduced fixture format only.
 */
export function parseExportJsonl(raw: string): HermesExportTranscript {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { sessionId: "", messages: [] };
  }

  // Single session object (pretty-printed export) or one-json-object-per-line.
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return normalizeExportObject(parsed);
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const messages = lines.map((line) => JSON.parse(line) as HermesExportMessageRow);
  const sessionId =
    typeof messages[0]?.session_id === "string" ? messages[0].session_id : "";

  return {
    sessionId,
    messages: messages.map(normalizeMessageRow),
  };
}

interface HermesExportMessageRow {
  role?: string;
  content?: string;
  tool_calls?: HermesExportTranscript["messages"][0]["tool_calls"];
  tool_call_id?: string;
  name?: string;
  session_id?: string;
}

function normalizeExportObject(obj: Record<string, unknown>): HermesExportTranscript {
  const sessionId =
    typeof obj.sessionId === "string"
      ? obj.sessionId
      : typeof obj.session_id === "string"
        ? obj.session_id
        : typeof obj.id === "string"
          ? obj.id
          : "";

  const rawMessages = Array.isArray(obj.messages) ? obj.messages : [];
  return {
    sessionId,
    messages: rawMessages.map((m) => normalizeMessageRow(m as HermesExportMessageRow)),
  };
}

function normalizeMessageRow(row: HermesExportMessageRow): HermesExportTranscript["messages"][0] {
  return {
    role: row.role ?? "unknown",
    ...(row.content !== undefined ? { content: row.content } : {}),
    ...(row.tool_calls !== undefined ? { tool_calls: row.tool_calls } : {}),
    ...(row.tool_call_id !== undefined ? { tool_call_id: row.tool_call_id } : {}),
    ...(row.name !== undefined ? { name: row.name } : {}),
  };
}
