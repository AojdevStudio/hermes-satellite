/**
 * T1/T2 evidence fetch for satellite verification.
 *
 * Phase 3 fetches MCP `hermes_transcript` when available, falls back to
 * `hermes_sessions` summary metadata, and parses post-task exports.
 */

import { readFile } from "node:fs/promises";
import Type, { type StaticParse } from "typebox";
import { Parse } from "typebox/value";

import type { HermesMcpClient } from "./client.js";
import type { EvidenceTier, HermesExportTranscript, HermesSessionId } from "./types.js";

const StringSchema = Type.String();
const ToolCallSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  function: Type.Optional(
    Type.Object({
      name: Type.Optional(Type.String()),
      arguments: Type.Optional(Type.String()),
    }),
  ),
});
const MessageRowSchema = Type.Object({
  role: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  tool_calls: Type.Optional(Type.Array(ToolCallSchema)),
  tool_call_id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  session_id: Type.Optional(Type.String()),
});
const ExportObjectSchema = Type.Object({
  sessionId: Type.Optional(Type.String()),
  session_id: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  messages: Type.Optional(Type.Array(MessageRowSchema)),
});

type HermesExportMessageRow = StaticParse<typeof MessageRowSchema>;
type HermesExportObject = StaticParse<typeof ExportObjectSchema>;

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
  } catch (cause) {
    const summary = await fetchT1Summary(opts.sessionId, opts.client, opts.signal);
    return {
      ...summary,
      rawText: `${summary.rawText ?? ""}\n\nT2 unavailable: ${cause instanceof Error ? cause.message : String(cause)}`.trim(),
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
  let rawText: string;
  try {
    rawText = Parse(StringSchema, raw);
  } catch {
    rawText = JSON.stringify(raw, null, 2) ?? "";
  }
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
    const parsed = Parse(ExportObjectSchema, JSON.parse(trimmed));
    return normalizeExportObject(parsed);
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const messages = lines.map((line) =>
    Parse(MessageRowSchema, JSON.parse(line)),
  );
  const sessionId = messages[0]?.session_id ?? "";

  return {
    sessionId,
    messages: messages.map(normalizeMessageRow),
  };
}

function normalizeExportObject(obj: HermesExportObject): HermesExportTranscript {
  const sessionId =
    obj.sessionId ?? obj.session_id ?? obj.id ?? "";

  const rawMessages = obj.messages ?? [];
  return {
    sessionId,
    messages: rawMessages.map(normalizeMessageRow),
  };
}

function normalizeMessageRow(row: HermesExportMessageRow): HermesExportTranscript["messages"][0] {
  const message: HermesExportTranscript["messages"][0] = {
    role: row.role ?? "unknown",
  };
  if (row.content !== undefined) message.content = row.content;
  if (row.tool_calls !== undefined) message.tool_calls = row.tool_calls;
  if (row.tool_call_id !== undefined) message.tool_call_id = row.tool_call_id;
  if (row.name !== undefined) message.name = row.name;
  return message;
}
