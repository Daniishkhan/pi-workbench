import path from "node:path";
import { capabilityForAgent } from "../core/role-policy.ts";
import type { WorkflowName } from "./workflow-names.ts";

function defaultWorkflowTask(name: WorkflowName): string {
	switch (name) {
		case "explore":
			return "Map this repository's architecture, entry points, primary flows, module boundaries, and test harness for future codebase questions.";
		case "review":
			return "Review the current worktree diff against the user request, repository instructions, and existing behavior.";
		case "fast":
			return "Run a focused bug review of the current worktree diff.";
		case "security":
			return "Review the current worktree diff for correctness and security boundary failures.";
		case "ui":
			return "Review the current UI worktree diff for behavior, state-flow, accessibility, interaction, and visual regressions.";
		case "ship":
			return "Review, fix, validate, and prepare the current worktree changes for shipment. Do not commit or push.";
		case "debug":
		case "compact":
		case "deliver":
			throw new Error(`Shipyard ${name} requires a non-empty task.`);
	}
}

export function resolveWorkflowTask(name: WorkflowName, task?: string): string {
	const target = task?.trim();
	return target || defaultWorkflowTask(name);
}

function privateOutputPath(artifactsDir: string, output: string): string {
	if (!output.trim() || path.isAbsolute(output) || path.posix.isAbsolute(output) || path.win32.isAbsolute(output)) {
		throw new Error(`Shipyard workflow output must be a non-empty relative path: ${output}`);
	}
	const root = path.resolve(artifactsDir);
	const resolved = path.resolve(root, output);
	const relative = path.relative(root, resolved);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Shipyard workflow output escapes the private run directory: ${output}`);
	}
	return resolved;
}

function materializeTaskOutput(task: Record<string, unknown>, artifactsDir: string): Record<string, unknown> {
	const materialized = { ...task };
	if (typeof task.output === "string") materialized.output = privateOutputPath(artifactsDir, task.output);
	if (Array.isArray(task.parallel)) {
		materialized.parallel = task.parallel.map((entry) => materializeTaskOutput(entry as Record<string, unknown>, artifactsDir));
	} else if (task.parallel && typeof task.parallel === "object") {
		materialized.parallel = materializeTaskOutput(task.parallel as Record<string, unknown>, artifactsDir);
	}
	return materialized;
}

export function materializeWorkflowOutputs(chain: Array<Record<string, unknown>>, artifactsDir: string): Array<Record<string, unknown>> {
	return chain.map((step) => materializeTaskOutput(step, artifactsDir));
}

export function bindWorkflowAgents(value: unknown, bindings: Record<string, string>): unknown {
	if (Array.isArray(value)) return value.map((entry) => bindWorkflowAgents(entry, bindings));
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (key === "agent" && typeof entry === "string" && bindings[entry]) {
			const replacement = bindings[entry]!;
			const canonicalCapability = capabilityForAgent(entry);
			const replacementCapability = capabilityForAgent(replacement);
			if (canonicalCapability !== replacementCapability) {
				throw new Error(
					`Shipyard agent binding '${entry}' -> '${replacement}' changes capability from ${canonicalCapability} to ${replacementCapability}.`,
				);
			}
			output[key] = replacement;
		} else output[key] = bindWorkflowAgents(entry, bindings);
	}
	return output;
}
