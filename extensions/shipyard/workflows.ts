import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChildSession } from "../core/env.ts";
import { beginGuardedSpawn, type GuardedSpawnResult } from "../core/guarded-spawn.ts";
import type { ShipyardWorkflowName as WorkflowName } from "../core/routing.ts";
import { safePathSegment } from "../core/sanitize.ts";
import type { SubagentRpcClient, SubagentRpcReply } from "../core/subagent-rpc.ts";
import type { WriterCoordinator } from "../core/writer-coordinator.ts";
import { initializeStore } from "./findings-store.ts";
import { createCapabilityRegistry } from "./findings-capabilities.ts";
import { collectCapabilityTasks } from "./findings-policy.ts";
import { SHIPYARD_WORKFLOWS, resolveWorkflowTask } from "./workflow-catalog.ts";
import { bindWorkflowAgents, materializeWorkflowOutputs } from "./workflow-policy.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHIPYARD_RUNS_ROOT = path.join(getAgentDir(), "shipyard-runs");

export interface RegisterWorkflowsOptions {
	agentBindings?: Record<string, string>;
	writerCoordinator?: WriterCoordinator;
	rpc?: SubagentRpcClient;
}

export interface ShipyardWorkflowLaunch {
	[key: string]: unknown;
	message: string;
	shipyardRunId: string;
	runDir: string;
	storePath: string;
	rpc: SubagentRpcReply["data"];
}

export interface ShipyardWorkflowService {
	spawn(ctx: ExtensionContext, name: WorkflowName, task?: string, signal?: AbortSignal): Promise<ShipyardWorkflowLaunch>;
}

interface WorkflowFile {
	name: string;
	description: string;
	chain: Array<Record<string, unknown>>;
}

function replacePlaceholders(value: unknown, replacements: Record<string, string>): unknown {
	if (typeof value === "string") {
		let output = value;
		for (const [placeholder, replacement] of Object.entries(replacements)) output = output.replaceAll(placeholder, replacement);
		return output;
	}
	if (Array.isArray(value)) return value.map((entry) => replacePlaceholders(entry, replacements));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, replacePlaceholders(entry, replacements)]));
	}
	return value;
}

async function loadWorkflow(name: WorkflowName): Promise<WorkflowFile> {
	const filePath = path.join(PACKAGE_ROOT, "chains", "shipyard", SHIPYARD_WORKFLOWS[name].file);
	const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<WorkflowFile>;
	if (!parsed || typeof parsed.name !== "string" || typeof parsed.description !== "string" || !Array.isArray(parsed.chain)) {
		throw new Error(`Invalid Shipyard workflow file: ${filePath}`);
	}
	return parsed as WorkflowFile;
}

function redactCapabilities(value: unknown, tokens: string[]): unknown {
	let serialized = JSON.stringify(value);
	for (const token of tokens) serialized = serialized.replaceAll(token, "[redacted-findings-capability]");
	return JSON.parse(serialized);
}

