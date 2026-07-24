export const WORKFLOW_FORMAT_VERSION = 1 as const;

export type WorkflowSize = "small" | "medium" | "large" | "unrestricted";
export type WorkflowPermission = "read" | "write" | "fork-context";
export type WorkflowScope = "draft" | "user" | "project";
export type WorkflowRunState =
	| "queued"
	| "running"
	| "pausing"
	| "paused"
	| "completed"
	| "failed"
	| "stopping"
	| "stopped";

export interface WorkflowManifest {
	version: typeof WORKFLOW_FORMAT_VERSION;
	name: string;
	description: string;
	size: WorkflowSize;
	permissions: WorkflowPermission[];
	phases: string[];
	maxAgents?: number;
	maxConcurrency?: number;
	timeoutMs?: number;
}

export interface WorkflowPolicy {
	maxAgents: number;
	maxConcurrency: number;
	timeoutMs: number;
	maxIntermediateBytes: number;
	maxResultBytes: number;
}

export interface WorkflowSource {
	name: string;
	source: string;
	hash: string;
	manifest: WorkflowManifest;
	scope: WorkflowScope;
	path: string;
}

export interface WorkflowAgentTask {
	agent: string;
	task: string;
	write?: boolean;
	context?: "fresh" | "fork";
	model?: string;
	timeoutMs?: number;
	turnBudget?: { maxTurns: number; graceTurns?: number };
	toolBudget?: { soft?: number; hard: number; block?: string[] | "*" };
	schema?: Record<string, unknown>;
}

export interface WorkflowAgentResult {
	agent: string;
	status: "completed" | "failed" | "cancelled" | "timed_out" | "interrupted";
	output: string;
	structured?: unknown;
	error?: string;
	model?: string;
	durationMs?: number;
	turns?: number;
	toolCount?: number;
	tokens?: number;
	outputPath?: string;
	sessionFile?: string;
	warnings?: string[];
}

export interface WorkflowPhaseState {
	name: string;
	status: "pending" | "running" | "completed" | "failed";
	startedAt?: number;
	endedAt?: number;
	error?: string;
}

export interface WorkflowRunSnapshot {
	version: 1;
	id: string;
	name: string;
	state: WorkflowRunState;
	scope: WorkflowScope;
	sourcePath: string;
	sourceHash: string;
	runDir: string;
	cwd: string;
	sessionId: string;
	manifest: WorkflowManifest;
	policy: WorkflowPolicy;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	currentPhase?: string;
	phases: WorkflowPhaseState[];
	agentsLaunched: number;
	agentsCompleted: number;
	activeAgents: Array<{ requestId: string; agents: string[]; startedAt: number }>;
	lastLog?: string;
	resultPath?: string;
	error?: string;
	background: boolean;
}

export interface WorkflowRunResult {
	run: WorkflowRunSnapshot;
	value?: unknown;
	summary: string;
}

export interface DynamicWorkflowsConfig {
	defaultSize?: WorkflowSize;
	sizeLimits?: Partial<Record<WorkflowSize, number>>;
	maxConcurrency?: number;
	maxRuntimeMs?: number;
	maxIntermediateBytes?: number;
	maxResultBytes?: number;
	allowUnrestricted?: boolean;
	unrestrictedSafetyCap?: number;
	allowUnattendedTrusted?: boolean;
	approvalMode?: "always" | "hash";
}

export interface ResolvedDynamicWorkflowsConfig {
	defaultSize: WorkflowSize;
	sizeLimits: Record<WorkflowSize, number>;
	maxConcurrency: number;
	maxRuntimeMs: number;
	maxIntermediateBytes: number;
	maxResultBytes: number;
	allowUnrestricted: boolean;
	unrestrictedSafetyCap: number;
	allowUnattendedTrusted: boolean;
	approvalMode: "always" | "hash";
}

export interface DelegationProgress {
	requestId: string;
	agent?: string;
	currentTool?: string;
	recentOutput?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
	tasks?: Array<{
		index?: number;
		agent: string;
		status?: string;
		currentTool?: string;
		recentOutput?: string;
	}>;
}
