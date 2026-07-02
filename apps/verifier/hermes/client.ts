/**
 * Hermes MCP HTTP client (Streamable HTTP + Bearer auth).
 */

import type { HermesConfig } from "./config.js";
import type { HermesResult, TaskId, TaskStatus } from "./types.js";

export interface HermesSubmitParams {
	prompt: string;
	caller?: string;
}

export interface HermesSubmitResponse {
	taskId: TaskId;
	sessionId?: string;
}

export interface HermesStatusResponse {
	taskId: TaskId;
	status: TaskStatus;
	sessionId?: string;
}

export interface HermesRespondParams {
	taskId: TaskId;
	message: string;
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

const MCP_PROTOCOL_VERSION = "2025-06-18";
const TASK_STATUSES = new Set<TaskStatus>([
	"pending",
	"running",
	"completed",
	"failed",
]);

export class HermesMcpClient {
	private initialized?: Promise<void>;
	private nextRequestId = 1;
	private protocolVersion = MCP_PROTOCOL_VERSION;
	private mcpSessionId?: string;

	constructor(
		private readonly config: HermesConfig,
		private readonly fetchImpl: FetchFn = fetch,
	) {}

	get url(): string {
		return this.config.mcpUrl;
	}

	async submit(
		params: HermesSubmitParams,
		signal?: AbortSignal,
	): Promise<HermesSubmitResponse> {
		const raw = await this.callTool(
			"hermes_submit",
			{
				prompt: params.prompt,
				...(params.caller ? { caller: params.caller } : {}),
			},
			signal,
		);
		const record = asRecord(raw);
		return {
			taskId: requiredString(
				record.taskId ?? record.task_id ?? record.id,
				"hermes_submit task_id",
			),
			...optionalSession(record),
		};
	}

	async status(
		taskId: TaskId,
		signal?: AbortSignal,
	): Promise<HermesStatusResponse> {
		const raw = await this.callTool(
			"hermes_status",
			{ task_id: taskId },
			signal,
		);
		const record = asRecord(raw);
		const status = requiredStatus(record.status);
		return {
			taskId: stringOr(record.taskId ?? record.task_id, taskId),
			status,
			...optionalSession(record),
		};
	}

	async result(taskId: TaskId, signal?: AbortSignal): Promise<HermesResult> {
		const raw = await this.callTool(
			"hermes_result",
			{ task_id: taskId },
			signal,
		);
		const record = typeof raw === "string" ? { text: raw } : asRecord(raw);
		const error = optionalString(record.error);
		return {
			taskId: stringOr(record.taskId ?? record.task_id, taskId),
			status: resultStatus(record.status, error),
			...optionalSession(record),
			text: stringOr(
				record.text ?? record.output ?? record.result ?? record.message,
				error ?? "",
			),
			...(error ? { error } : {}),
			cost: (record.cost as HermesResult["cost"]) ?? null,
		};
	}

	async respond(
		params: HermesRespondParams,
		signal?: AbortSignal,
	): Promise<void> {
		await this.callTool(
			"hermes_respond",
			{ task_id: params.taskId, message: params.message },
			signal,
		);
	}

	async cancel(taskId: TaskId, signal?: AbortSignal): Promise<void> {
		await this.callTool("hermes_cancel", { task_id: taskId }, signal);
	}

	async list(
		signal?: AbortSignal,
	): Promise<Array<{ taskId: TaskId; status: TaskStatus }>> {
		const raw = await this.callTool("hermes_list", {}, signal);
		const tasks = Array.isArray(raw)
			? raw
			: asArray(asRecord(raw).tasks, "hermes_list tasks");
		return tasks.map((item) => {
			const record = asRecord(item);
			return {
				taskId: requiredString(
					record.taskId ?? record.task_id ?? record.id,
					"task_id",
				),
				status: requiredStatus(record.status),
			};
		});
	}

	async sessions(sessionId?: string, signal?: AbortSignal): Promise<unknown> {
		return this.callTool(
			"hermes_sessions",
			{ ...(sessionId ? { session_id: sessionId } : {}) },
			signal,
		);
	}

	async transcript(sessionId: string, signal?: AbortSignal): Promise<string> {
		const raw = await this.callTool(
			"hermes_transcript",
			{ session_id: sessionId },
			signal,
		);
		if (typeof raw === "string") return raw;
		const record = asRecord(raw);
		return requiredString(
			record.transcript ?? record.text ?? record.content ?? record.jsonl,
			"hermes_transcript text",
		);
	}

	private async callTool(
		name: string,
		args: JsonRecord,
		signal?: AbortSignal,
	): Promise<unknown> {
		await this.ensureInitialized(signal);
		const result = asRecord(
			await this.rpcRequest("tools/call", { name, arguments: args }, signal),
		);

		if (result.isError === true) {
			throw new Error(`${name}: ${toolText(result) || "tool failed"}`);
		}
		if ("structuredContent" in result) {
			return normalizeToolPayload(result.structuredContent);
		}

		const text = toolText(result);
		if (!text) return normalizeToolPayload(result);
		try {
			return normalizeToolPayload(parseJson(text));
		} catch {
			return text;
		}
	}

