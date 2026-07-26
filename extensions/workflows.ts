import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beginGuardedSpawn } from "./core/guarded-spawn.ts";
import {
	limitsForAction,
	ENGINEERING_EFFORTS,
	WORKFLOW_ACTIONS,
	type EngineeringEffort,
	type WorkflowAction,
} from "./core/routing.ts";
import type { SubagentRpcClient, SubagentRpcReply } from "./core/subagent-rpc.ts";
import { requireWorkflowDefinition, type WorkflowDefinition } from "./core/workflow-validation.ts";
import type { WriterCoordinator } from "./core/writer-coordinator.ts";

export const WORKFLOW_NAMES = WORKFLOW_ACTIONS;
export type WorkflowName = WorkflowAction;

export interface WorkflowLaunch {
	message: string;
	runId: string;
	rpc: SubagentRpcReply["data"];
}

export interface WorkflowService {
	spawn(
		ctx: ExtensionContext,
		name: WorkflowName,
		task: string,
		effort: EngineeringEffort,
		signal?: AbortSignal,
	): Promise<WorkflowLaunch>;
}

export interface CreateWorkflowServiceOptions {
	writerCoordinator: WriterCoordinator;
	rpc: SubagentRpcClient;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_FILES: Record<WorkflowName, string> = {
	audit: "audit.chain.json",
	deliver: "deliver.chain.json",
};
async function loadWorkflow(name: WorkflowName): Promise<WorkflowDefinition> {
	const file = path.join(PACKAGE_ROOT, "chains", "workbench", WORKFLOW_FILES[name]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		throw new Error(`Invalid Pi Engineering workflow file: ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return requireWorkflowDefinition(name, parsed, file);
}

export interface WorkflowServiceDependencies {
	loadWorkflow?: (name: WorkflowName) => Promise<unknown>;
}

function targetTask(name: WorkflowName, task: string): string {
	const target = task.trim();
	if (!target) throw new Error(`Engineering ${name} requires a non-empty task.`);
	return target;
}

function runtimeLimit(name: WorkflowName, effort: EngineeringEffort): number {
	if (!(ENGINEERING_EFFORTS as readonly unknown[]).includes(effort)) {
		throw new Error(`Engineering ${name} effort must be quick, standard, or deep.`);
	}
	return limitsForAction(name, effort).timeoutMs;
}

export default function createWorkflowService(
	options: CreateWorkflowServiceOptions,
	dependencies: WorkflowServiceDependencies = {},
): WorkflowService {
	async function spawn(
		ctx: ExtensionContext,
		name: WorkflowName,
		task: string,
		effort: EngineeringEffort,
		signal?: AbortSignal,
	): Promise<WorkflowLaunch> {
		const target = targetTask(name, task);
		const maxRuntimeMs = runtimeLimit(name, effort);
		// Validate the complete, closed workflow contract before RPC readiness
		// checks or writer-lease acquisition. A malformed chain launches nothing.
		const loaded = await (dependencies.loadWorkflow ?? loadWorkflow)(name);
		const workflow = requireWorkflowDefinition(name, loaded);
		const guard = await beginGuardedSpawn({
			rpc: options.rpc,
			writerCoordinator: options.writerCoordinator,
			cwd: ctx.cwd,
			owner: `engineering:${name}`,
			writeCapable: name === "deliver",
			label: "Engineering workflow assignment",
			signal,
		});

		try {
			if (signal?.aborted) throw new Error(`Engineering ${name} cancelled before specialist spawn.`);
			const launched = await guard.spawn({
				params: {
					chain: workflow.chain,
					task: target,
					cwd: ctx.cwd,
					context: "fresh",
					async: true,
					clarify: false,
					// Relative plan/implementation/fix receipts must resolve inside upstream's
					// run-scoped artifact tree, never against the target worktree.
					artifacts: true,
					maxRuntimeMs,
				},
				signal,
				requireRunIdMessage: `Engineering ${name} was accepted without a run id; inspect active specialists before retrying.`,
			});

			const message = launched.reply.data?.text?.trim() || `Assigned engineering ${name}.`;
			return {
				message: `${message}\nRun: ${launched.runId}`,
				runId: launched.runId!,
				rpc: launched.reply.data,
			};
		} catch (error) {
			// No-op after an accepted or uncertain spawn; otherwise releases the
			// deliver write lock acquired by beginGuardedSpawn.
			guard.discard();
			throw error;
		}
	}

	return { spawn };
}