export default function registerWorkflows(pi: ExtensionAPI, options: RegisterWorkflowsOptions = {}): ShipyardWorkflowService {
	if (isChildSession()) {
		return {
			async spawn() {
				throw new Error("Shipyard workflow orchestration is unavailable inside a subagent child session.");
			},
		};
	}
	if (!options.rpc) throw new Error("Shipyard workflows require the shared Pi Workbench RPC client.");
	const rpc: SubagentRpcClient = options.rpc;

	async function createRun(ctx: ExtensionContext, name: WorkflowName, workflow: WorkflowFile): Promise<{
		runId: string;
		runDir: string;
		storePath: string;
		chain: Array<Record<string, unknown>>;
	}> {
		const sessionId = ctx.sessionManager.getSessionId() ?? `ephemeral-${randomUUID().slice(0, 8)}`;
		const sessionDir = `S-${safePathSegment(sessionId)}`;
		const runId = `R-${safePathSegment(`${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`)}`;
		const runDir = path.join(SHIPYARD_RUNS_ROOT, sessionDir, runId);
		const storePath = path.join(runDir, "findings");
		const artifactsDir = path.join(runDir, "artifacts");
		await mkdir(runDir, { recursive: true, mode: 0o700 });
		await mkdir(storePath, { recursive: true, mode: 0o700 });
		await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
		await initializeStore(storePath, { runId, workflow: name });
		const replacedChain = replacePlaceholders(workflow.chain, {
			"{{SHIPYARD_RUN_ID}}": runId,
			"{{SHIPYARD_RUN_DIR}}": runDir,
			"{{SHIPYARD_STORE}}": storePath,
		}) as Array<Record<string, unknown>>;
		const canonicalChain = materializeWorkflowOutputs(replacedChain, artifactsDir);
		const capabilityTasks = collectCapabilityTasks(canonicalChain);
		const grants = await createCapabilityRegistry(storePath, runId, name, capabilityTasks.map((entry) => entry.policy));
		for (let index = 0; index < capabilityTasks.length; index += 1) {
			const task = capabilityTasks[index].task;
			const token = grants[index].token;
			const instruction = `Findings capability: ${token}. Pass it exactly as the capability parameter on every review_findings call. Never copy it into an artifact or finding.`;
			task.task = `${String(task.task ?? "").trimEnd()}\n\n${instruction}`;
		}
		const chain = bindWorkflowAgents(canonicalChain, options.agentBindings ?? {}) as Array<Record<string, unknown>>;
		await writeFile(path.join(runDir, "workflow.json"), `${JSON.stringify({
			schemaVersion: 1,
			runId,
			workflow: name,
			description: workflow.description,
			cwd: ctx.cwd,
			createdAt: new Date().toISOString(),
			agentBindings: options.agentBindings ?? {},
			chain: redactCapabilities(chain, grants.map((grant) => grant.token)),
		}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		return { runId, runDir, storePath, chain };
	}

	async function spawnWorkflow(ctx: ExtensionContext, name: WorkflowName, task?: string, signal?: AbortSignal): Promise<ShipyardWorkflowLaunch> {
		const definition = SHIPYARD_WORKFLOWS[name];
		const target = resolveWorkflowTask(name, task);
		// Acquires the writer lease (mutating workflows) and verifies RPC
		// readiness; ping failure releases the lease before throwing.
		const guard = await beginGuardedSpawn({
			rpc,
			writerCoordinator: options.writerCoordinator,
			cwd: ctx.cwd,
			owner: `shipyard:${name}`,
			writeCapable: definition.mutating,
			label: "Shipyard workflow launch",
			signal,
		});
		if (signal?.aborted) {
			guard.discard();
			throw new Error("Shipyard workflow cancelled after RPC readiness check.");
		}
		try {
			const workflow = await loadWorkflow(name);
			if (signal?.aborted) throw new Error("Shipyard workflow cancelled before run creation.");
			const run = await createRun(ctx, name, workflow);
			if (signal?.aborted) {
				await rm(run.runDir, { recursive: true, force: true });
				throw new Error("Shipyard workflow cancelled before subagent spawn.");
			}
			const launchPath = path.join(run.runDir, "launch.json");
			const launchBase = {
				schemaVersion: 1,
				shipyardRunId: run.runId,
				workflow: name,
				task: target,
				requestedAt: new Date().toISOString(),
			};
			await writeFile(launchPath, `${JSON.stringify({ ...launchBase, state: "requesting", rpc: null }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			let abortedDuringSpawn = false;
			const onAbort = () => { abortedDuringSpawn = true; };
			signal?.addEventListener("abort", onAbort, { once: true });
			let launched: GuardedSpawnResult;
			try {
				// Deliberately no signal on the spawn request: an abort mid-spawn
				// must run the stop-request flow below, not lose the RPC reply.
				launched = await guard.spawn({
					params: {
						chain: run.chain,
						task: target,
						cwd: ctx.cwd,
						context: "fresh",
						async: true,
						clarify: false,
						artifacts: false,
						maxRuntimeMs: definition.timeoutMs,
					},
					onTransportError: async (error) => {
						await writeFile(launchPath, `${JSON.stringify({
							...launchBase,
							state: "launch-uncertain",
							failedAt: new Date().toISOString(),
							error: error instanceof Error ? error.message : String(error),
							recovery: "Inspect pi-subagents async status; the spawn request may have been accepted before the RPC reply was lost.",
						}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
					},
					onRejected: async (reply) => {
						await writeFile(launchPath, `${JSON.stringify({ ...launchBase, state: "rejected", failedAt: new Date().toISOString(), rpc: reply }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
					},
				});
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
			const { reply, runId: subagentRunId } = launched;
			if (abortedDuringSpawn || signal?.aborted) {
				let stopRequested = false;
				if (subagentRunId) stopRequested = await rpc.request("stop", { id: subagentRunId }).then((stop) => stop.success, () => false);
				await writeFile(launchPath, `${JSON.stringify({
					...launchBase,
					state: stopRequested ? "cancellation-requested" : "cancellation-uncertain",
					cancelledAt: new Date().toISOString(),
					rpc: reply.data ?? null,
					stopRequested,
				}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
				throw new Error(subagentRunId
					? `Shipyard workflow cancelled after spawn acknowledgement; ${stopRequested ? "stop requested" : "stop could not be confirmed"} for ${subagentRunId}.`
					: "Shipyard workflow cancelled after spawn acknowledgement; inspect active subagents because no run id was returned.");
			}
			await writeFile(launchPath, `${JSON.stringify({
				...launchBase,
				state: "launched",
				launchedAt: new Date().toISOString(),
				rpc: reply.data ?? null,
			}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			const rpcText = reply.data?.text?.trim() || `Launched Shipyard workflow ${name}.`;
			return {
				message: `${rpcText}\nShipyard run: ${run.runId}${definition.findings ? `\nLedger: ${run.storePath}` : ""}`,
				shipyardRunId: run.runId,
				runDir: run.runDir,
				storePath: run.storePath,
				rpc: reply.data,
			};
		} catch (error) {
			// Releases the lease only while the guard still owns it; once a spawn
			// succeeded (or may have), the run owns the lease and it is preserved.
			guard.discard();
			throw error;
		}
	}

	// Workflow orchestration is intentionally exposed only through the
	// package-level workbench_route tool and /workbench command.
	return { spawn: spawnWorkflow };
}
