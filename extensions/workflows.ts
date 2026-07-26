import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beginGuardedSpawn } from "./core/guarded-spawn.ts";
import { ROUTE_LIMITS, WORKFLOW_MODES, type WorkflowMode } from "./core/routing.ts";
import type { SubagentRpcClient, SubagentRpcReply } from "./core/subagent-rpc.ts";
import type { WriterCoordinator } from "./core/writer-coordinator.ts";

export const WORKFLOW_NAMES = WORKFLOW_MODES;
export type WorkflowName = WorkflowMode;

export interface WorkflowLimits {
	timeoutMs: number;
}

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
		limits: WorkflowLimits,
		signal?: AbortSignal,
	): Promise<WorkflowLaunch>;
}

export interface CreateWorkflowServiceOptions {
	writerCoordinator: WriterCoordinator;
	rpc: SubagentRpcClient;
}

interface WorkflowFile {
	name: string;
	description: string;
	chain: Array<Record<string, unknown>>;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_FILES: Record<WorkflowName, string> = {
	audit: "audit.chain.json",
	deliver: "deliver.chain.json",
};
async function loadWorkflow(name: WorkflowName): Promise<WorkflowFile> {
	const file = path.join(PACKAGE_ROOT, "chains", "workbench", WORKFLOW_FILES[name]);
	const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<WorkflowFile>;
	if (parsed.name !== name || typeof parsed.description !== "string" || !Array.isArray(parsed.chain) || !parsed.chain.length) {
		throw new Error(`Invalid Workbench workflow file: ${file}`);
	}
	return parsed as WorkflowFile;
}

function targetTask(name: WorkflowName, task: string): string {
	const target = task.trim();
	if (!target) throw new Error(`Workbench ${name} requires a non-empty task.`);
	return target;
}

function runtimeLimit(name: WorkflowName, limits: WorkflowLimits): number {
	const value = limits.timeoutMs;
	if (!Number.isInteger(value) || value < 1) throw new Error(`Workbench ${name} requires a positive integer timeoutMs.`);
	const ceiling = ROUTE_LIMITS[name].timeoutMs;
	if (value > ceiling) {
		throw new Error(`Workbench ${name} timeout exceeds its ${ceiling / 60_000}-minute ceiling.`);
	}
	return value;
}

export default function createWorkflowService(options: CreateWorkflowServiceOptions): WorkflowService {
	async function spawn(
		ctx: ExtensionContext,
		name: WorkflowName,
		task: string,
		limits: WorkflowLimits,
		signal?: AbortSignal,
	): Promise<WorkflowLaunch> {
		const target = targetTask(name, task);
		const maxRuntimeMs = runtimeLimit(name, limits);
		const workflow = await loadWorkflow(name);
		const guard = await beginGuardedSpawn({
			rpc: options.rpc,
			writerCoordinator: options.writerCoordinator,
			cwd: ctx.cwd,
			owner: `workbench:${name}`,
			writeCapable: name === "deliver",
			label: "Workbench workflow launch",
			signal,
		});

		try {
			if (signal?.aborted) throw new Error(`Workbench ${name} cancelled before subagent spawn.`);
			const launched = await guard.spawn({
				params: {
					chain: workflow.chain,
					task: target,
					cwd: ctx.cwd,
					context: "fresh",
					async: true,
					clarify: false,
					// Chain outputs remain in upstream's run-scoped chain directory; disable
					// bulky per-child transcript and metadata artifacts.
					artifacts: false,
					maxRuntimeMs,
				},
				signal,
				requireRunIdMessage: `Workbench ${name} was accepted without a run id; inspect active subagents before retrying.`,
			});

			const message = launched.reply.data?.text?.trim() || `Launched Workbench ${name}.`;
			return {
				message: `${message}\nRun: ${launched.runId}`,
				runId: launched.runId!,
				rpc: launched.reply.data,
			};
		} catch (error) {
			// No-op after an accepted or uncertain spawn; otherwise releases the
			// deliver writer lease acquired by beginGuardedSpawn.
			guard.discard();
			throw error;
		}
	}

	return { spawn };
}
