export type AgentCapability = "read-only" | "writer";
export type RoutingSurface = "one-off" | "workflow";

export interface RolePolicy {
	capability: AgentCapability;
	surfaces: readonly RoutingSurface[];
}

export const ROLE_POLICIES: Readonly<Record<string, RolePolicy>> = {
	"pi-workbench.fast-scout": { capability: "read-only", surfaces: ["one-off"] },
	"pi-workbench.planner": { capability: "read-only", surfaces: ["one-off", "workflow"] },
	"pi-workbench.worker": { capability: "writer", surfaces: ["one-off", "workflow"] },
	"pi-workbench.reviewer": { capability: "read-only", surfaces: ["one-off", "workflow"] },
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
