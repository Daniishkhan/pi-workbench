export type AgentCapability = "read-only" | "writer";
export type RoutingSurface = "one-off" | "shipyard" | "team" | "dynamic";

export interface RolePolicy {
	capability: AgentCapability;
	surfaces: RoutingSurface[];
}

export const ROLE_POLICIES: Readonly<Record<string, RolePolicy>> = {
	"advisor": { capability: "read-only", surfaces: ["one-off"] },
	"scout": { capability: "read-only", surfaces: ["one-off", "dynamic"] },
	"planner": { capability: "read-only", surfaces: ["one-off", "dynamic"] },
	"researcher": { capability: "read-only", surfaces: ["one-off", "dynamic"] },
	"context-builder": { capability: "read-only", surfaces: ["one-off", "dynamic"] },
	"oracle": { capability: "read-only", surfaces: ["one-off"] },
	"reviewer": { capability: "writer", surfaces: ["one-off", "dynamic"] },
	"worker": { capability: "writer", surfaces: ["one-off", "dynamic"] },
	"delegate": { capability: "writer", surfaces: ["one-off"] },
	"pi-workbench.fast-scout": { capability: "read-only", surfaces: ["one-off", "dynamic"] },
	"pi-workbench.deep-reader": { capability: "read-only", surfaces: ["one-off", "dynamic"] },
	"pi-workbench.planner": { capability: "read-only", surfaces: ["one-off", "dynamic"] },
	"pi-workbench.worker": { capability: "writer", surfaces: ["one-off", "dynamic"] },
	"pi-workbench.reviewer": { capability: "read-only", surfaces: ["one-off", "dynamic"] },
	"pi-workbench.oracle": { capability: "read-only", surfaces: ["one-off"] },
	"pi-workbench.researcher": { capability: "read-only", surfaces: ["one-off", "dynamic"] },
	"pi-workbench.teams-scout": { capability: "read-only", surfaces: ["team"] },
	"pi-workbench.teams-teammate": { capability: "writer", surfaces: ["team"] },
	"pi-shipyard.codebase-explorer": { capability: "read-only", surfaces: ["one-off", "shipyard"] },
	"pi-shipyard.codebase-reader": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.debugger": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.delivery-planner": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.contract-reviewer": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.runtime-reviewer": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.adversarial-tester": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.integration-reviewer": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.security-reviewer": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.ui-reviewer": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.falsifier": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.blindspot-hunter": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.review-synthesizer": { capability: "read-only", surfaces: ["shipyard"] },
	"pi-shipyard.implementation-worker": { capability: "writer", surfaces: ["shipyard"] },
	"pi-shipyard.shipwright": { capability: "read-only", surfaces: ["shipyard"] },
};

export function rolePolicyForAgent(runtimeName: string): RolePolicy | undefined {
	return ROLE_POLICIES[runtimeName];
}

export function capabilityForAgent(runtimeName: string): AgentCapability {
	return rolePolicyForAgent(runtimeName)?.capability ?? "writer";
}

export function allowsSurface(runtimeName: string, surface: RoutingSurface): boolean {
	return rolePolicyForAgent(runtimeName)?.surfaces.includes(surface) ?? false;
}

export function resolveTeamAgentCapability(runtimeName: string, declaredWrite?: boolean): AgentCapability {
	const policy = rolePolicyForAgent(runtimeName);
	if (!policy) {
		if (declaredWrite === false) {
			throw new Error(
				`Unknown team agent '${runtimeName}' cannot self-declare as read-only. Register an administrator-owned team policy with an enforced mutation-free tool surface first.`,
			);
		}
		return "writer";
	}
	if (!policy.surfaces.includes("team")) {
		throw new Error(`Agent '${runtimeName}' is not approved for the Agent Teams surface.`);
	}
	const policyWrite = policy.capability === "writer";
	if (declaredWrite !== undefined && declaredWrite !== policyWrite) {
		throw new Error(`team_spawn.write cannot override packaged policy for '${runtimeName}' (${policy.capability}). Choose a role with the required capability.`);
	}
	return policy.capability;
}
