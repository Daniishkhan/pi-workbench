import * as fs from "node:fs";
import * as path from "node:path";
import type {
	DynamicWorkflowsConfig,
	ResolvedDynamicWorkflowsConfig,
	WorkflowManifest,
	WorkflowPolicy,
	WorkflowSize,
} from "./types.ts";

const DEFAULT_SIZE_LIMITS: Record<WorkflowSize, number> = {
	small: 5,
	medium: 15,
	large: 50,
	unrestricted: 200,
};

const DEFAULT_CONFIG: ResolvedDynamicWorkflowsConfig = {
	defaultSize: "small",
	sizeLimits: DEFAULT_SIZE_LIMITS,
	maxConcurrency: 4,
	maxRuntimeMs: 30 * 60_000,
	maxIntermediateBytes: 200 * 1024,
	maxResultBytes: 50 * 1024,
	allowUnrestricted: false,
	unrestrictedSafetyCap: 200,
	allowUnattendedTrusted: false,
	approvalMode: "hash",
};

function positiveInteger(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? Math.min(value, max)
		: fallback;
}

function isWorkflowSize(value: unknown): value is WorkflowSize {
	return value === "small" || value === "medium" || value === "large" || value === "unrestricted";
}

export function resolveConfig(input: DynamicWorkflowsConfig = {}): ResolvedDynamicWorkflowsConfig {
	const unrestrictedSafetyCap = positiveInteger(input.unrestrictedSafetyCap, DEFAULT_CONFIG.unrestrictedSafetyCap, 1_000);
	const sizeLimits: Record<WorkflowSize, number> = {
		small: positiveInteger(input.sizeLimits?.small, DEFAULT_SIZE_LIMITS.small, 100),
		medium: positiveInteger(input.sizeLimits?.medium, DEFAULT_SIZE_LIMITS.medium, 250),
		large: positiveInteger(input.sizeLimits?.large, DEFAULT_SIZE_LIMITS.large, 500),
		unrestricted: Math.min(
			positiveInteger(input.sizeLimits?.unrestricted, unrestrictedSafetyCap, 1_000),
			unrestrictedSafetyCap,
		),
	};
	return {
		defaultSize: isWorkflowSize(input.defaultSize) ? input.defaultSize : DEFAULT_CONFIG.defaultSize,
		sizeLimits,
		maxConcurrency: positiveInteger(input.maxConcurrency, DEFAULT_CONFIG.maxConcurrency, 32),
		maxRuntimeMs: positiveInteger(input.maxRuntimeMs, DEFAULT_CONFIG.maxRuntimeMs, 24 * 60 * 60_000),
		maxIntermediateBytes: positiveInteger(
			input.maxIntermediateBytes,
			DEFAULT_CONFIG.maxIntermediateBytes,
			2 * 1024 * 1024,
		),
		maxResultBytes: positiveInteger(input.maxResultBytes, DEFAULT_CONFIG.maxResultBytes, 1024 * 1024),
		allowUnrestricted: input.allowUnrestricted === true,
		unrestrictedSafetyCap,
		allowUnattendedTrusted: input.allowUnattendedTrusted === true,
		approvalMode: input.approvalMode === "always" ? "always" : "hash",
	};
}

export function loadConfig(agentDir: string): ResolvedDynamicWorkflowsConfig {
	const configPath = path.join(agentDir, "extensions", "dynamic-workflows", "config.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("config root must be a JSON object");
		}
		return resolveConfig(parsed as DynamicWorkflowsConfig);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`Failed to load dynamic-workflows config at '${configPath}':`, error);
		}
		return resolveConfig();
	}
}

export function resolveWorkflowPolicy(
	manifest: WorkflowManifest,
	config: ResolvedDynamicWorkflowsConfig,
): WorkflowPolicy {
	if (manifest.size === "unrestricted" && !config.allowUnrestricted) {
		throw new Error(
			"This workflow requests size 'unrestricted', but allowUnrestricted is disabled in dynamic-workflows config.",
		);
	}
	const sizeCap = manifest.size === "unrestricted"
		? Math.min(config.sizeLimits.unrestricted, config.unrestrictedSafetyCap)
		: config.sizeLimits[manifest.size];
	const maxAgents = manifest.maxAgents === undefined
		? sizeCap
		: Math.min(positiveInteger(manifest.maxAgents, sizeCap), sizeCap);
	const maxConcurrency = manifest.maxConcurrency === undefined
		? config.maxConcurrency
		: Math.min(positiveInteger(manifest.maxConcurrency, config.maxConcurrency), config.maxConcurrency, maxAgents);
	const timeoutMs = manifest.timeoutMs === undefined
		? config.maxRuntimeMs
		: Math.min(positiveInteger(manifest.timeoutMs, config.maxRuntimeMs), config.maxRuntimeMs);
	return {
		maxAgents,
		maxConcurrency,
		timeoutMs,
		maxIntermediateBytes: config.maxIntermediateBytes,
		maxResultBytes: config.maxResultBytes,
	};
}
