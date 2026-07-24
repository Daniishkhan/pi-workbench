/**
 * Shared understanding of pi-subagents' documented run lifecycle: the
 * `subagent:async-complete` event and the status.json/result.json artifacts
 * written under the pi-subagents temp scope. Both the writer-lease
 * reconciler and the Agent Teams delivery loop classify runs with these.
 */

/** Terminal states in pi-subagents' documented status.json lifecycle. */
export const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
	"complete",
	"completed",
	"failed",
	"stopped",
	"timed_out",
	"timeout",
]);

/** States in pi-subagents' lifecycle that mean the run may still produce work. */
export const ACTIVE_RUN_STATES: ReadonlySet<string> = new Set(["queued", "running", "paused", "stopping"]);

export type ReconciledRunState = "active" | "terminal" | "unknown";

/** Classify the human-readable `State:` line of an RPC status reply. */
export function classifySubagentStatusText(text: string | undefined): ReconciledRunState {
	const state = /^State:\s*([^\s]+)\s*$/im.exec(text ?? "")?.[1]?.toLowerCase();
	if (!state) return "unknown";
	if (TERMINAL_RUN_STATES.has(state)) return "terminal";
	if (ACTIVE_RUN_STATES.has(state)) return "active";
	return "unknown";
}

/** status.json may advertise stopped/failed as soon as cancellation begins.
 * A terminal state is authoritative only once the runner writes endedAt or the
 * separate result artifact exists. */
export function isConfirmedTerminalRunArtifact(state: string, hasResult: boolean, endedAt?: unknown): boolean {
	return TERMINAL_RUN_STATES.has(state) && (hasResult || (typeof endedAt === "number" && Number.isFinite(endedAt) && endedAt > 0));
}

/** Extract the run id from a `subagent:async-complete` event payload. */
export function runIdFromAsyncComplete(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const runId = (payload as Record<string, unknown>).runId;
	return typeof runId === "string" && runId ? runId : undefined;
}
