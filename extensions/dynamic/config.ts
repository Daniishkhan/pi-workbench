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

/** Legacy pre-unification config location, read only as a fallback when the
 * unified Workbench config has no `dynamic` section. */
export function legacyDynamicConfigPath(agentDir: string): string {
	return path.join(agentDir, "extensions", "dynamic-workflows", "config.json");
}

function readLegacyConfig(file: string): DynamicWorkflowsConfig | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("config root must be a JSON object");
		}
		return parsed as DynamicWorkflowsConfig;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`Failed to load dynamic-workflows config at '${file}':`, error);
		}
		return undefined;
	}
}

export interface LoadDynamicConfigResult {
	config: ResolvedDynamicWorkflowsConfig;
	/** Human-readable deprecation/migration warnings (legacy config in use). */
	warnings: string[];
}

/** Resolve Dynamic Workflows policy. The unified Workbench config's `dynamic`
 * section is the primary source; the legacy standalone
 * extensions/dynamic-workflows/config.json is read only as a fallback and
 * emits a deprecation warning. */
export function loadDynamicConfig(agentDir: string, primary?: Record<string, unknown>): LoadDynamicConfigResult {
	const legacyPath = legacyDynamicConfigPath(agentDir);
	const hasPrimary = Boolean(primary && Object.keys(primary).length > 0);
	if (hasPrimary) {
		const legacy = readLegacyConfig(legacyPath);
		const warnings = legacy
			? [`Dynamic Workflows policy now lives in the 'dynamic' section of the Pi Workbench config; the legacy file '${legacyPath}' is ignored and can be deleted.`]
			: [];
		return { config: resolveConfig(primary as DynamicWorkflowsConfig), warnings };
	}
	const legacy = readLegacyConfig(legacyPath);
	if (legacy) {
		return {
			config: resolveConfig(legacy),
			warnings: [`Dynamic Workflows is configured by the deprecated legacy file '${legacyPath}'. Move these settings into the 'dynamic' section of the Pi Workbench config.`],
		};
	}
	return { config: resolveConfig(), warnings: [] };
}

/** Back-compat wrapper: resolved config only, warnings logged. */
export function loadConfig(agentDir: string): ResolvedDynamicWorkflowsConfig {
	const { config, warnings } = loadDynamicConfig(agentDir);
	for (const warning of warnings) console.error(warning);
	return config;
}

export function resolveWorkflowPolicy(
	manifest: WorkflowManifest,
	config: ResolvedDynamicWorkflowsConfig,
): WorkflowPolicy {
	if (manifest.size === "unrestricted" && !config.allowUnrestricted) {
		throw new Error(
			"This workflow requests size 'unrestricted', but allowUnrestricted is disabled in the Workbench 'dynamic' config section.",
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
