/**
 * Shipyard chain preparation: default task resolution (from the workflow
 * catalog), private output materialization, and capability-checked agent
 * bindings. Findings-ledger role policy lives in findings-policy.ts.
 */

import path from "node:path";
import { capabilityForAgent } from "../core/role-policy.ts";

export { resolveWorkflowTask } from "./workflow-catalog.ts";

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
