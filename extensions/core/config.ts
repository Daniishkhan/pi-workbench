import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface WorkbenchConfig {
	writerGuard: {
		enabled: boolean;
	};
}

export const DEFAULT_WORKBENCH_CONFIG: WorkbenchConfig = {
	writerGuard: {
		enabled: true,
	},
};

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new TypeError(`${label} contains unknown ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}`);
}

export function resolveWorkbenchConfig(input: unknown): WorkbenchConfig {
	const root = record(input, "Pi Workbench config");
	rejectUnknownKeys(root, ["writerGuard"], "Pi Workbench config");
	if (root.writerGuard === undefined) return structuredClone(DEFAULT_WORKBENCH_CONFIG);

	const writerGuard = record(root.writerGuard, "writerGuard");
	rejectUnknownKeys(writerGuard, ["enabled"], "writerGuard");
	if (writerGuard.enabled !== undefined && typeof writerGuard.enabled !== "boolean") {
		throw new TypeError("writerGuard.enabled must be a boolean");
	}
	return {
		writerGuard: {
			enabled: writerGuard.enabled ?? DEFAULT_WORKBENCH_CONFIG.writerGuard.enabled,
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
