import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface EngineeringConfig {
	writeLock: {
		enabled: boolean;
	};
}

export const DEFAULT_ENGINEERING_CONFIG: EngineeringConfig = {
	writeLock: {
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

export function resolveEngineeringConfig(input: unknown): EngineeringConfig {
	const root = record(input, "Pi Engineering config");
	rejectUnknownKeys(root, ["writeLock", "writerGuard"], "Pi Engineering config");
	if (root.writeLock !== undefined && root.writerGuard !== undefined) {
		throw new TypeError("Pi Engineering config must not define both writeLock and legacy writerGuard");
	}
	const rawWriteLock = root.writeLock !== undefined ? root.writeLock : root.writerGuard;
	if (rawWriteLock === undefined) return structuredClone(DEFAULT_ENGINEERING_CONFIG);

	const writeLock = record(rawWriteLock, "writeLock");
	rejectUnknownKeys(writeLock, ["enabled"], "writeLock");
	if (writeLock.enabled !== undefined && typeof writeLock.enabled !== "boolean") {
		throw new TypeError("writeLock.enabled must be a boolean");
	}
	return {
		writeLock: {
			enabled: writeLock.enabled ?? DEFAULT_ENGINEERING_CONFIG.writeLock.enabled,
		},
	};
}

export function engineeringConfigPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "extensions", "pi-workbench", "config.json");
}

export function loadEngineeringConfig(agentDir = getAgentDir()): EngineeringConfig {
	const file = engineeringConfigPath(agentDir);
	try {
		return resolveEngineeringConfig(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`Failed to load Pi Engineering config at '${file}':`, error);
		}
		return resolveEngineeringConfig({});
	}
}
