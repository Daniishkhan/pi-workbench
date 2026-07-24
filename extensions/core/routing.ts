import { allowsSurface, capabilityForAgent, type AgentCapability } from "./role-policy.ts";

export const WORKBENCH_MODES = [
	"status",
	"quick",
	"deep",
	"plan",
	"implement",
	"review-oneoff",
	"explore",
	"debug",
	"fast",
	"review",
	"security",
	"ui",
	"compact",
	"deliver",
	"ship",
	"team",
	"dynamic",
] as const;

export type WorkbenchMode = typeof WORKBENCH_MODES[number];

export const SHIPYARD_MODES = new Set<WorkbenchMode>(["explore", "debug", "fast", "review", "security", "ui", "compact", "deliver", "ship"]);
export const ONE_OFF_AGENTS: Partial<Record<WorkbenchMode, string>> = {
	quick: "pi-workbench.fast-scout",
	deep: "pi-workbench.deep-reader",
	plan: "pi-workbench.planner",
	implement: "pi-workbench.worker",
	"review-oneoff": "pi-workbench.reviewer",
};

export interface OneOffRoute {
	agent: string;
	capability: AgentCapability;
}

export function resolveOneOffRoute(mode: WorkbenchMode, override?: string): OneOffRoute {
	const agent = override?.trim() || ONE_OFF_AGENTS[mode];
	if (!agent) throw new Error(`Workbench mode '${mode}' does not map to a one-off agent.`);
	if (!allowsSurface(agent, "one-off")) {
		throw new Error(`Agent '${agent}' is not approved for Workbench one-off routing. Register it in the shared role policy before using it as an override.`);
	}
	return { agent, capability: capabilityForAgent(agent) };
}

export function routeCategory(mode: WorkbenchMode): "status" | "one-off" | "shipyard" | "team" | "dynamic" {
	if (mode === "status") return "status";
	if (ONE_OFF_AGENTS[mode]) return "one-off";
	if (SHIPYARD_MODES.has(mode)) return "shipyard";
	if (mode === "team" || mode === "dynamic") return mode;
	throw new Error(`Workbench mode '${mode}' has no routing category.`);
}
