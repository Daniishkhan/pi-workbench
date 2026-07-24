import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { initializeStore } from "./findings-store.ts";
import { createCapabilityRegistry, type CapabilityPolicy, type FindingUpdateField } from "./findings-capabilities.ts";
import { runIdFromSpawnReply, type SubagentRpcClient } from "../core/subagent-rpc.ts";
import type { WriterCoordinator } from "../core/writer-coordinator.ts";
import type { RpcReply } from "./rpc-client.ts";
import { WORKFLOW_NAMES, completeWorkflowModes, normalizeWorkflowName, parseShipyardCommand, type WorkflowName } from "./workflow-names.ts";
import { bindWorkflowAgents, materializeWorkflowOutputs, resolveWorkflowTask } from "./workflow-policy.ts";

const CHILD_ENV = "PI_SUBAGENT_CHILD";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHIPYARD_RUNS_ROOT = path.join(getAgentDir(), "shipyard-runs");

const WORKFLOWS: Record<WorkflowName, { file: string; timeoutMs: number; findings: boolean }> = {
	explore: { file: "explore.chain.json", timeoutMs: 15 * 60_000, findings: false },
	debug: { file: "debug.chain.json", timeoutMs: 30 * 60_000, findings: false },
	fast: { file: "review-fast.chain.json", timeoutMs: 20 * 60_000, findings: true },
	review: { file: "review-mesh.chain.json", timeoutMs: 45 * 60_000, findings: true },
	security: { file: "review-security.chain.json", timeoutMs: 60 * 60_000, findings: true },
	ui: { file: "review-ui.chain.json", timeoutMs: 60 * 60_000, findings: true },
	compact: { file: "deliver-compact.chain.json", timeoutMs: 60 * 60_000, findings: true },
	deliver: { file: "deliver.chain.json", timeoutMs: 120 * 60_000, findings: true },
	ship: { file: "ship.chain.json", timeoutMs: 90 * 60_000, findings: true },
};

const MUTATING_WORKFLOWS = new Set<WorkflowName>(["compact", "deliver", "ship"]);

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
	rpc: RpcReply["data"];
}

export interface ShipyardWorkflowService {
	spawn(ctx: ExtensionContext, name: WorkflowName, task?: string, signal?: AbortSignal): Promise<ShipyardWorkflowLaunch>;
}

interface WorkflowFile {
	name: string;
	description: string;
	chain: Array<Record<string, unknown>>;
}

const WorkflowParams = Type.Object({
	workflow: StringEnum(WORKFLOW_NAMES),
	task: Type.Optional(Type.String({ maxLength: 32_768, description: "Target or scope. Required for debug, compact, and deliver; optional diff defaults exist for review and ship." })),
}, { additionalProperties: false });

const SHIPYARD_HELP = [
	"Shipyard: /shipyard <mode> [task]",
	"  explore <question>   Search and trace the codebase",
	"  debug <symptom>      Reproduce and root-cause a failure",
	"  fast [target]        Focused two-angle review",
	"  review [target]      Deep staged review mesh",
	"  security [target]    Security-sensitive review",
	"  ui [target]          UI, state, and accessibility review",
	"  compact <task>       Lite delivery: implement, two-angle review, fix, handoff",
	"  deliver <task>       Implement an approved task end to end",
	"  ship [scope]         Fix and prove an existing diff",
].join("\n");

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function safePart(prefix: "S" | "R", value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
	return `${prefix}-${normalized}`;
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
	const filePath = path.join(PACKAGE_ROOT, "chains", "shipyard", WORKFLOWS[name].file);
	const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<WorkflowFile>;
	if (!parsed || typeof parsed.name !== "string" || typeof parsed.description !== "string" || !Array.isArray(parsed.chain)) {
		throw new Error(`Invalid Shipyard workflow file: ${filePath}`);
	}
	return parsed as WorkflowFile;
}

const FIRST_WAVE_OUTPUTS = new Set(["contracts", "runtime", "adversarial", "integration", "security", "ui"]);
const ALL_UPDATE_FIELDS: FindingUpdateField[] = ["title", "summary", "severity", "confidence", "status", "category", "evidence", "failureScenario", "suggestedFix", "validation", "dispositionReason", "tags"];

