import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Shared understanding of pi-subagents' documented run lifecycle: the
 * `subagent:async-complete` event and the status.json/result.json artifacts
 * written under the pi-subagents temp scope. The writer-lease reconciler uses
 * these helpers to distinguish active children from completed runs.
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

interface RunArtifactStatus {
	runId?: unknown;
	id?: unknown;
	state?: unknown;
	endedAt?: unknown;
	resultPath?: unknown;
	resultFile?: unknown;
}

function statusTextValue(text: string | undefined, label: string): string | undefined {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const value = new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, "im").exec(text ?? "")?.[1];
	return value?.trim() || undefined;
}

function existingFile(file: unknown): boolean {
	if (typeof file !== "string" || !file) return false;
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Reconcile an RPC status projection with pi-subagents' durable lifecycle
 * artifacts. A terminal-looking `State:` line is intentionally insufficient:
 * cancellation can publish failed/stopped before the runner has exited.
 */
export function reconcileSubagentRunState(input: {
	runId: string;
	statusText?: string;
	asyncDir?: string;
}): ReconciledRunState {
	const projected = classifySubagentStatusText(input.statusText);
	const asyncDir = input.asyncDir ?? statusTextValue(input.statusText, "Dir");
	let artifact: RunArtifactStatus | undefined;
	if (asyncDir) {
		try {
			const value = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as unknown;
			if (value && typeof value === "object" && !Array.isArray(value)) artifact = value as RunArtifactStatus;
		} catch {
			// Missing or mid-write artifacts are uncertain, never terminal evidence.
		}
	}

	if (artifact) {
		const artifactRunId = typeof artifact.runId === "string"
			? artifact.runId
			: typeof artifact.id === "string" ? artifact.id : undefined;
		if (!artifactRunId || artifactRunId === input.runId) {
			const state = typeof artifact.state === "string" ? artifact.state.toLowerCase() : "";
			const hasResult = existingFile(artifact.resultPath)
				|| existingFile(artifact.resultFile)
				|| (asyncDir ? existingFile(path.join(asyncDir, "result.json")) : false)
				|| existingFile(statusTextValue(input.statusText, "Result"));
			if (isConfirmedTerminalRunArtifact(state, hasResult, artifact.endedAt)) return "terminal";
			if (ACTIVE_RUN_STATES.has(state)) return "active";
		}
	}

	if (projected === "active") return "active";
	if (projected === "terminal") {
		const state = statusTextValue(input.statusText, "State")?.toLowerCase() ?? "";
		if (isConfirmedTerminalRunArtifact(state, existingFile(statusTextValue(input.statusText, "Result")))) return "terminal";
	}
	return "unknown";
}

/** Extract the run id from a `subagent:async-complete` event payload. */
export function runIdFromAsyncComplete(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const runId = (payload as Record<string, unknown>).runId;
	return typeof runId === "string" && runId ? runId : undefined;
}
