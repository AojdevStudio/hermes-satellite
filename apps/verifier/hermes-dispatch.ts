/**
 * Hermes satellite verify — Pi extension.
 *
 * Registers dispatch MCP tool wrappers that delegate to `HermesMcpClient`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { loadDotEnv } from "./_shared/env.js";
import { createHermesClient } from "./hermes/client.js";
import type { HermesMcpClient } from "./hermes/client.js";
import { decomposeTranscript } from "./hermes/decompose.js";
import { parseExportJsonl } from "./hermes/transcript.js";
import { loadHermesConfig, isHermesConfigured } from "./hermes/config.js";
import {
	MAX_WAIT_SEC,
	POLL_INITIAL_SEC,
	POLL_INTERVAL_SEC,
	waitForHermes,
} from "./hermes/poll.js";

interface HermesToolParams {
	task_id?: string;
	prompt?: string;
	caller?: string;
	message?: string;
	session_id?: string;
	transcript_json?: string;
	original_prompt?: string;
	wait_for_result?: boolean;
}

function toolResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

async function clientFor(cwd: string): Promise<HermesMcpClient> {
	await loadDotEnv(cwd);
	return createHermesClient(loadHermesConfig());
}

function requireParam(
	params: HermesToolParams,
	name: keyof HermesToolParams,
): string {
	const value = params[name];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${String(name)} is required`);
	}
	return value.trim();
}

export default function hermesDispatchExtension(pi: ExtensionAPI): void {
	pi.registerFlag("hermes-dispatch", {
		type: "boolean",
		description: "Enable Hermes satellite dispatch tools",
	});

	pi.registerTool({
		name: "hermes_submit",
		label: "hermes submit",
		description:
			"Submit structured work to Hermes and poll until terminal status or timeout.",
		parameters: Type.Object({
			prompt: Type.String({
				description: "Structured Hermes prompt with ## Acceptance.",
			}),
			caller: Type.Optional(
				Type.String({ description: "Caller label; defaults to pi." }),
			),
			wait_for_result: Type.Optional(
				Type.Boolean({
					description: "Poll internally after submit. Defaults to true.",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params: HermesToolParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const client = await clientFor(ctx.cwd);
			const submitted = await client.submit(
				{
					prompt: requireParam(params, "prompt"),
					caller: params.caller ?? "pi",
				},
				signal,
			);

			if (params.wait_for_result === false) {
				return toolResult(`Submitted Hermes task ${submitted.taskId}`, {
					ok: true,
					submitted,
				});
			}

			const outcome = await waitForHermes(
				client,
				submitted.taskId,
				Date.now(),
				{ signal },
			);
			return toolResult(JSON.stringify({ submitted, outcome }, null, 2), {
				ok: true,
				submitted,
				outcome,
				pollConstants: { POLL_INITIAL_SEC, POLL_INTERVAL_SEC, MAX_WAIT_SEC },
			});
		},
	});

	pi.registerTool({
		name: "hermes_status",
		label: "hermes status",
		description: "Fetch Hermes task status.",
		parameters: Type.Object({ task_id: Type.String() }),
		async execute(
			_toolCallId,
			params: HermesToolParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const client = await clientFor(ctx.cwd);
			const status = await client.status(
				requireParam(params, "task_id"),
				signal,
			);
			return toolResult(JSON.stringify(status, null, 2), { ok: true, status });
		},
	});

	pi.registerTool({
		name: "hermes_result",
		label: "hermes result",
		description: "Fetch Hermes task result after terminal status.",
		parameters: Type.Object({ task_id: Type.String() }),
		async execute(
			_toolCallId,
			params: HermesToolParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const client = await clientFor(ctx.cwd);
			const result = await client.result(
				requireParam(params, "task_id"),
				signal,
			);
			return toolResult(JSON.stringify(result, null, 2), { ok: true, result });
		},
	});

	pi.registerTool({
		name: "hermes_respond",
		label: "hermes respond",
		description:
			"Send corrective follow-up to an existing Hermes task/session.",
		parameters: Type.Object({ task_id: Type.String(), message: Type.String() }),
		async execute(
			_toolCallId,
			params: HermesToolParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const client = await clientFor(ctx.cwd);
			const taskId = requireParam(params, "task_id");
			await client.respond(
				{ taskId, message: requireParam(params, "message") },
				signal,
			);
			return toolResult(`Sent Hermes response for ${taskId}`, {
				ok: true,
				taskId,
			});
		},
	});

	pi.registerTool({
		name: "hermes_cancel",
		label: "hermes cancel",
		description: "Cancel a Hermes task.",
		parameters: Type.Object({ task_id: Type.String() }),
		async execute(
			_toolCallId,
			params: HermesToolParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const client = await clientFor(ctx.cwd);
			const taskId = requireParam(params, "task_id");
			await client.cancel(taskId, signal);
			return toolResult(`Cancelled Hermes task ${taskId}`, {
				ok: true,
				taskId,
			});
		},
	});

	pi.registerTool({
		name: "hermes_list",
		label: "hermes list",
		description: "List Hermes tasks known to the bridge.",
		parameters: Type.Object({}),
		async execute(
			_toolCallId,
			_params: HermesToolParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const client = await clientFor(ctx.cwd);
			const tasks = await client.list(signal);
			return toolResult(JSON.stringify(tasks, null, 2), { ok: true, tasks });
		},
	});

	pi.registerTool({
		name: "hermes_decompose",
		label: "hermes decompose",
		description:
			"Decompose a Hermes T2 transcript export into deterministic atomic claims.",
		parameters: Type.Object({
			transcript_json: Type.Optional(
				Type.String({
					description:
						"Hermes sessions export JSON/JSONL body. If omitted, session_id is fetched with hermes_transcript.",
				}),
			),
			session_id: Type.Optional(
				Type.String({ description: "Hermes session id to fetch via hermes_transcript." }),
			),
			original_prompt: Type.Optional(
				Type.String({ description: "Original dispatch prompt with ## Acceptance." }),
			),
		}),
		async execute(
			_toolCallId,
			params: HermesToolParams,
			signal,
			_onUpdate,
			ctx,
		) {
			let transcriptJson = params.transcript_json;
			if (!transcriptJson) {
				const sessionId = requireParam(params, "session_id");
				const client = await clientFor(ctx.cwd);
				transcriptJson = await client.transcript(sessionId, signal);
			}

			const transcript = parseExportJsonl(transcriptJson);
			const output = decomposeTranscript({
				transcript,
				originalPrompt: params.original_prompt ?? params.prompt ?? "",
			});
			return toolResult(JSON.stringify(output, null, 2), {
				ok: true,
				...output,
			});
		},
	});

	pi.registerTool({
		name: "hermes_transcript",
		label: "hermes transcript",
		description:
			"Fetch Hermes transcript export when the bridge exposes hermes_transcript.",
		parameters: Type.Object({ session_id: Type.String() }),
		async execute(
			_toolCallId,
			params: HermesToolParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const client = await clientFor(ctx.cwd);
			const transcript = await client.transcript(
				requireParam(params, "session_id"),
				signal,
			);
			return toolResult(transcript, { ok: true });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!pi.getFlag("hermes-dispatch")) return;

		const envResult = await loadDotEnv(ctx.cwd);
		if (!envResult.loaded && envResult.reason) {
			ctx.ui.notify(`hermes-dispatch: ${envResult.reason}`, "warning");
		}

		if (!isHermesConfigured()) {
			ctx.ui.notify(
				"hermes-dispatch: set HERMES_MCP_URL and HERMES_MCP_TOKEN in .env (see .env.sample)",
				"warning",
			);
			return;
		}

		try {
			const client = createHermesClient(loadHermesConfig());
			ctx.ui.notify(
				`hermes-dispatch: MCP client ready (${client.url})`,
				"info",
			);
		} catch (err) {
			ctx.ui.notify(`hermes-dispatch: ${(err as Error).message}`, "error");
		}
	});
}
