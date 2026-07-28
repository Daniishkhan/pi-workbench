import path from "node:path";
import { isPackagedWorkflowCompletion } from "./packaged-workflow.ts";
import type { EngineeringAction } from "./routing.ts";

type InputSource = "interactive" | "rpc" | "extension";

type WorkflowBoundaryState = {
	reason: "attempted" | "launched" | "completed" | "failed";
	runId?: string;
};

const BRIEF_FIELD = /^\s*(?:[-*+]\s*)?(?:#{1,6}\s*)?(objective|scope|constraints|done\s+when|artifact|(?:task|milestone|gate)(?:\s+id)?)\s*:\s*(.*)$/i;
const BRIEF_SEPARATOR = /;\s*(?=(?:[-*+]\s*)?(?:#{1,6}\s*)?(?:objective|scope|constraints|done\s+when|artifact|(?:task|milestone|gate)(?:\s+id)?)\s*:)/gi;
const STABLE_ID = /^(?=.*[a-z0-9])[a-z0-9#][a-z0-9._:/#-]{0,159}$/i;
const CONTEXT_ONLY_VALUE = /^(?:(?:all\s+)?(?:the\s+)?(?:above|below|previous|earlier|current|same|this|that|these|those)(?:\s+(?:one|ones|code|changes|fixes|issues|task|work|scope|files|implementation))?|as\s+(?:above|before|discussed)|it|them|done|fix\s+it|continue(?:\s+(?:it|this|that))?)\.?$/i;

export const MAX_FRESH_BRIEF_LENGTH = 8_192;

function briefFields(task: string): Map<string, string> {
	const fields = new Map<string, string[]>();
	let current: string | undefined;
	for (const line of task.replace(BRIEF_SEPARATOR, "\n").split(/\r?\n/)) {
		const match = BRIEF_FIELD.exec(line);
		if (match) {
			current = match[1]!.toLowerCase().replace(/\s+/g, " ").replace(/ id$/, "");
			fields.set(current, [match[2] ?? ""]);
			continue;
		}
		if (current) fields.get(current)!.push(line);
	}
	return new Map([...fields].map(([name, value]) => [name, value.join("\n").trim()]));
}

function isSelfContainedValue(value: string | undefined): boolean {
	return Boolean(value && !CONTEXT_ONLY_VALUE.test(value.trim()));
}

function isRepositoryArtifactPath(value: string | undefined): boolean {
	if (!value || value.length > 2048 || value.includes("\n") || value.includes("\\")) return false;
	if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
	const normalized = path.posix.normalize(value);
	return normalized === value
		&& normalized !== "."
		&& normalized !== ".."
		&& !normalized.startsWith("../")
		&& (normalized.includes("/") || normalized.includes("."));
}

/** Require enough durable context for a fresh specialist to act without chat history. */
export function requireSelfContainedWorkflowBrief(task: string): void {
	if (task.length > MAX_FRESH_BRIEF_LENGTH) {
		throw new Error(
			`Fresh-context engineering briefs are limited to ${MAX_FRESH_BRIEF_LENGTH} characters. Store a longer specification in the repository and pass Artifact: plus a stable Task:, Milestone:, or Gate: ID.`,
		);
	}
	const fields = briefFields(task);
	const completeBrief = ["objective", "scope", "constraints", "done when"]
		.every((name) => isSelfContainedValue(fields.get(name)));
	const stableReference = isRepositoryArtifactPath(fields.get("artifact")) && ["task", "milestone", "gate"]
		.some((name) => STABLE_ID.test(fields.get(name) ?? ""));
	if (completeBrief || stableReference) return;
	throw new Error(
		"Fresh-context engineering assignments require a self-contained brief: provide non-empty Objective:, Scope:, Constraints:, and Done when: fields, or Artifact: plus a stable Task:, Milestone:, or Gate: (ID suffix optional).",
	);
}

/**
 * In-memory turn boundary for manager-led workflows. A workflow launch yields
 * control to the user; its terminal event yields again even if the user spoke
 * while it was running.
 */
export class AssignmentBoundary {
	readonly #workflowRuns = new Set<string>();
	readonly #pendingAttempts = new Set<number>();
	readonly #earlyCompletions = new Set<string>();
	#nextAttempt = 1;
	#blocked: WorkflowBoundaryState | undefined;

	assertModelAction(action: EngineeringAction): void {
		if (action === "status" || !this.#blocked) return;
		const state = this.#blocked;
		const workflow = state.runId ? `workflow '${state.runId}'` : "a workflow attempt";
		throw new Error(
			`Engineering assignments are paused because ${workflow} ${state.reason}. Report its run status and artifacts, then wait for direct user input or an explicit non-status /engineering command before assigning '${action}'.`,
		);
	}

	beginWorkflowAttempt(): number {
		const attempt = this.#nextAttempt++;
		this.#pendingAttempts.add(attempt);
		this.#blocked = { reason: "attempted" };
		return attempt;
	}

	attachWorkflow(attempt: number, runId: string): void {
		if (!this.#pendingAttempts.delete(attempt) || !runId) return;
		const completed = this.#earlyCompletions.delete(runId);
		if (this.#pendingAttempts.size === 0) this.#earlyCompletions.clear();
		if (completed) {
			this.#blocked = { reason: "completed", runId };
			return;
		}
		this.#workflowRuns.add(runId);
		this.#blocked = { reason: "launched", runId };
	}

	failWorkflowAttempt(attempt: number): void {
		if (!this.#pendingAttempts.delete(attempt)) return;
		this.#blocked = { reason: "failed" };
		if (this.#pendingAttempts.size === 0) this.#earlyCompletions.clear();
	}

	completeWorkflow(runId: string, payload?: unknown): boolean {
		if (!this.#workflowRuns.delete(runId)) {
			if (this.#pendingAttempts.size > 0) this.#earlyCompletions.add(runId);
			else if (isPackagedWorkflowCompletion(payload)) {
				this.#blocked = { reason: "completed", runId };
				return true;
			}
			return false;
		}
		this.#blocked = { reason: "completed", runId };
		return true;
	}

	observeInput(source: InputSource): void {
		if (source !== "extension") this.#blocked = undefined;
	}

	authorizeHumanAction(action: EngineeringAction): void {
		if (action !== "status") this.#blocked = undefined;
	}

	/** Non-empty Plannotator feedback is direct human input, not model recovery. */
	authorizeHumanFeedback(): void {
		this.#blocked = undefined;
	}
}