function findingStage(task: Record<string, unknown>): string {
	const text = typeof task.task === "string" ? task.task : "";
	const explicit = text.match(/(?:creation )?stage\s+`([^`]+)`/i)?.[1]?.trim();
	return explicit || (typeof task.as === "string" ? task.as : "workflow");
}

function capabilityPolicy(task: Record<string, unknown>): CapabilityPolicy | undefined {
	const agent = typeof task.agent === "string" ? task.agent : "";
	const output = typeof task.as === "string" ? task.as : "";
	if (!agent || agent.endsWith(".codebase-reader") || agent.endsWith(".codebase-explorer")
		|| agent.endsWith(".debugger") || agent.endsWith(".delivery-planner")) return undefined;
	const base = { stage: findingStage(task), sourceRole: agent };
	if (FIRST_WAVE_OUTPUTS.has(output)) return { ...base, actions: ["init", "add"] };
	if (agent.endsWith(".falsifier")) return {
		...base,
		actions: ["init", "get", "list", "update", "stats", "snapshot"],
		updateFields: ALL_UPDATE_FIELDS,
		updateStatuses: ["verified", "rejected", "deferred"],
	};
	if (agent.endsWith(".blindspot-hunter")) return {
		...base,
		actions: ["init", "add", "get", "list", "update", "stats", "snapshot"],
		updateFields: ["confidence", "evidence", "validation", "tags"],
	};
	if (agent.endsWith(".review-synthesizer")) return {
		...base,
		actions: ["init", "get", "list", "update", "stats", "snapshot", "export"],
		updateFields: ALL_UPDATE_FIELDS,
		updateStatuses: ["verified", "rejected", "deferred", "resolved"],
	};
	if (agent.endsWith(".implementation-worker")) {
		if (output !== "fixes") return undefined;
		return {
			...base,
			actions: ["init", "get", "list", "update", "stats"],
			updateFields: ["status", "suggestedFix", "validation", "dispositionReason", "tags"],
			updateStatuses: ["resolved", "deferred"],
		};
	}
	if (agent.endsWith(".shipwright")) return {
		...base,
		actions: ["init", "add", "get", "list", "update", "stats", "snapshot", "export"],
		updateFields: ALL_UPDATE_FIELDS,
		updateStatuses: ["verified", "rejected", "deferred", "resolved"],
	};
	return {
		...base,
		actions: ["init", "add", "get", "list", "update", "stats"],
		updateFields: ["confidence", "status", "evidence", "validation", "dispositionReason", "tags"],
		updateStatuses: ["verified", "rejected", "deferred", "resolved"],
	};
}

function collectCapabilityTasks(chain: Array<Record<string, unknown>>): Array<{ task: Record<string, unknown>; policy: CapabilityPolicy }> {
	const collected: Array<{ task: Record<string, unknown>; policy: CapabilityPolicy }> = [];
	const visit = (task: Record<string, unknown>) => {
		const parallel = Array.isArray(task.parallel) ? task.parallel as Array<Record<string, unknown>> : [];
		for (const child of parallel) visit(child);
		const policy = capabilityPolicy(task);
		if (policy) collected.push({ task, policy });
	};
	for (const step of chain) visit(step);
	return collected;
}

function redactCapabilities(value: unknown, tokens: string[]): unknown {
	let serialized = JSON.stringify(value);
	for (const token of tokens) serialized = serialized.replaceAll(token, "[redacted-findings-capability]");
	return JSON.parse(serialized);
}

export default function registerWorkflows(pi: ExtensionAPI, options: RegisterWorkflowsOptions = {}): ShipyardWorkflowService {
	if (process.env[CHILD_ENV] === "1") {
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
		const sessionDir = safePart("S", sessionId);
		const runId = safePart("R", `${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`);
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
		const target = resolveWorkflowTask(name, task);
		const writerLease = MUTATING_WORKFLOWS.has(name)
			? options.writerCoordinator?.acquire(ctx.cwd, `shipyard:${name}`)
			: undefined;
		let preserveWriterLease = false;
		try {
			const ping = await rpc.request("ping", {}, signal);
			if (!ping.success) throw new Error(`${ping.error?.code ?? "rpc_error"}: ${ping.error?.message ?? "pi-subagents RPC ping failed."}`);
			if (signal?.aborted) throw new Error("Shipyard workflow cancelled after RPC readiness check.");
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
			let reply: RpcReply;
			try {
				reply = await rpc.request("spawn", {
					chain: run.chain,
					task: target,
					cwd: ctx.cwd,
					context: "fresh",
					async: true,
					clarify: false,
					artifacts: false,
					maxRuntimeMs: WORKFLOWS[name].timeoutMs,
				});
			} catch (error) {
				preserveWriterLease = Boolean(writerLease);
				options.writerCoordinator?.markUncertain(writerLease?.token);
				await writeFile(launchPath, `${JSON.stringify({
					...launchBase,
					state: "launch-uncertain",
					failedAt: new Date().toISOString(),
					error: error instanceof Error ? error.message : String(error),
					recovery: "Inspect pi-subagents async status; the spawn request may have been accepted before the RPC reply was lost.",
				}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
				throw error;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
			if (!reply.success) {
				await writeFile(launchPath, `${JSON.stringify({ ...launchBase, state: "rejected", failedAt: new Date().toISOString(), rpc: reply }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
				throw new Error(`${reply.error?.code ?? "rpc_error"}: ${reply.error?.message ?? "Shipyard workflow launch failed."}`);
			}
			const subagentRunId = runIdFromSpawnReply(reply);
			if (writerLease) {
				preserveWriterLease = true;
				if (subagentRunId) options.writerCoordinator?.attachRun(writerLease.token, subagentRunId);
				else options.writerCoordinator?.markUncertain(writerLease.token);
			}
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
				message: `${rpcText}\nShipyard run: ${run.runId}${WORKFLOWS[name].findings ? `\nLedger: ${run.storePath}` : ""}`,
				shipyardRunId: run.runId,
				runDir: run.runDir,
				storePath: run.storePath,
				rpc: reply.data,
			};
		} catch (error) {
			if (!preserveWriterLease) options.writerCoordinator?.release(writerLease?.token);
			throw error;
		}
	}

	pi.registerTool({
		name: "shipyard_workflow",
		label: "Shipyard Workflow",
		description: "Launch a deterministic asynchronous Shipyard workflow through pi-subagents. Use explore for codebase questions, debug for failure triage, fast or review for correctness review, security or ui for domain review, compact for slice-sized delivery, deliver for approved implementation, and ship for an existing diff. Shipyard never commits or pushes automatically.",
		parameters: WorkflowParams,
		prepareArguments(args): { workflow: WorkflowName; task?: string } {
			const input = (args && typeof args === "object" ? args : {}) as { workflow?: unknown; task?: unknown };
			const workflow = typeof input.workflow === "string" ? normalizeWorkflowName(input.workflow) : undefined;
			return {
				workflow: (workflow ?? input.workflow) as WorkflowName,
				...(typeof input.task === "string" ? { task: input.task } : {}),
			};
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("shipyard_workflow cancelled");
			const launched = await spawnWorkflow(ctx, params.workflow as WorkflowName, params.task, signal);
			return textResult(launched.message, launched);
		},
	});

	pi.registerCommand("shipyard", {
		description: "Explore, debug, review, deliver, or ship code with one command",
		getArgumentCompletions: (prefix) => completeWorkflowModes(prefix)?.map((mode) => ({ value: mode, label: mode })) ?? null,
		handler: async (args, ctx) => {
			const parsed = parseShipyardCommand(args);
			if (!parsed.mode) {
				ctx.ui.notify(SHIPYARD_HELP, "info");
				return;
			}
			if (!parsed.workflow) {
				ctx.ui.notify(`Unknown Shipyard mode: ${parsed.mode}\n\n${SHIPYARD_HELP}`, "error");
				return;
			}
			try {
				const launched = await spawnWorkflow(ctx, parsed.workflow, parsed.task);
				ctx.ui.notify(launched.message, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	return { spawn: spawnWorkflow };
}
