/**
 * Canonical Shipyard workflow catalog: the single table every consumer reads
 * (workflow runner, router status/help text, validator). Names are declared
 * in core/routing.ts so the router can classify modes without importing
 * Shipyard internals.
 */

import type { ShipyardWorkflowName } from "../core/routing.ts";

export interface ShipyardWorkflowDefinition {
	/** Chain definition file under chains/shipyard/. */
	file: string;
	/** Hard maxRuntimeMs passed to the pi-subagents async chain run. */
	timeoutMs: number;
	/** Whether the workflow maintains a run-scoped findings ledger. */
	findings: boolean;
	/** Mutating workflows hold a writer lease for the whole run. */
	mutating: boolean;
	/** Default task when the caller supplies none; absent means a task is required. */
	defaultTask?: string;
}

export const SHIPYARD_WORKFLOWS: Readonly<Record<ShipyardWorkflowName, ShipyardWorkflowDefinition>> = {
	explore: {
		file: "explore.chain.json",
		timeoutMs: 15 * 60_000,
		findings: false,
		mutating: false,
		defaultTask: "Map this repository's architecture, entry points, primary flows, module boundaries, and test harness for future codebase questions.",
	},
	debug: {
		file: "debug.chain.json",
		timeoutMs: 30 * 60_000,
		findings: false,
		mutating: false,
	},
	fast: {
		file: "review-fast.chain.json",
		timeoutMs: 20 * 60_000,
		findings: true,
		mutating: false,
		defaultTask: "Run a focused bug review of the current worktree diff.",
	},
	review: {
		file: "review-mesh.chain.json",
		timeoutMs: 45 * 60_000,
		findings: true,
		mutating: false,
		defaultTask: "Review the current worktree diff against the user request, repository instructions, and existing behavior.",
	},
	security: {
		file: "review-security.chain.json",
		timeoutMs: 60 * 60_000,
		findings: true,
		mutating: false,
		defaultTask: "Review the current worktree diff for correctness and security boundary failures.",
	},
	ui: {
		file: "review-ui.chain.json",
		timeoutMs: 60 * 60_000,
		findings: true,
		mutating: false,
		defaultTask: "Review the current UI worktree diff for behavior, state-flow, accessibility, interaction, and visual regressions.",
	},
	compact: {
		file: "deliver-compact.chain.json",
		timeoutMs: 60 * 60_000,
		findings: true,
		mutating: true,
	},
	deliver: {
		file: "deliver.chain.json",
		timeoutMs: 120 * 60_000,
		findings: true,
		mutating: true,
	},
	ship: {
		file: "ship.chain.json",
		timeoutMs: 90 * 60_000,
		findings: true,
		mutating: true,
		defaultTask: "Review, fix, validate, and prepare the current worktree changes for shipment. Do not commit or push.",
	},
};

export function shipyardWorkflow(name: ShipyardWorkflowName): ShipyardWorkflowDefinition {
	return SHIPYARD_WORKFLOWS[name];
}

export function resolveWorkflowTask(name: ShipyardWorkflowName, task?: string): string {
	const target = task?.trim();
	if (target) return target;
	const fallback = SHIPYARD_WORKFLOWS[name].defaultTask;
	if (!fallback) throw new Error(`Shipyard ${name} requires a non-empty task.`);
	return fallback;
}
