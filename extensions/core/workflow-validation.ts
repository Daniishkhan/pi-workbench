import path from "node:path";
import { Compile } from "typebox/compile";
import { ROLE_POLICIES } from "./role-policy.ts";
import type { WorkflowAction } from "./routing.ts";

export interface WorkflowTask extends Record<string, unknown> {
	agent: string;
	task: string;
	phase?: string;
	label?: string;
	as?: string;
	output?: string;
	outputMode?: "inline" | "file-only";
	outputSchema?: Record<string, unknown>;
	progress?: boolean;
}

export interface WorkflowParallelStep extends Record<string, unknown> {
	phase?: string;
	label?: string;
	parallel: WorkflowTask[];
	concurrency?: number;
	failFast?: boolean;
}

export type WorkflowStep = WorkflowTask | WorkflowParallelStep;

export interface WorkflowDefinition {
	name: WorkflowAction;
	package: "pi-workbench";
	description: string;
	chain: WorkflowStep[];
}

const ROOT_KEYS = new Set(["name", "package", "description", "chain"]);
const TASK_KEYS = new Set([
	"agent",
	"task",
	"phase",
	"label",
	"as",
	"output",
	"outputMode",
	"outputSchema",
	"progress",
]);
const GROUP_KEYS = new Set(["phase", "label", "parallel", "concurrency", "failFast"]);
const OUTPUT_REFERENCE = /\{outputs\.([^}]*)\}/g;
const OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const EXPECTED_TOPOLOGY: Readonly<Record<WorkflowAction, readonly (string | readonly string[])[]>> = {
	audit: [
		["pi-workbench.reviewer", "pi-workbench.reviewer"],
		"pi-workbench.reviewer",
	],
	deliver: [
		"pi-workbench.planner",
		"pi-workbench.worker",
		["pi-workbench.reviewer", "pi-workbench.reviewer"],
		"pi-workbench.worker",
		"pi-workbench.reviewer",
	],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, prefix: string, errors: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) errors.push(`${prefix}: unsupported key ${key}`);
	}
}

function inspectOptionalString(value: unknown, field: string, prefix: string, errors: string[]): void {
	if (value !== undefined && typeof value !== "string") errors.push(`${prefix}: ${field} must be a string`);
}

function normalizedArtifactPath(value: string): string | undefined {
	if (
		value.includes("\\") ||
		path.posix.isAbsolute(value) ||
		path.win32.isAbsolute(value) ||
		path.win32.parse(value).root.length > 0
	) {
		return undefined;
	}
	const normalized = path.posix.normalize(value);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) {
		return undefined;
	}
	return normalized;
}

