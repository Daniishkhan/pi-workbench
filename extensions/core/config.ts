import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface WorkbenchConfig {
	modules: {
		shipyard: boolean;
		agentTeams: boolean;
		dynamicWorkflows: boolean;
	};
	shipyard: {
		agentBindings: Record<string, string>;
	};
	/** Raw Dynamic Workflows policy section. Resolved by dynamic/config.ts into
	 * ResolvedDynamicWorkflowsConfig; core intentionally stays decoupled from
	 * the dynamic module's types. */
	dynamic: Record<string, unknown>;
	writerGuard: {
		enabled: boolean;
	};
}

export const DEFAULT_WORKBENCH_CONFIG: WorkbenchConfig = {
	modules: {
		shipyard: true,
		agentTeams: true,
		dynamicWorkflows: false,
	},
	shipyard: {
		agentBindings: {},
	},
	dynamic: {},
	writerGuard: {
		enabled: true,
	},
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function resolveWorkbenchConfig(input: unknown): WorkbenchConfig {
	const root = record(input);
	const modules = record(root.modules);
	const shipyard = record(root.shipyard);
	const writerGuard = record(root.writerGuard);
	const rawBindings = record(shipyard.agentBindings);
	const agentBindings: Record<string, string> = {};
	for (const [role, agent] of Object.entries(rawBindings)) {
		if (typeof agent === "string" && role.trim() && agent.trim()) agentBindings[role.trim()] = agent.trim();
	}
	return {
		modules: {
			shipyard: boolean(modules.shipyard, DEFAULT_WORKBENCH_CONFIG.modules.shipyard),
			agentTeams: boolean(modules.agentTeams, DEFAULT_WORKBENCH_CONFIG.modules.agentTeams),
			dynamicWorkflows: boolean(modules.dynamicWorkflows, DEFAULT_WORKBENCH_CONFIG.modules.dynamicWorkflows),
		},
		shipyard: { agentBindings },
		dynamic: record(root.dynamic),
		writerGuard: {
			enabled: boolean(writerGuard.enabled, DEFAULT_WORKBENCH_CONFIG.writerGuard.enabled),
		},
	};
}

export function workbenchConfigPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "extensions", "pi-workbench", "config.json");
}

export function loadWorkbenchConfig(agentDir = getAgentDir()): WorkbenchConfig {
	const file = workbenchConfigPath(agentDir);
	try {
		return resolveWorkbenchConfig(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`Failed to load Pi Workbench config at '${file}':`, error);
		}
		return resolveWorkbenchConfig({});
	}
}
