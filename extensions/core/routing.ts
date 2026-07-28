import { capabilityForAgent, type AgentCapability } from "./role-policy.ts";

export const ENGINEERING_ACTIONS = [
	"status",
	"inspect",
	"plan",
	"implement",
	"review",
	"deliver",
	"audit",
] as const;

export type EngineeringAction = (typeof ENGINEERING_ACTIONS)[number];

export const ENGINEERING_EFFORTS = ["quick", "standard", "deep"] as const;
export type EngineeringEffort = (typeof ENGINEERING_EFFORTS)[number];
export const DEFAULT_ENGINEERING_EFFORT: EngineeringEffort = "standard";

export const ONE_OFF_ACTIONS = ["inspect", "plan", "implement", "review"] as const;
export type OneOffAction = (typeof ONE_OFF_ACTIONS)[number];

export const WORKFLOW_ACTIONS = ["deliver", "audit"] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

export interface TurnBudget {
	maxTurns: number;
	graceTurns: number;
}

export interface ActionLimits {
	timeoutMs: number;
	turnBudget?: TurnBudget;
}

type LaunchAction = Exclude<EngineeringAction, "status">;

/** Standard remains the model-facing policy and preserves the original action ceilings. */
export const ACTION_LIMITS: Readonly<Record<LaunchAction, ActionLimits>> = {
	inspect: { timeoutMs: 5 * 60_000, turnBudget: { maxTurns: 8, graceTurns: 2 } },
	plan: { timeoutMs: 15 * 60_000, turnBudget: { maxTurns: 18, graceTurns: 2 } },
	implement: { timeoutMs: 45 * 60_000 },
	review: { timeoutMs: 15 * 60_000, turnBudget: { maxTurns: 18, graceTurns: 2 } },
	deliver: { timeoutMs: 60 * 60_000 },
	audit: { timeoutMs: 20 * 60_000 },
};

/**
 * Human-selected effort changes the ceiling for an already-selected topology.
 * It never adds agents, workflow phases, or write authority. Deep deliberately
 * uses wall-clock bounds without conversational turn caps so legitimate research,
 * review, and implementation can continue for hours when a human asks for it.
 */
export const EFFORT_ACTION_LIMITS: Readonly<Record<EngineeringEffort, Readonly<Record<LaunchAction, ActionLimits>>>> = {
	quick: {
		inspect: { timeoutMs: 3 * 60_000, turnBudget: { maxTurns: 5, graceTurns: 1 } },
		plan: { timeoutMs: 8 * 60_000, turnBudget: { maxTurns: 10, graceTurns: 2 } },
		implement: { timeoutMs: 20 * 60_000 },
		review: { timeoutMs: 8 * 60_000, turnBudget: { maxTurns: 10, graceTurns: 2 } },
		deliver: { timeoutMs: 30 * 60_000 },
		audit: { timeoutMs: 15 * 60_000 },
	},
	standard: ACTION_LIMITS,
	deep: {
		inspect: { timeoutMs: 2 * 60 * 60_000 },
		plan: { timeoutMs: 2 * 60 * 60_000 },
		implement: { timeoutMs: 4 * 60 * 60_000 },
		review: { timeoutMs: 2 * 60 * 60_000 },
		deliver: { timeoutMs: 4 * 60 * 60_000 },
		audit: { timeoutMs: 3 * 60 * 60_000 },
	},
};

export const ONE_OFF_AGENTS: Readonly<Record<OneOffAction, string>> = {
	inspect: "pi-workbench.fast-scout",
	plan: "pi-workbench.planner",
	implement: "pi-workbench.worker",
	review: "pi-workbench.reviewer",
};

export interface OneOffAssignment {
	agent: string;
	capability: AgentCapability;
	limits: ActionLimits;
}

export function resolveOneOffAssignment(action: OneOffAction, effort: EngineeringEffort = DEFAULT_ENGINEERING_EFFORT): OneOffAssignment {
	const agent = ONE_OFF_AGENTS[action];
	return {
		agent,
		capability: capabilityForAgent(agent),
		limits: EFFORT_ACTION_LIMITS[effort][action],
	};
}

export function limitsForAction(action: LaunchAction, effort: EngineeringEffort = DEFAULT_ENGINEERING_EFFORT): ActionLimits {
	return EFFORT_ACTION_LIMITS[effort][action];
}

export function isOneOffAction(action: EngineeringAction): action is OneOffAction {
	return (ONE_OFF_ACTIONS as readonly EngineeringAction[]).includes(action);
}

export function isWorkflowAction(action: EngineeringAction): action is WorkflowAction {
	return (WORKFLOW_ACTIONS as readonly EngineeringAction[]).includes(action);
}
