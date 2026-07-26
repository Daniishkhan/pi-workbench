import { capabilityForAgent, type AgentCapability } from "./role-policy.ts";

export const WORKBENCH_MODES = [
	"status",
	"inspect",
	"plan",
	"implement",
	"review",
	"deliver",
	"audit",
] as const;

export type WorkbenchMode = (typeof WORKBENCH_MODES)[number];

export const ONE_OFF_MODES = ["inspect", "plan", "implement", "review"] as const;
export type OneOffMode = (typeof ONE_OFF_MODES)[number];

export const WORKFLOW_MODES = ["deliver", "audit"] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

export interface TurnBudget {
	maxTurns: number;
	graceTurns: number;
}

export interface RouteLimits {
	timeoutMs: number;
	turnBudget?: TurnBudget;
}

/** The single policy table for every public route that can launch work. */
export const ROUTE_LIMITS: Readonly<Record<Exclude<WorkbenchMode, "status">, RouteLimits>> = {
	inspect: { timeoutMs: 5 * 60_000, turnBudget: { maxTurns: 8, graceTurns: 2 } },
	plan: { timeoutMs: 15 * 60_000, turnBudget: { maxTurns: 18, graceTurns: 2 } },
	implement: { timeoutMs: 45 * 60_000 },
	review: { timeoutMs: 15 * 60_000, turnBudget: { maxTurns: 18, graceTurns: 2 } },
	deliver: { timeoutMs: 45 * 60_000 },
	audit: { timeoutMs: 20 * 60_000 },
};

export const ONE_OFF_AGENTS: Readonly<Record<OneOffMode, string>> = {
	inspect: "pi-workbench.fast-scout",
	plan: "pi-workbench.planner",
	implement: "pi-workbench.worker",
	review: "pi-workbench.reviewer",
};

export interface OneOffRoute {
	agent: string;
	capability: AgentCapability;
	limits: RouteLimits;
}

export function resolveOneOffRoute(mode: OneOffMode): OneOffRoute {
	const agent = ONE_OFF_AGENTS[mode];
	return { agent, capability: capabilityForAgent(agent), limits: ROUTE_LIMITS[mode] };
}

export function limitsForMode(mode: Exclude<WorkbenchMode, "status">): RouteLimits {
	return ROUTE_LIMITS[mode];
}

export function isOneOffMode(mode: WorkbenchMode): mode is OneOffMode {
	return (ONE_OFF_MODES as readonly WorkbenchMode[]).includes(mode);
}

export function isWorkflowMode(mode: WorkbenchMode): mode is WorkflowMode {
	return (WORKFLOW_MODES as readonly WorkbenchMode[]).includes(mode);
}
