/**
 * Declarative findings-ledger policy: which Shipyard role may do what against
 * a run-scoped findings store. This replaces a chain of string-suffix checks
 * with one auditable table; the validator cross-checks chains against it.
 */

import type { CapabilityPolicy, FindingAction, FindingUpdateField } from "./findings-capabilities.ts";
import type { FindingStatus } from "./findings-store.ts";

/** Outputs of the independent first review wave: those steps create findings
 * but must not read peers' findings (they stay independent). */
export const FIRST_WAVE_OUTPUTS: ReadonlySet<string> = new Set(["contracts", "runtime", "adversarial", "integration", "security", "ui"]);

const ALL_UPDATE_FIELDS: FindingUpdateField[] = ["title", "summary", "severity", "confidence", "status", "category", "evidence", "failureScenario", "suggestedFix", "validation", "dispositionReason", "tags"];

/** Roles that never touch the ledger (read-only analysis without findings). */
const LEDGER_EXEMPT_ROLES: readonly string[] = ["codebase-reader", "codebase-explorer", "debugger", "delivery-planner"];

interface FindingsRolePolicy {
	actions: FindingAction[];
	updateFields?: FindingUpdateField[];
	updateStatuses?: FindingStatus[];
	/** When set, the policy applies only if the step's `as` output matches. */
	onlyOutput?: string;
}

/** Keyed by role suffix (the segment after the package namespace dot). */
const FINDINGS_ROLE_POLICIES: Readonly<Record<string, FindingsRolePolicy>> = {
	"falsifier": {
		actions: ["init", "get", "list", "update", "stats", "snapshot"],
		updateFields: ALL_UPDATE_FIELDS,
		updateStatuses: ["verified", "rejected", "deferred"],
	},
	"blindspot-hunter": {
		actions: ["init", "add", "get", "list", "update", "stats", "snapshot"],
		updateFields: ["confidence", "evidence", "validation", "tags"],
	},
	"review-synthesizer": {
		actions: ["init", "get", "list", "update", "stats", "snapshot", "export"],
		updateFields: ALL_UPDATE_FIELDS,
		updateStatuses: ["verified", "rejected", "deferred", "resolved"],
	},
	"implementation-worker": {
		onlyOutput: "fixes",
		actions: ["init", "get", "list", "update", "stats"],
		updateFields: ["status", "suggestedFix", "validation", "dispositionReason", "tags"],
		updateStatuses: ["resolved", "deferred"],
	},
	"shipwright": {
		actions: ["init", "add", "get", "list", "update", "stats", "snapshot", "export"],
		updateFields: ALL_UPDATE_FIELDS,
		updateStatuses: ["verified", "rejected", "deferred", "resolved"],
	},
};

/** Any other ledger-producing role gets this bounded default. */
const DEFAULT_ROLE_POLICY: FindingsRolePolicy = {
	actions: ["init", "add", "get", "list", "update", "stats"],
	updateFields: ["confidence", "status", "evidence", "validation", "dispositionReason", "tags"],
	updateStatuses: ["verified", "rejected", "deferred", "resolved"],
};

function roleSuffix(agent: string): string {
	return agent.slice(agent.lastIndexOf(".") + 1);
}

/** The findings stage is a chain-authoring convention: steps name it in task
 * prose as "stage `<name>`" (falling back to the step's `as` output). */
export function findingsStageForTask(task: Record<string, unknown>): string {
	const text = typeof task.task === "string" ? task.task : "";
	const explicit = text.match(/(?:creation )?stage\s+`([^`]+)`/i)?.[1]?.trim();
	return explicit || (typeof task.as === "string" ? task.as : "workflow");
}

export function capabilityPolicyForTask(task: Record<string, unknown>): CapabilityPolicy | undefined {
	const agent = typeof task.agent === "string" ? task.agent : "";
	const output = typeof task.as === "string" ? task.as : "";
	if (!agent || LEDGER_EXEMPT_ROLES.includes(roleSuffix(agent))) return undefined;
	const base = { stage: findingsStageForTask(task), sourceRole: agent };
	if (FIRST_WAVE_OUTPUTS.has(output)) return { ...base, actions: ["init", "add"] };
	const rolePolicy = FINDINGS_ROLE_POLICIES[roleSuffix(agent)];
	if (rolePolicy?.onlyOutput && output !== rolePolicy.onlyOutput) return undefined;
	const resolved = rolePolicy ?? DEFAULT_ROLE_POLICY;
	return {
		...base,
		actions: [...resolved.actions],
		...(resolved.updateFields ? { updateFields: [...resolved.updateFields] } : {}),
		...(resolved.updateStatuses ? { updateStatuses: [...resolved.updateStatuses] } : {}),
	};
}

export function collectCapabilityTasks(chain: Array<Record<string, unknown>>): Array<{ task: Record<string, unknown>; policy: CapabilityPolicy }> {
	const collected: Array<{ task: Record<string, unknown>; policy: CapabilityPolicy }> = [];
	const visit = (task: Record<string, unknown>) => {
		const parallel = Array.isArray(task.parallel) ? task.parallel as Array<Record<string, unknown>> : [];
		for (const child of parallel) visit(child);
		const policy = capabilityPolicyForTask(task);
		if (policy) collected.push({ task, policy });
	};
	for (const step of chain) visit(step);
	return collected;
}
