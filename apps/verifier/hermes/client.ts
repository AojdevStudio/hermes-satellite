/**
 * Hermes MCP HTTP client (Streamable HTTP + Bearer auth).
 */

import type { HermesConfig } from "./config.js";
import type { HermesResult, TaskCostSnapshot, TaskId, TaskStatus } from "./types.js";
import Type, { type StaticParse, type TSchema } from "typebox";
import { Parse } from "typebox/value";

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

interface McpToolArguments {
	prompt?: string;
	caller?: string;
	task_id?: string;
	message?: string;
	session_id?: string;
}

interface JsonRpcParams {
	name?: string;
	arguments?: McpToolArguments;
	protocolVersion?: string;
	capabilities?: object;
	clientInfo?: { name: string; version: string };
}

interface JsonRpcRequestBody {
	jsonrpc: "2.0";
	id?: number;
	method: string;
	params?: JsonRpcParams;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";
const StringSchema = Type.String();
const JsonPayloadSchema = Type.Cyclic(
	{
		Json: Type.Union([
			Type.String(),
			Type.Number(),
			Type.Boolean(),
			Type.Null(),
			Type.Array(Type.This()),
			Type.Record(Type.String(), Type.This()),
		]),
	},
	"Json",
);
const IgnoredResultSchema = Type.Union([
	JsonPayloadSchema,
	Type.Undefined(),
]);
type JsonPayload = StaticParse<typeof JsonPayloadSchema>;
type McpPayload = JsonPayload | undefined;
const StatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("failed"),
]);
const SessionFields = {
	sessionId: Type.Optional(Type.String()),
	session_id: Type.Optional(Type.String()),
	hermesSessionId: Type.Optional(Type.String()),
};
const SubmitSchema = Type.Object({
	taskId: Type.Optional(Type.String()),
	task_id: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
	...SessionFields,
});
const StatusResponseSchema = Type.Object({
	taskId: Type.Optional(Type.String()),
	task_id: Type.Optional(Type.String()),
	status: Type.Optional(StatusSchema),
	...SessionFields,
});
const CostSchema = Type.Union([
	Type.Null(),
	Type.Object({
		taskId: Type.String(),
		hermesSessionId: Type.String(),
		loopIndex: Type.Number(),
		provider: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		promptTokens: Type.Optional(Type.Number()),
		completionTokens: Type.Optional(Type.Number()),
		totalTokens: Type.Optional(Type.Number()),
		estimatedUsd: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
		perModelBreakdown: Type.Optional(
			Type.Array(
				Type.Object({
					model: Type.String(),
					promptTokens: Type.Number(),
					completionTokens: Type.Number(),
					estimatedUsd: Type.Optional(
						Type.Union([Type.Number(), Type.Null()]),
					),
				}),
			),
		),
		expensiveToolsUsed: Type.Optional(Type.Array(Type.String())),
		costSource: Type.Optional(
			Type.Union([
				Type.Literal("provider_models_api"),
				Type.Literal("none"),
				Type.Literal("estimated"),
				Type.Null(),
			]),
		),
		billingProvider: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		billingMode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		pricingVersion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		costUnreconciled: Type.Optional(Type.Boolean()),
		source: Type.Union([
			Type.Literal("state.db"),
			Type.Literal("hermes_usage_api"),
			Type.Literal("estimated"),
		]),
		capturedAt: Type.String(),
	}),
]);
const ResultSchema = Type.Union([
	Type.String(),
	Type.Object({
		taskId: Type.Optional(Type.String()),
		task_id: Type.Optional(Type.String()),
		status: Type.Optional(
			Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
		),
		text: Type.Optional(Type.String()),
		output: Type.Optional(Type.String()),
		result: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
		error: Type.Optional(Type.String()),
		cost: Type.Optional(CostSchema),
		...SessionFields,
	}),
]);
const TaskSchema = Type.Object({
	taskId: Type.Optional(Type.String()),
	task_id: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
	status: Type.Optional(StatusSchema),
});
const ListSchema = Type.Union([
	Type.Array(TaskSchema),
	Type.Object({ tasks: Type.Array(TaskSchema) }),
]);
const TranscriptSchema = Type.Union([
	Type.String(),
	Type.Object({
		transcript: Type.Optional(Type.String()),
		text: Type.Optional(Type.String()),
		content: Type.Optional(Type.String()),
		jsonl: Type.Optional(Type.String()),
	}),
]);
const ToolResultSchema = Type.Object({
	isError: Type.Optional(Type.Boolean()),
	structuredContent: Type.Optional(Type.Unknown()),
	content: Type.Optional(
		Type.Array(
			Type.Object({
				type: Type.String(),
				text: Type.Optional(Type.String()),
			}),
		),
	),
});
const JsonRpcResponseSchema = Type.Object({
	id: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
	result: Type.Optional(Type.Unknown()),
	error: Type.Optional(
		Type.Object({ message: Type.Optional(Type.String()) }),
	),
});

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
		const args: HermesSubmitParams = { prompt: params.prompt };
		if (params.caller) args.caller = params.caller;
		const record = await this.callTool(
			"hermes_submit",
			args,
			SubmitSchema,
			signal,
		);
		const response: HermesSubmitResponse = {
			taskId: requiredString(
				record.taskId ?? record.task_id ?? record.id,
				"hermes_submit task_id",
			),
		};
		const sessionId = getSession(record);
		if (sessionId) response.sessionId = sessionId;
		return response;
	}

	async status(
		taskId: TaskId,
		signal?: AbortSignal,
	): Promise<HermesStatusResponse> {
		const record = await this.callTool(
			"hermes_status",
			{ task_id: taskId },
			StatusResponseSchema,
			signal,
		);
		const status = requiredStatus(record.status);
		const response: HermesStatusResponse = {
			taskId: stringOr(record.taskId ?? record.task_id, taskId),
			status,
		};
		const sessionId = getSession(record);
		if (sessionId) response.sessionId = sessionId;
		return response;
	}

	async result(taskId: TaskId, signal?: AbortSignal): Promise<HermesResult> {
		const raw = await this.callTool(
			"hermes_result",
			{ task_id: taskId },
			ResultSchema,
			signal,
		);
		const record = raw instanceof Object ? raw : { text: raw };
		const error = optionalString(record.error);
		const result: HermesResult = {
			taskId: stringOr(record.taskId ?? record.task_id, taskId),
			status: resultStatus(record.status, error),
			text: stringOr(
				record.text ?? record.output ?? record.result ?? record.message,
				error ?? "",
			),
			cost: normalizeCost(record.cost),
		};
		const sessionId = getSession(record);
		if (sessionId) result.sessionId = sessionId;
		if (error) result.error = error;
		return result;
	}

	async respond(
		params: HermesRespondParams,
		signal?: AbortSignal,
	): Promise<void> {
		await this.callTool(
			"hermes_respond",
			{ task_id: params.taskId, message: params.message },
			IgnoredResultSchema,
			signal,
		);
	}

	async cancel(taskId: TaskId, signal?: AbortSignal): Promise<void> {
		await this.callTool(
			"hermes_cancel",
			{ task_id: taskId },
			IgnoredResultSchema,
			signal,
		);
	}

	async list(
		signal?: AbortSignal,
	): Promise<Array<{ taskId: TaskId; status: TaskStatus }>> {
		const raw = await this.callTool("hermes_list", {}, ListSchema, signal);
		const tasks = Array.isArray(raw)
			? raw
			: raw.tasks;
		return tasks.map((item) => {
			return {
				taskId: requiredString(
					item.taskId ?? item.task_id ?? item.id,
					"task_id",
				),
				status: requiredStatus(item.status),
			};
		});
	}

	async sessions(sessionId?: string, signal?: AbortSignal): Promise<McpPayload> {
		const args: McpToolArguments = {};
		if (sessionId) args.session_id = sessionId;
		return this.callTool(
			"hermes_sessions",
			args,
			JsonPayloadSchema,
			signal,
		);
	}

	async transcript(sessionId: string, signal?: AbortSignal): Promise<string> {
		const raw = await this.callTool(
			"hermes_transcript",
			{ session_id: sessionId },
			TranscriptSchema,
			signal,
		);
		if (!(raw instanceof Object)) return raw;
		return requiredString(
			raw.transcript ?? raw.text ?? raw.content ?? raw.jsonl,
			"hermes_transcript text",
		);
	}

	private async callTool<const Schema extends TSchema>(
		name: string,
		args: McpToolArguments,
		schema: Schema,
		signal?: AbortSignal,
	): Promise<StaticParse<Schema>> {
		await this.ensureInitialized(signal);
		const result = Parse(
			ToolResultSchema,
			await this.rpcRequest("tools/call", { name, arguments: args }, signal),
		);

		if (result.isError === true) {
			throw new Error(`${name}: ${toolText(result) || "tool failed"}`);
		}
		if ("structuredContent" in result) {
			return Parse(
				schema,
				normalizeToolPayload(Parse(JsonPayloadSchema, result.structuredContent)),
			);
		}

		const text = toolText(result);
		if (!text) {
			return Parse(
				schema,
				normalizeToolPayload(Parse(JsonPayloadSchema, result)),
			);
		}
		try {
			return Parse(schema, normalizeToolPayload(parseJson(text)));
		} catch {
			return Parse(schema, text);
		}
	}

	private ensureInitialized(signal?: AbortSignal): Promise<void> {
		this.initialized ??= this.initialize(signal);
		return this.initialized;
	}

	private async initialize(signal?: AbortSignal): Promise<void> {
		const result = Parse(
			Type.Object({ protocolVersion: Type.Optional(Type.String()) }),
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
		params: JsonRpcParams,
		signal?: AbortSignal,
		includeSession = true,
	): Promise<McpPayload> {
		const id = this.nextRequestId++;
		return this.postJsonRpc(
			{ jsonrpc: "2.0", id, method, params },
			id,
			signal,
			includeSession,
		);
	}

	private async postJsonRpc(
		body: JsonRpcRequestBody,
		expectedId?: number,
		signal?: AbortSignal,
		includeSession = true,
	): Promise<McpPayload> {
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
			throw new Error(`MCP ${stringOr(message.error.message, "request failed")}`);
		}
		if (message.result === undefined) return undefined;
		return Parse(JsonPayloadSchema, message.result);
	}

	private headers(includeSession: boolean): Headers {
		const headers = new Headers({
			Authorization: `Bearer ${this.config.mcpToken}`,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"MCP-Protocol-Version": this.protocolVersion,
		});
		if (includeSession && this.mcpSessionId)
			headers.set("Mcp-Session-Id", this.mcpSessionId);
		return headers;
	}
}