	private ensureInitialized(signal?: AbortSignal): Promise<void> {
		this.initialized ??= this.initialize(signal);
		return this.initialized;
	}

	private async initialize(signal?: AbortSignal): Promise<void> {
		const result = asRecord(
			await this.rpcRequest(
				"initialize",
				{
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "the-verifier-agent", version: "0.1.0" },
				},
				signal,
				false,
			),
		);
		const negotiated = optionalString(result.protocolVersion);
		if (negotiated) this.protocolVersion = negotiated;

		await this.postJsonRpc(
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			undefined,
			signal,
		);
	}

	private rpcRequest(
		method: string,
		params: JsonRecord,
		signal?: AbortSignal,
		includeSession = true,
	): Promise<unknown> {
		const id = this.nextRequestId++;
		return this.postJsonRpc(
			{ jsonrpc: "2.0", id, method, params },
			id,
			signal,
			includeSession,
		);
	}

	private async postJsonRpc(
		body: JsonRecord,
		expectedId?: number,
		signal?: AbortSignal,
		includeSession = true,
	): Promise<unknown> {
		const response = await this.fetchImpl(this.config.mcpUrl, {
			method: "POST",
			signal,
			headers: this.headers(includeSession),
			body: JSON.stringify(body),
		});

		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.mcpSessionId = sessionId;

		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`MCP HTTP ${response.status}: ${text || response.statusText}`,
			);
		}
		if (response.status === 202 || !text.trim()) return undefined;

		const contentType = response.headers.get("content-type") ?? "";
		const messages = contentType.includes("text/event-stream")
			? parseSseMessages(text)
			: [parseJson(text)];

		const message = findRpcResponse(messages, expectedId);
		if (!message) return undefined;
		if (message.error) {
			const error = asRecord(message.error);
			throw new Error(`MCP ${stringOr(error.message, "request failed")}`);
		}
		return message.result;
	}

	private headers(includeSession: boolean): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.config.mcpToken}`,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"MCP-Protocol-Version": this.protocolVersion,
		};
		if (includeSession && this.mcpSessionId)
			headers["Mcp-Session-Id"] = this.mcpSessionId;
		return headers;
	}
}

function parseSseMessages(text: string): unknown[] {
	const messages: unknown[] = [];
	for (const event of text.split(/\r?\n\r?\n/)) {
		const dataLines: string[] = [];
		for (const line of event.split(/\r?\n/)) {
			if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
		}
		const data = dataLines.join("\n");
		if (data && data !== "[DONE]") messages.push(parseJson(data));
	}
	return messages;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (err) {
		throw new Error(`Invalid MCP JSON response: ${(err as Error).message}`);
	}
}

function normalizeToolPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	const record = payload as JsonRecord;
	const keys = Object.keys(record);
	if (keys.length === 1 && "result" in record) {
		const result = record.result;
		if (typeof result === "string") {
			try {
				return parseJson(result);
			} catch {
				return result;
			}
		}
		return result;
	}
	return payload;
}

function findRpcResponse(
	messages: unknown[],
	expectedId?: number,
): JsonRecord | undefined {
	for (const message of messages) {
		const items = Array.isArray(message) ? message : [message];
		for (const item of items) {
			const record = asRecord(item);
			if (expectedId === undefined || record.id === expectedId) return record;
		}
	}
	return undefined;
}

function toolText(result: JsonRecord): string {
	const content = result.content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((item) => {
			const record = asRecord(item);
			return record.type === "text" && typeof record.text === "string"
				? [record.text]
				: [];
		})
		.join("\n");
}

function asRecord(value: unknown): JsonRecord {
	if (value && typeof value === "object" && !Array.isArray(value))
		return value as JsonRecord;
	throw new Error(`Expected object, got ${typeof value}`);
}

function asArray(value: unknown, label: string): unknown[] {
	if (Array.isArray(value)) return value;
	throw new Error(`Expected ${label} array`);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
	const text = optionalString(value);
	if (!text) throw new Error(`Missing ${label}`);
	return text;
}

function stringOr(value: unknown, fallback: string): string {
	return optionalString(value) ?? fallback;
}

function requiredStatus(value: unknown): TaskStatus {
	if (typeof value === "string" && TASK_STATUSES.has(value as TaskStatus)) {
		return value as TaskStatus;
	}
	throw new Error(`Unknown Hermes status: ${String(value)}`);
}

function resultStatus(value: unknown, error?: string): "completed" | "failed" {
	if (value === "completed" || value === "failed") return value;
	return error ? "failed" : "completed";
}

function optionalSession(record: JsonRecord): { sessionId?: string } {
	const sessionId = optionalString(
		record.sessionId ?? record.session_id ?? record.hermesSessionId,
	);
	return sessionId ? { sessionId } : {};
}

export function createHermesClient(config: HermesConfig): HermesMcpClient {
	return new HermesMcpClient(config);
}
