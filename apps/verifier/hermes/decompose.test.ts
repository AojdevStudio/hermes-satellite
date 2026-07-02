/**
 * Hermes decompose — unit tests (Phase 1 scaffold).
 *
 * Run: pnpm test (from apps/verifier)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { decomposeTranscript, _testing } from "./decompose.js";
import { parseExportJsonl } from "./transcript.js";
import {
	renderSatelliteVerifyPrompt,
	SATELLITE_VERIFY_DEFAULTS,
	_clearTemplateCache,
	defaultSatelliteVerifyTemplatePath,
} from "./satellite-prompt.js";
import { HermesMcpClient } from "./client.js";
import { loadHermesConfig, HermesConfigError } from "./config.js";
import {
	POLL_INITIAL_SEC,
	POLL_INTERVAL_SEC,
	MAX_WAIT_SEC,
	waitForHermes,
} from "./poll.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Source tree (works when tests run from compiled dist/hermes/). */
const hermesSourceDir = path.resolve(here, "..", "..", "hermes");
const fixturesDir = path.join(hermesSourceDir, "__fixtures__");

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (err) {
		throw new Error(`Invalid test JSON: ${(err as Error).message}`);
	}
}

describe("hermes/poll", () => {
	it("matches hermes-polling.md normative values", () => {
		assert.equal(POLL_INITIAL_SEC, 30);
		assert.equal(POLL_INTERVAL_SEC, 120);
		assert.equal(MAX_WAIT_SEC, 600);
	});

	it("calls hermes_result once on terminal status", async () => {
		const calls: string[] = [];
		const client = {
			async status(taskId: string) {
				calls.push(`status:${taskId}`);
				return { taskId, status: "completed" as const };
			},
			async result(taskId: string) {
				calls.push(`result:${taskId}`);
				return {
					taskId,
					status: "completed" as const,
					text: "PONG",
					cost: null,
				};
			},
		} as HermesMcpClient;

		const outcome = await waitForHermes(client, "t1", 0, {
			sleep: async () => {},
			now: () => 30_000,
		});

		assert.deepEqual(calls, ["status:t1", "result:t1"]);
		assert.equal("timeout" in outcome, false);
	});

	it("times out without fetching result for non-terminal status", async () => {
		const calls: string[] = [];
		const client = {
			async status(taskId: string) {
				calls.push(`status:${taskId}`);
				return { taskId, status: "running" as const };
			},
			async result() {
				calls.push("result");
				throw new Error("should not fetch result before terminal status");
			},
		} as unknown as HermesMcpClient;

		const outcome = await waitForHermes(client, "t1", 0, {
			sleep: async () => {},
			now: () => 601_000,
		});

		assert.deepEqual(calls, ["status:t1"]);
		assert.deepEqual(outcome, {
			timeout: true,
			taskId: "t1",
			lastStatus: "running",
			elapsedMs: 601_000,
		});
	});
});

describe("hermes/client", () => {
	it("uses Streamable HTTP JSON-RPC with bearer auth and session header", async () => {
		const requests: Array<{ headers: Headers; body: Record<string, unknown> }> =
			[];
		const fetchImpl = async (
			_url: string | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const headers = new Headers(init?.headers);
			const body = parseJson(String(init?.body)) as Record<string, unknown>;
			requests.push({ headers, body });

			if (body.method === "initialize") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: { protocolVersion: "2025-06-18" },
					}),
					{
						headers: {
							"content-type": "application/json",
							"mcp-session-id": "mcp-session",
						},
					},
				);
			}
			if (body.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						structuredContent: { task_id: "task-1", session_id: "session-1" },
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};

		const client = new HermesMcpClient(
			{ mcpUrl: "http://127.0.0.1:8081/mcp", mcpToken: "secret" },
			fetchImpl,
		);

		const submitted = await client.submit({
			prompt: "Reply PONG",
			caller: "pi",
		});

		assert.deepEqual(submitted, { taskId: "task-1", sessionId: "session-1" });
		assert.equal(requests[0]?.headers.get("authorization"), "Bearer secret");
		assert.equal(requests[2]?.headers.get("mcp-session-id"), "mcp-session");
		assert.equal(requests[2]?.body.method, "tools/call");
		assert.deepEqual(requests[2]?.body.params, {
			name: "hermes_submit",
			arguments: { prompt: "Reply PONG", caller: "pi" },
		});
	});

	it("unwraps bridge structuredContent.result JSON strings", async () => {
		const fetchImpl = async (
			_url: string | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const body = parseJson(String(init?.body)) as Record<string, unknown>;
			if (body.method === "initialize") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: { protocolVersion: "2025-06-18" },
					}),
					{ headers: { "content-type": "application/json" } },
				);
			}
			if (body.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						structuredContent: {
							result:
								'{"task_id":"task-structured","status":"pending","message":"ok"}',
						},
						isError: false,
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};

		const client = new HermesMcpClient(
			{ mcpUrl: "http://127.0.0.1:8081/mcp", mcpToken: "secret" },
			fetchImpl,
		);

		const submitted = await client.submit({ prompt: "Reply PONG" });
		assert.deepEqual(submitted, { taskId: "task-structured" });
	});
});

