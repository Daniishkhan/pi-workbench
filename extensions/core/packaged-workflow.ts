/** Exact runtime identities for workflows packaged and owned by Pi Engineering. */

export const PACKAGED_AUDIT_WORKFLOW_AGENT =
	"chain:pi-workbench.reviewer->pi-workbench.risk-reviewer->pi-workbench.reviewer";

export const PACKAGED_DELIVER_WORKFLOW_AGENTS = [
	"chain:pi-workbench.planner->pi-workbench.worker->pi-workbench.reviewer->pi-workbench.risk-reviewer->pi-workbench.reviewer->expand:pi-workbench.worker->expand:pi-workbench.risk-reviewer",
	"chain:pi-workbench.planner->pi-workbench.worker->pi-workbench.reviewer->pi-workbench.risk-reviewer->pi-workbench.reviewer->pi-workbench.worker->expand:pi-workbench.risk-reviewer",
	"chain:pi-workbench.planner->pi-workbench.worker->pi-workbench.reviewer->pi-workbench.risk-reviewer->pi-workbench.reviewer->pi-workbench.worker->pi-workbench.risk-reviewer",
] as const;

export const PACKAGED_WORKFLOW_AGENTS: ReadonlySet<string> = new Set([
	PACKAGED_AUDIT_WORKFLOW_AGENT,
	...PACKAGED_DELIVER_WORKFLOW_AGENTS,
]);

export type PackagedWorkflowKind = "audit" | "deliver";

export function packagedWorkflowKind(payload: unknown): PackagedWorkflowKind | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const value = payload as Record<string, unknown>;
	if (value.mode !== "chain" || typeof value.agent !== "string") return undefined;
	if (value.agent === PACKAGED_AUDIT_WORKFLOW_AGENT) return "audit";
	if ((PACKAGED_DELIVER_WORKFLOW_AGENTS as readonly string[]).includes(value.agent)) return "deliver";
	return undefined;
}

export function isPackagedWorkflowCompletion(payload: unknown): boolean {
	return packagedWorkflowKind(payload) !== undefined;
}
