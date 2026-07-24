import type { WorkflowAgentTask, WorkflowManifest } from "./types.ts";

export interface InputReference {
	kind: "reference";
	source: "input";
	pointer: string;
}

export interface OutputReference {
	kind: "reference";
	source: "output";
	name: string;
	pointer: string;
}

export interface VariableReference {
	kind: "reference";
	source: "variable";
	name: string;
	pointer: string;
}

export interface ItemReference {
	kind: "reference";
	source: "item";
	pointer: string;
}

export type WorkflowReference = InputReference | OutputReference | VariableReference | ItemReference;

export type WorkflowValue =
	| null
	| boolean
	| number
	| string
	| WorkflowReference
	| WorkflowValue[]
	| { [key: string]: WorkflowValue };

export type WorkflowCondition =
	| { kind: "equals"; left: WorkflowValue; right: WorkflowValue }
	| { kind: "exists"; value: WorkflowValue }
	| { kind: "not-empty"; value: WorkflowValue }
	| { kind: "not"; condition: WorkflowCondition }
	| { kind: "and"; conditions: WorkflowCondition[] }
	| { kind: "or"; conditions: WorkflowCondition[] };

export interface RunNode {
	kind: "run";
	id: string;
	label?: string;
	saveAs: string;
	task: WorkflowAgentTask;
}

export interface PhaseNode {
	kind: "phase";
	id: string;
	name: string;
	steps: WorkflowNode[];
}

export interface ParallelNode {
	kind: "parallel";
	id: string;
	label: string;
	concurrency?: number;
	worktree?: boolean;
	failFast?: boolean;
	steps: RunNode[];
}

export interface ForEachNode {
	kind: "for-each";
	id: string;
	label: string;
	from: WorkflowValue;
	itemName: string;
	maxItems: number;
	concurrency?: number;
	worktree?: boolean;
	failFast?: boolean;
	collectAs: string;
	steps: WorkflowNode[];
}

export interface WhenNode {
	kind: "when";
	id: string;
	label: string;
	condition: WorkflowCondition;
	then: WorkflowNode[];
	else: WorkflowNode[];
}

export interface RepeatNode {
	kind: "repeat";
	id: string;
	label: string;
	maxIterations: number;
	until: WorkflowCondition;
	collectAs?: string;
	steps: WorkflowNode[];
}

export interface SetNode {
	kind: "set";
	id: string;
	name: string;
	value: WorkflowValue;
}

export type WorkflowNode = RunNode | PhaseNode | ParallelNode | ForEachNode | WhenNode | RepeatNode | SetNode;

export interface CompiledWorkflow {
	version: 1;
	manifest: WorkflowManifest;
	steps: WorkflowNode[];
	result: WorkflowValue;
	staticNodeCount: number;
	sourceHash: string;
}