describe("hermes/config", () => {
	it("throws when required env vars missing", () => {
		assert.throws(
			() => loadHermesConfig({}),
			(err: unknown) => err instanceof HermesConfigError,
		);
	});

	it("loads when HERMES_MCP_URL and HERMES_MCP_TOKEN set", () => {
		const cfg = loadHermesConfig({
			HERMES_MCP_URL: "http://127.0.0.1:8081/mcp",
			HERMES_MCP_TOKEN: "test-token",
			HERMES_CALLBACK_URL: "http://localhost/cb",
		});
		assert.equal(cfg.mcpUrl, "http://127.0.0.1:8081/mcp");
		assert.equal(cfg.mcpToken, "test-token");
		assert.equal(cfg.callbackUrl, "http://localhost/cb");
	});
});

describe("hermes/decompose", () => {
	it("parses ## Acceptance bullets from dispatch prompt", () => {
		const bullets = _testing.parseAcceptanceBullets(
			"## Task\nDo thing\n\n## Acceptance\n- First criterion\n- Second criterion\n\n## Constraints\nnone",
		);
		assert.deepEqual(bullets, ["First criterion", "Second criterion"]);
	});

	it("pairs tool_calls with tool results (rule 1)", () => {
		const { claims } = decomposeTranscript({
			originalPrompt: "",
			transcript: {
				sessionId: "s1",
				messages: [
					{
						role: "assistant",
						tool_calls: [
							{ id: "t1", name: "bash", function: { arguments: "pnpm test" } },
						],
					},
					{
						role: "tool",
						tool_call_id: "t1",
						name: "bash",
						content: "1 passed",
					},
				],
			},
		});

		const toolClaims = claims.filter((c) => c.kind === "tool_execution");
		assert.equal(toolClaims.length, 1);
		assert.equal(toolClaims[0]?.embeddedEvidence, "1 passed");
		assert.equal(toolClaims[0]?.source.toolCallId, "t1");
	});

	it("passes golden fixture acceptance-and-tool-pairing", () => {
		const raw = readFileSync(
			path.join(fixturesDir, "acceptance-and-tool-pairing.json"),
			"utf8",
		);
		const fixture = parseJson(raw) as {
			transcript: { sessionId: string; messages: unknown[] };
			originalPrompt: string;
			expected: {
				userRequirements: string[];
				toolCallIds: string[];
				minToolExecutions: number;
			};
		};

		const { claims } = decomposeTranscript({
			transcript: fixture.transcript as Parameters<
				typeof decomposeTranscript
			>[0]["transcript"],
			originalPrompt: fixture.originalPrompt,
		});

		const reqs = claims
			.filter((c) => c.kind === "user_requirement")
			.map((c) => c.text);
		for (const expected of fixture.expected.userRequirements) {
			assert.ok(
				reqs.includes(expected),
				`missing user_requirement: ${expected}`,
			);
		}

		const tools = claims.filter((c) => c.kind === "tool_execution");
		assert.ok(tools.length >= fixture.expected.minToolExecutions);
		for (const id of fixture.expected.toolCallIds) {
			assert.ok(
				tools.some((t) => t.source.toolCallId === id),
				`missing tool_execution for ${id}`,
			);
		}
	});
});

describe("hermes/transcript parseExportJsonl", () => {
	it("parses reduced session object export", () => {
		const parsed = parseExportJsonl(
			JSON.stringify({
				sessionId: "abc",
				messages: [{ role: "user", content: "hi" }],
			}),
		);
		assert.equal(parsed.sessionId, "abc");
		assert.equal(parsed.messages.length, 1);
	});
});

describe("hermes/satellite-prompt", () => {
	it("fills defaults so no raw placeholders leak", () => {
		_clearTemplateCache();
		const template = readFileSync(defaultSatelliteVerifyTemplatePath(), "utf8");
		const rendered = renderSatelliteVerifyPrompt({}, template);
		assert.ok(!rendered.includes("<HERMES_TASK_ID>"));
		assert.ok(rendered.includes(SATELLITE_VERIFY_DEFAULTS.HERMES_TASK_ID));
		assert.ok(rendered.includes(SATELLITE_VERIFY_DEFAULTS.EVIDENCE_TIER));
	});
});
