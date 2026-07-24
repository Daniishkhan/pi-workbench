import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorkbenchConfig {
	modules: {
		shipyard: boolean;
		agentTeams: boolean;
		dynamicWorkflows: boolean;
	};
	shipyard: {
		agentBindings: Record<string, string>;
	};
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
		writerGuard: {
			enabled: boolean(writerGuard.enabled, DEFAULT_WORKBENCH_CONFIG.writerGuard.enabled),
		},
	};
}

export function defaultAgentDir(): string {
	return path.resolve(process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent"));
}

export function workbenchConfigPath(agentDir = defaultAgentDir()): string {
	return path.join(agentDir, "extensions", "pi-workbench", "config.json");
}

export function loadWorkbenchConfig(agentDir = defaultAgentDir()): WorkbenchConfig {
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
