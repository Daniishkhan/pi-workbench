import { randomUUID } from "node:crypto";
import type { DelegationProgress, WorkflowAgentResult, WorkflowAgentTask } from "./types.ts";

const PROTOCOL_VERSION = 1;
const REQUEST_EVENT = "prompt-template:subagent:request";
const STARTED_EVENT = "prompt-template:subagent:started";
const UPDATE_EVENT = "prompt-template:subagent:update";
const RESPONSE_EVENT = "prompt-template:subagent:response";
const CANCEL_EVENT = "prompt-template:subagent:cancel";
const START_ACK_TIMEOUT_MS = 10_000;
const CANCEL_ACK_TIMEOUT_MS = 10_000;

export interface WorkflowEventBus {
	on(event: string, handler: (payload: unknown) => void): (() => void) | void;
	emit(event: string, payload: unknown): void;
}

export interface DelegationRunOptions {
	cwd: string;
	context: "fresh" | "fork";
	model?: string;
	signal?: AbortSignal;
	onProgress?: (progress: DelegationProgress) => void;
}

interface VersionedResponse {
	version: number;
	requestId: string;
	status: WorkflowAgentResult["status"] | "turn_budget_exhausted" | "tool_budget_exhausted" | "acceptance_failed" | "invalid_request" | "unavailable_context";
	error?: string;
	agent?: string;
	model?: string;
	output?: string;
	outputPath?: string;
	sessionFile?: string;
	turns?: number;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
	warnings?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapStatus(status: VersionedResponse["status"]): WorkflowAgentResult["status"] {
	if (status === "completed") return "completed";
	if (status === "cancelled") return "cancelled";
	if (status === "timed_out") return "timed_out";
	if (status === "interrupted") return "interrupted";
	return "failed";
}

function removeListener(unsubscribe: (() => void) | void): void {
	if (typeof unsubscribe === "function") unsubscribe();
}

export class DelegationClient {
	readonly #events: WorkflowEventBus;
	#disposed = false;
	#active = new Set<{ cancel: (reason?: string) => void; force: (reason: string) => void }>();

	constructor(events: WorkflowEventBus) {
		this.#events = events;
	}