function parseSseMessages(text: string): JsonPayload[] {
	const messages: JsonPayload[] = [];
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

function parseJson(text: string): JsonPayload {
	try {
		return Parse(JsonPayloadSchema, JSON.parse(text));
	} catch (cause) {
		throw new Error(
			`Invalid MCP JSON response: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
}

function normalizeToolPayload(payload: JsonPayload): JsonPayload {
	if (!(payload instanceof Object) || Array.isArray(payload)) {
		return payload;
	}
	const keys = Object.keys(payload);
	if (keys.length === 1 && "result" in payload) {
		const result = Parse(JsonPayloadSchema, payload.result);
		try {
			const text = Parse(StringSchema, result);
			try {
				return parseJson(text);
			} catch {
				return text;
			}
		} catch {
			return result;
		}
	}
	return payload;
}

function findRpcResponse(
	messages: JsonPayload[],
	expectedId?: number,
) {
	for (const message of messages) {
		const items = Array.isArray(message) ? message : [message];
		for (const item of items) {
			const record = Parse(JsonRpcResponseSchema, item);
			if (expectedId === undefined || record.id === expectedId) return record;
		}
	}
	return undefined;
}

function toolText(result: StaticParse<typeof ToolResultSchema>): string {
	const content = result.content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((item) => {
			return item.type === "text" && item.text !== undefined
				? [item.text]
				: [];
		})
		.join("\n");
}

function optionalString(value?: string | null): string | undefined {
	return value && value.length > 0 ? value : undefined;
}

function requiredString(value: string | undefined, label: string): string {
	const text = optionalString(value);
	if (!text) throw new Error(`Missing ${label}`);
	return text;
}

function stringOr(value: string | undefined, fallback: string): string {
	return optionalString(value) ?? fallback;
}

function requiredStatus(value?: TaskStatus): TaskStatus {
	if (value) return value;
	throw new Error(`Unknown Hermes status: ${String(value)}`);
}

function resultStatus(
	value?: "completed" | "failed",
	error?: string,
): "completed" | "failed" {
	if (value === "completed" || value === "failed") return value;
	return error ? "failed" : "completed";
}

function getSession(record: {
	sessionId?: string;
	session_id?: string;
	hermesSessionId?: string;
}): string | undefined {
	return optionalString(
		record.sessionId ?? record.session_id ?? record.hermesSessionId,
	);
}

function normalizeCost(
	cost: StaticParse<typeof CostSchema> | undefined,
): TaskCostSnapshot | null {
	if (!cost) return null;
	const snapshot: TaskCostSnapshot = {
		taskId: cost.taskId,
		hermesSessionId: cost.hermesSessionId,
		loopIndex: cost.loopIndex,
		source: cost.source,
		capturedAt: cost.capturedAt,
	};
	if (cost.provider) snapshot.provider = cost.provider;
	if (cost.model) snapshot.model = cost.model;
	if (cost.promptTokens !== undefined) snapshot.promptTokens = cost.promptTokens;
	if (cost.completionTokens !== undefined) snapshot.completionTokens = cost.completionTokens;
	if (cost.totalTokens !== undefined) snapshot.totalTokens = cost.totalTokens;
	if (cost.estimatedUsd !== undefined) snapshot.estimatedUsd = cost.estimatedUsd;
	if (cost.perModelBreakdown !== undefined) {
		snapshot.perModelBreakdown = cost.perModelBreakdown;
	}
	if (cost.expensiveToolsUsed !== undefined) {
		snapshot.expensiveToolsUsed = cost.expensiveToolsUsed;
	}
	if (cost.costSource !== undefined) snapshot.costSource = cost.costSource;
	if (cost.billingProvider) snapshot.billingProvider = cost.billingProvider;
	if (cost.billingMode) snapshot.billingMode = cost.billingMode;
	if (cost.pricingVersion) snapshot.pricingVersion = cost.pricingVersion;
	if (cost.costUnreconciled !== undefined) {
		snapshot.costUnreconciled = cost.costUnreconciled;
	}
	return snapshot;
}

export function createHermesClient(config: HermesConfig): HermesMcpClient {
	return new HermesMcpClient(config);
}