function inspectTask(
	taskValue: unknown,
	prefix: string,
	available: ReadonlySet<string>,
	produced: Set<string>,
	outputPaths: Set<string>,
	requiresStructuredOutput: boolean,
	errors: string[],
): string | undefined {
	if (!isRecord(taskValue)) {
		errors.push(`${prefix}: task must be an object`);
		return undefined;
	}
	inspectKeys(taskValue, TASK_KEYS, prefix, errors);

	const agent = taskValue.agent;
	if (typeof agent !== "string" || !Object.hasOwn(ROLE_POLICIES, agent)) {
		errors.push(`${prefix}: unknown agent ${String(agent)}`);
	} else if (!ROLE_POLICIES[agent]?.surfaces.includes("workflow")) {
		errors.push(`${prefix}: agent ${agent} is not approved for workflows`);
	}

	if (typeof taskValue.task !== "string" || !taskValue.task.trim()) {
		errors.push(`${prefix}: task must be non-empty`);
	} else {
		const references = [...taskValue.task.matchAll(OUTPUT_REFERENCE)].map((match) => match[1]!);
		for (const reference of references) {
			if (!OUTPUT_NAME.test(reference)) errors.push(`${prefix}: invalid output reference ${reference || "<empty>"}`);
			else if (!available.has(reference)) errors.push(`${prefix}: forward or unknown output reference ${reference}`);
		}
		if (references.length > 0 && !taskValue.task.includes("Open and read")) {
			errors.push(`${prefix}: artifact consumer must explicitly open referenced outputs`);
		}
	}

	inspectOptionalString(taskValue.phase, "phase", prefix, errors);
	inspectOptionalString(taskValue.label, "label", prefix, errors);
	if (taskValue.progress !== undefined && typeof taskValue.progress !== "boolean") {
		errors.push(`${prefix}: progress must be a boolean`);
	}

	if (taskValue.as !== undefined) {
		if (typeof taskValue.as !== "string" || !OUTPUT_NAME.test(taskValue.as)) {
			errors.push(`${prefix}: invalid as name ${String(taskValue.as)}`);
		} else if (available.has(taskValue.as) || produced.has(taskValue.as)) {
			errors.push(`${prefix}: duplicate as name ${taskValue.as}`);
		} else {
			produced.add(taskValue.as);
		}
	}

	if (taskValue.outputMode !== undefined && taskValue.outputMode !== "inline" && taskValue.outputMode !== "file-only") {
		errors.push(`${prefix}: outputMode must be inline or file-only`);
	}
	if (taskValue.outputMode === "file-only" && typeof taskValue.output !== "string") {
		errors.push(`${prefix}: file-only requires output`);
	}
	if (taskValue.output !== undefined) {
		if (typeof taskValue.output !== "string" || !taskValue.output) {
			errors.push(`${prefix}: output must be a normalized relative path inside run artifacts`);
		} else {
			const normalized = normalizedArtifactPath(taskValue.output);
			if (normalized === undefined) {
				errors.push(`${prefix}: output must be a normalized relative path inside run artifacts`);
			} else if (outputPaths.has(normalized)) {
				errors.push(`${prefix}: duplicate output path ${taskValue.output}`);
			} else {
				outputPaths.add(normalized);
			}
		}
	}
	if (requiresStructuredOutput && taskValue.outputSchema === undefined) {
		errors.push(`${prefix}: independent reviewer must define outputSchema`);
	}
	if (!requiresStructuredOutput && taskValue.outputSchema !== undefined) {
		errors.push(`${prefix}: only independent review steps may define outputSchema`);
	}

	if (taskValue.outputSchema !== undefined) {
		if (!isRecord(taskValue.outputSchema)) {
			errors.push(`${prefix}: outputSchema must be a JSON Schema object`);
		} else {
			try {
				Compile(taskValue.outputSchema as never);
			} catch (error) {
				errors.push(`${prefix}: invalid outputSchema: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (taskValue.output !== undefined || taskValue.outputMode === "file-only") {
			errors.push(`${prefix}: structured output must flow through its named value, not a duplicate file-only receipt`);
		}
	}

	return typeof agent === "string" ? agent : undefined;
}

/**
 * Return every violation of Pi Engineering's closed static workflow contract.
 * This is shared by package validation and the runtime loader so an invalid
 * chain cannot make it as far as RPC readiness checks or writer acquisition.
 */
export function workflowDefinitionErrors(
	expectedName: WorkflowAction,
	value: unknown,
	label = `Engineering ${expectedName} workflow`,
): string[] {
	const errors: string[] = [];
	if (!isRecord(value)) return [`${label}: workflow root must be an object`];
	inspectKeys(value, ROOT_KEYS, label, errors);
	if (value.name !== expectedName) errors.push(`${label}: name must be ${expectedName}`);
	if (value.package !== "pi-workbench") errors.push(`${label}: package must be pi-workbench`);
	if (typeof value.description !== "string" || !value.description.trim()) {
		errors.push(`${label}: description must be non-empty`);
	}
	if (!Array.isArray(value.chain) || value.chain.length === 0) {
		errors.push(`${label}: chain must be a non-empty array`);
		return errors;
	}

	const available = new Set<string>();
	const outputPaths = new Set<string>();
	const topology: Array<string | string[]> = [];
	for (let index = 0; index < value.chain.length; index += 1) {
		const stepValue: unknown = value.chain[index];
		const prefix = `${label} step ${index + 1}`;
		const produced = new Set<string>();
		if (isRecord(stepValue) && Object.hasOwn(stepValue, "parallel")) {
			inspectKeys(stepValue, GROUP_KEYS, prefix, errors);
			inspectOptionalString(stepValue.phase, "phase", prefix, errors);
			inspectOptionalString(stepValue.label, "label", prefix, errors);
			if (!Array.isArray(stepValue.parallel)) {
				errors.push(`${prefix}: parallel must be an array`);
				topology.push([]);
				continue;
			}
			if (stepValue.parallel.length !== 2 || stepValue.concurrency !== 2) {
				errors.push(`${prefix}: parallel review must contain exactly two concurrent tasks`);
			}
			if (stepValue.failFast !== undefined && typeof stepValue.failFast !== "boolean") {
				errors.push(`${prefix}: failFast must be a boolean`);
			}
			const agents: string[] = [];
			const requiresStructuredOutput =
				(expectedName === "audit" && index === 0) || (expectedName === "deliver" && index === 2);
			for (let taskIndex = 0; taskIndex < stepValue.parallel.length; taskIndex += 1) {
				const task = stepValue.parallel[taskIndex];
				const agent = inspectTask(
					task,
					`${prefix} task ${taskIndex + 1}`,
					available,
					produced,
					outputPaths,
					requiresStructuredOutput,
					errors,
				);
				if (agent) agents.push(agent);
			}
			if (agents.some((agent) => ROLE_POLICIES[agent]?.capability === "writer")) {
				errors.push(`${prefix}: writers may not run in parallel`);
			}
			topology.push(agents);
		} else {
			const agent = inspectTask(stepValue, prefix, available, produced, outputPaths, false, errors);
			topology.push(agent ?? "<invalid>");
		}
		for (const output of produced) available.add(output);
	}

	const finalStep = value.chain.at(-1);
	if (!isRecord(finalStep) || finalStep.outputMode !== "inline") {
		errors.push(`${label}: final step must return inline`);
	}
	if (JSON.stringify(topology) !== JSON.stringify(EXPECTED_TOPOLOGY[expectedName])) {
		errors.push(`${label}: ${expectedName} topology changed`);
	}
	const serialized = JSON.stringify(value);
	if (serialized.includes("SHIPYARD") || serialized.includes("team_")) {
		errors.push(`${label}: legacy orchestration marker remains`);
	}
	return errors;
}

export function requireWorkflowDefinition(
	expectedName: WorkflowAction,
	value: unknown,
	label = `Engineering ${expectedName} workflow`,
): WorkflowDefinition {
	const errors = workflowDefinitionErrors(expectedName, value, label);
	if (errors.length > 0) throw new Error(`Invalid Pi Engineering workflow:\n- ${errors.join("\n- ")}`);
	return value as WorkflowDefinition;
}