	async runSingle(task: WorkflowAgentTask, options: DelegationRunOptions): Promise<WorkflowAgentResult> {
		if (this.#disposed) throw new Error("Dynamic-workflows delegation client is disposed.");
		const requestId = `workflow-${randomUUID()}`;
		return new Promise<WorkflowAgentResult>((resolve, reject) => {
			let settled = false;
			let acknowledged = false;
			let cancelling = false;
			let cancelTimer: ReturnType<typeof setTimeout> | undefined;
			let startedUnsub: (() => void) | void;
			let updateUnsub: (() => void) | void;
			let responseUnsub: (() => void) | void;
			let abortHandler: (() => void) | undefined;
			let startTimer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (startTimer) clearTimeout(startTimer);
				if (cancelTimer) clearTimeout(cancelTimer);
				removeListener(startedUnsub);
				removeListener(updateUnsub);
				removeListener(responseUnsub);
				if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
				this.#active.delete(active);
			};
			const force = (reason: string) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error(reason));
			};
			const acknowledge = () => {
				if (acknowledged) return;
				acknowledged = true;
				if (startTimer) clearTimeout(startTimer);
			};
			const cancel = (reason = `Delegated workflow agent cancellation was not acknowledged within ${CANCEL_ACK_TIMEOUT_MS / 1_000} seconds.`) => {
				if (settled || cancelling) return;
				cancelling = true;
				acknowledge();
				this.#events.emit(CANCEL_EVENT, { version: PROTOCOL_VERSION, requestId });
				cancelTimer = setTimeout(() => force(reason), CANCEL_ACK_TIMEOUT_MS);
				cancelTimer.unref?.();
			};
			const active = { cancel, force };
			this.#active.add(active);

			startedUnsub = this.#events.on(STARTED_EVENT, (payload) => {
				if (!isRecord(payload) || payload.version !== PROTOCOL_VERSION || payload.requestId !== requestId) return;
				acknowledge();
				options.onProgress?.({ requestId, agent: task.agent });
			});
			updateUnsub = this.#events.on(UPDATE_EVENT, (payload) => {
				if (!isRecord(payload) || payload.version !== PROTOCOL_VERSION || payload.requestId !== requestId) return;
				acknowledge();
				options.onProgress?.({
					requestId,
					agent: task.agent,
					currentTool: typeof payload.currentTool === "string" ? payload.currentTool : undefined,
					recentOutput: typeof payload.recentOutput === "string" ? payload.recentOutput : undefined,
					toolCount: typeof payload.toolCount === "number" ? payload.toolCount : undefined,
					durationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
					tokens: typeof payload.tokens === "number" ? payload.tokens : undefined,
				});
			});
			responseUnsub = this.#events.on(RESPONSE_EVENT, (payload) => {
				if (!isRecord(payload) || payload.version !== PROTOCOL_VERSION || payload.requestId !== requestId) return;
				acknowledge();
				settled = true;
				cleanup();
				const response = payload as unknown as VersionedResponse;
				resolve({
					agent: response.agent ?? task.agent,
					status: mapStatus(response.status),
					output: response.output ?? "",
					...(response.error ? { error: response.error } : {}),
					...(response.model ? { model: response.model } : {}),
					...(typeof response.durationMs === "number" ? { durationMs: response.durationMs } : {}),
					...(typeof response.turns === "number" ? { turns: response.turns } : {}),
					...(typeof response.toolCount === "number" ? { toolCount: response.toolCount } : {}),
					...(typeof response.tokens === "number" ? { tokens: response.tokens } : {}),
					...(response.outputPath ? { outputPath: response.outputPath } : {}),
					...(response.sessionFile ? { sessionFile: response.sessionFile } : {}),
					...(response.warnings ? { warnings: response.warnings } : {}),
				});
			});

			abortHandler = () => cancel();
			if (options.signal?.aborted) {
				abortHandler();
				return;
			}
			options.signal?.addEventListener("abort", abortHandler, { once: true });
			startTimer = setTimeout(
				() => cancel("pi-subagents did not acknowledge the versioned workflow delegation request."),
				START_ACK_TIMEOUT_MS,
			);
			startTimer.unref?.();
			this.#events.emit(REQUEST_EVENT, {
				version: PROTOCOL_VERSION,
				requestId,
				agent: task.agent,
				task: task.task,
				context: options.context,
				cwd: options.cwd,
				...(task.model ?? options.model ? { model: task.model ?? options.model } : {}),
				...(task.timeoutMs ? { timeoutMs: task.timeoutMs } : {}),
				...(task.turnBudget ? { turnBudget: task.turnBudget } : {}),
				...(task.toolBudget ? { toolBudget: task.toolBudget } : {}),
				output: false,
				artifacts: true,
			});
		});
	}

	async runParallel(
		tasks: WorkflowAgentTask[],
		options: DelegationRunOptions & { worktree?: boolean; concurrency?: number },
	): Promise<WorkflowAgentResult[]> {
		if (this.#disposed) throw new Error("Dynamic-workflows delegation client is disposed.");
		if (options.worktree) {
			throw new Error("Dynamic workflows do not create or merge temporary worktrees. Use read-only parallel nodes or serialize one writer.");
		}
		if (tasks.length === 0) return [];
		const limit = Math.max(1, Math.min(options.concurrency ?? tasks.length, tasks.length));
		const results = new Array<WorkflowAgentResult>(tasks.length);
		let next = 0;
		const workers = Array.from({ length: limit }, async () => {
			for (;;) {
				const index = next++;
				if (index >= tasks.length) return;
				const task = tasks[index]!;
				results[index] = await this.runSingle(task, {
					cwd: options.cwd,
					context: task.context ?? options.context,
					model: options.model,
					signal: options.signal,
					onProgress: (progress) => options.onProgress?.({
						requestId: progress.requestId,
						tasks: [{
							index,
							agent: task.agent,
							status: "running",
							currentTool: progress.currentTool,
							recentOutput: progress.recentOutput,
						}],
					}),
				});
			}
		});
		await Promise.all(workers);
		return results;
	}

	dispose(force = false): void {
		if (this.#disposed && !force) return;
		this.#disposed = true;
		for (const active of [...this.#active]) {
			if (force) active.force("Dynamic-workflows delegation was force-closed after the session shutdown grace period.");
			else active.cancel("Dynamic-workflows delegation client disposed during session shutdown.");
		}
		if (force) this.#active.clear();
	}
}
