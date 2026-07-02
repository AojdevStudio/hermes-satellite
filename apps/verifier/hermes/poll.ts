/**
 * Hermes async polling — constants and wait loop.
 *
 * Normative values from hermes-polling.md.
 */

import type { HermesMcpClient } from "./client.js";
import type { HermesPollOutcome, TaskId } from "./types.js";

/** First sleep after submit — catch fast tasks (ping, tiny edits). */
export const POLL_INITIAL_SEC = 30;

/** Interval while status is running/pending — ~5 checks inside 600s window. */
export const POLL_INTERVAL_SEC = 120;

/** Hard stop from submit time — matches Hermes task timeout. */
export const MAX_WAIT_SEC = 600;

export const POLL_INITIAL_MS = POLL_INITIAL_SEC * 1000;
export const POLL_INTERVAL_MS = POLL_INTERVAL_SEC * 1000;
export const MAX_WAIT_MS = MAX_WAIT_SEC * 1000;

export interface PollOptions {
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
	initialMs?: number;
	intervalMs?: number;
	maxWaitMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted)
		return Promise.reject(new Error("Hermes poll cancelled"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Hermes poll cancelled"));
			},
			{ once: true },
		);
	});
}

/**
 * Poll `hermes_status` until terminal status or timeout.
 *
 * Always calls `hermes_result` once on completed/failed.
 */
export async function waitForHermes(
	client: HermesMcpClient,
	taskId: TaskId,
	submitTimeMs: number = Date.now(),
	options: PollOptions = {},
): Promise<HermesPollOutcome> {
	const now = options.now ?? Date.now;
	const sleepFn = options.sleep ?? sleep;
	const initialMs = options.initialMs ?? POLL_INITIAL_MS;
	const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
	const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;

	await sleepFn(initialMs, options.signal);

	while (true) {
		const { status } = await client.status(taskId, options.signal);
		if (status === "completed" || status === "failed") {
			return client.result(taskId, options.signal);
		}

		const elapsedMs = now() - submitTimeMs;
		if (elapsedMs >= maxWaitMs) {
			return { timeout: true, taskId, lastStatus: status, elapsedMs };
		}

		await sleepFn(intervalMs, options.signal);
	}
}

/** Exported for tests — preserves the Phase 1 smoke helper name. */
export async function pollLoopStub(): Promise<void> {
	await sleep(0);
}
