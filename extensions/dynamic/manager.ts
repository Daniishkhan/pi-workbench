import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { allowsSurface, capabilityForAgent } from "../core/role-policy.ts";
import { compileWorkflowSource } from "./compiler.ts";
import { resolveWorkflowPolicy } from "./config.ts";
import { DelegationClient } from "./delegation.ts";
import type {
	CompiledWorkflow,
	RunNode,
	WorkflowCondition,
	WorkflowNode,
	WorkflowReference,
	WorkflowValue,
} from "./ir.ts";
import { parseAndValidateStructuredOutput, assertSchemaSafe } from "./schema.ts";
import { WorkflowStore, writeJsonAtomic } from "./store.ts";
import type {
	DelegationProgress,
	ResolvedDynamicWorkflowsConfig,
	WorkflowAgentResult,
	WorkflowAgentTask,
	WorkflowRunResult,
	WorkflowRunSnapshot,
	WorkflowSource,
} from "./types.ts";

const MAX_TEMPLATE_CHARS = 128 * 1024;

interface ExecutionEnvironment {
	input: unknown;
	outputs: Record<string, unknown>;
	variables: Record<string, unknown>;
	item?: unknown;
	itemName?: string;
	iteration?: number;
}

interface ActiveWorkflowRun {
	source: WorkflowSource;
	compiled: CompiledWorkflow;
	snapshot: WorkflowRunSnapshot;
	env: ExecutionEnvironment;
	controller: AbortController;
	pauseRequested: boolean;
	pauseWaiters: Set<() => void>;
	stopRequested: boolean;
	timedOut: boolean;
	model?: string;
	done: Promise<WorkflowRunResult>;
	resolve: (result: WorkflowRunResult) => void;
	onUpdate?: (snapshot: WorkflowRunSnapshot) => void;
	agentArtifactIndex: number;
	externalSignal?: AbortSignal;
	externalAbortHandler?: () => void;
}

export interface StartWorkflowOptions {
	input?: unknown;
	cwd: string;
	sessionId: string;
	model?: string;
	background: boolean;
	signal?: AbortSignal;
	onUpdate?: (snapshot: WorkflowRunSnapshot) => void;
}

export interface StartedWorkflow {
	id: string;
	snapshot: WorkflowRunSnapshot;
	done: Promise<WorkflowRunResult>;
}

export interface WorkflowManagerOptions {
	store: WorkflowStore;
	delegation: DelegationClient;
	config: ResolvedDynamicWorkflowsConfig;
	readOnlyAgentMap: Readonly<Record<string, string>>;
	onChange?: (snapshot: WorkflowRunSnapshot) => void;
	onBackgroundComplete?: (result: WorkflowRunResult) => void;
}

function snapshotCopy(snapshot: WorkflowRunSnapshot): WorkflowRunSnapshot {
	return structuredClone(snapshot);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.floor((low + high + 1) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return `${value.slice(0, low)}\n\n[Intermediate output truncated to ${maxBytes} bytes. Full bounded result is in the workflow run artifacts.]`;
}

function assertAggregateValueSize(value: unknown, maxBytes: number, label: string): void {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new Error(`${label} is not JSON-serializable: ${errorText(error)}`);
	}
	if (serialized === undefined) throw new Error(`${label} is not JSON-serializable.`);
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes > maxBytes) throw new Error(`${label} is ${bytes} bytes, above the ${maxBytes}-byte intermediate-value limit.`);
}

function decodePointerSegment(value: string): string {
	return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePointer(root: unknown, pointer: string, label: string): unknown {
	if (!pointer) return root;
	let current = root;
	for (const raw of pointer.slice(1).split("/")) {
		const key = decodePointerSegment(raw);
		if (Array.isArray(current)) {
			if (!/^\d+$/.test(key)) throw new Error(`${label}: '${key}' is not a valid array index.`);
			const index = Number(key);
			if (index >= current.length) throw new Error(`${label}: array index ${index} does not exist.`);
			current = current[index];
			continue;
		}
		if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) {
			throw new Error(`${label}: property '${key}' does not exist.`);
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function resolveReference(reference: WorkflowReference, env: ExecutionEnvironment): unknown {
	switch (reference.source) {
		case "input": return resolvePointer(env.input, reference.pointer, "input reference");
		case "item": return resolvePointer(env.item, reference.pointer, "item reference");
		case "output": {
			if (!Object.hasOwn(env.outputs, reference.name)) throw new Error(`Output '${reference.name}' is not available.`);
			return resolvePointer(env.outputs[reference.name], reference.pointer, `output '${reference.name}'`);
		}
		case "variable": {
			if (!Object.hasOwn(env.variables, reference.name)) throw new Error(`Variable '${reference.name}' is not available.`);
			return resolvePointer(env.variables[reference.name], reference.pointer, `variable '${reference.name}'`);
		}
	}
}

function resolveValue(value: WorkflowValue, env: ExecutionEnvironment): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, env));
	if (value.kind === "reference") return resolveReference(value as WorkflowReference, env);
	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) output[key] = resolveValue(child, env);
	return output;
}

function conditionValue(condition: WorkflowCondition, env: ExecutionEnvironment): boolean {
	switch (condition.kind) {
		case "equals": return isDeepStrictEqual(resolveValue(condition.left, env), resolveValue(condition.right, env));
		case "exists": {
			try {
				return resolveValue(condition.value, env) !== undefined;
			} catch {
				return false;
			}
		}
		case "not-empty": {
			const value = resolveValue(condition.value, env);
			if (Array.isArray(value) || typeof value === "string") return value.length > 0;
			if (value && typeof value === "object") return Object.keys(value).length > 0;
			return Boolean(value);
		}
		case "not": return !conditionValue(condition.condition, env);
		case "and": return condition.conditions.every((entry) => conditionValue(entry, env));
		case "or": return condition.conditions.some((entry) => conditionValue(entry, env));
	}
}

function dottedValue(pathText: string, env: ExecutionEnvironment): unknown {
	const roots: Record<string, unknown> = {
		input: env.input,
		outputs: env.outputs,
		variables: env.variables,
		item: env.item,
		iteration: env.iteration,
	};
	if (env.itemName) roots[env.itemName] = env.item;
	const segments = pathText.split(".");
	const rootName = segments.shift()!;
	if (!Object.hasOwn(roots, rootName)) throw new Error(`Unknown workflow template root '${rootName}'.`);
	let current = roots[rootName];
	for (const key of segments) {
		if (Array.isArray(current) && /^\d+$/.test(key)) {
			current = current[Number(key)];
			continue;
		}
		if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) {
			throw new Error(`Workflow template value '{{${pathText}}}' does not exist.`);
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function renderTemplate(template: string, env: ExecutionEnvironment): string {
	const rendered = template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g, (_match, pathText: string) => {
		const value = dottedValue(pathText, env);
		if (typeof value === "string") return value;
		if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
		return JSON.stringify(value);
	});
	if (rendered.length > MAX_TEMPLATE_CHARS) throw new Error(`Rendered workflow task exceeds ${MAX_TEMPLATE_CHARS} characters.`);
	return rendered;
}

function collectOutputNames(nodes: WorkflowNode[], output = new Set<string>()): Set<string> {
	for (const node of nodes) {
		if (node.kind === "run") output.add(node.saveAs);
		else if (node.kind === "for-each") {
			output.add(node.collectAs);
			collectOutputNames(node.steps, output);
		} else if (node.kind === "repeat") {
			if (node.collectAs) output.add(node.collectAs);
			collectOutputNames(node.steps, output);
		} else if (node.kind === "phase") collectOutputNames(node.steps, output);
		else if (node.kind === "parallel") collectOutputNames(node.steps, output);
		else if (node.kind === "when") {
			collectOutputNames(node.then, output);
			collectOutputNames(node.else, output);
		}
	}
	return output;
}

function resultValue(result: WorkflowAgentResult): unknown {
	return result.structured !== undefined
		? result.structured
		: result.status === "completed"
			? result.output
			: { status: result.status, output: result.output, error: result.error };
}

export class WorkflowManager {
	readonly #store: WorkflowStore;
	readonly #delegation: DelegationClient;
	readonly #config: ResolvedDynamicWorkflowsConfig;
	readonly #readOnlyAgentMap: Readonly<Record<string, string>>;
	readonly #runs = new Map<string, ActiveWorkflowRun>();
	readonly #history = new Map<string, WorkflowRunSnapshot>();
	readonly #onChange?: (snapshot: WorkflowRunSnapshot) => void;
	readonly #onBackgroundComplete?: (result: WorkflowRunResult) => void;
	#activeRunId?: string;
	#shuttingDown = false;

	constructor(options: WorkflowManagerOptions) {
		this.#store = options.store;
		this.#delegation = options.delegation;
		this.#config = options.config;
		this.#readOnlyAgentMap = options.readOnlyAgentMap;
		this.#onChange = options.onChange;
		this.#onBackgroundComplete = options.onBackgroundComplete;
		for (const snapshot of this.#store.listRunStatuses()) {
			if (!["completed", "failed", "stopped"].includes(snapshot.state)) {
				snapshot.state = "failed";
				snapshot.endedAt = Date.now();
				snapshot.error = "Workflow execution was interrupted by a Pi session restart or reload and was not resumed.";
				this.#store.writeRunStatus(snapshot);
			}
			this.#history.set(snapshot.id, snapshot);
		}
	}

	start(source: WorkflowSource, options: StartWorkflowOptions): StartedWorkflow {
		if (this.#activeRunId) {
			const active = this.#runs.get(this.#activeRunId);
			if (active && !["completed", "failed", "stopped"].includes(active.snapshot.state)) {
				throw new Error(`Workflow '${active.snapshot.name}' (${active.snapshot.id}) is already active. Stop or finish it before starting another.`);
			}
		}
		const compiled = compileWorkflowSource(source.source, this.#config.defaultSize);
		if (compiled.manifest.name !== source.name) {
			throw new Error(`Approved source defines '${compiled.manifest.name}', not '${source.name}'.`);
		}
		const policy = resolveWorkflowPolicy(compiled.manifest, this.#config);
		const id = `wf-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
		const runDir = this.#store.createRunDir(id);
		const now = Date.now();
		const snapshot: WorkflowRunSnapshot = {
			version: 1,
			id,
			name: source.name,
			state: "queued",
			scope: source.scope,
			sourcePath: source.path,
			sourceHash: compiled.sourceHash,
			runDir,
			cwd: path.resolve(options.cwd),
			sessionId: options.sessionId,
			manifest: compiled.manifest,
			policy,
			createdAt: now,
			phases: compiled.manifest.phases.map((name) => ({ name, status: "pending" })),
			agentsLaunched: 0,
			agentsCompleted: 0,
			activeAgents: [],
			background: options.background,
		};
		let resolve!: (result: WorkflowRunResult) => void;
		const done = new Promise<WorkflowRunResult>((doneResolve) => { resolve = doneResolve; });
		const active: ActiveWorkflowRun = {
			source: { ...source, manifest: compiled.manifest, hash: compiled.sourceHash },
			compiled,
			snapshot,
			env: { input: options.input ?? {}, outputs: {}, variables: {} },
			controller: new AbortController(),
			pauseRequested: false,
			pauseWaiters: new Set(),
			stopRequested: false,
			timedOut: false,
			model: options.model,
			done,
			resolve,
			onUpdate: options.onUpdate,
			agentArtifactIndex: 0,
		};
		// Persist the complete initial record before publishing the run as active. If
		// any startup write fails, start() throws without leaving an unreachable
		// nonterminal promise that blocks every later run and shutdown.
		this.#store.writeRunSource(runDir, source.source, options.input ?? {});
		writeJsonAtomic(path.join(runDir, "compiled.ir.json"), compiled);
		this.#store.writeRunStatus(snapshot);
		this.#store.appendRunEvent(runDir, { at: Date.now(), type: "created" });
		this.#runs.set(id, active);
		this.#history.set(id, snapshot);
		this.#activeRunId = id;
		this.#notify(active);
		if (options.signal && !options.background) {
			const abort = () => {
				try { this.stop(id); } catch { /* The run may already be terminal. */ }
			};
			active.externalSignal = options.signal;
			active.externalAbortHandler = abort;
			if (options.signal.aborted) abort();
			else options.signal.addEventListener("abort", abort, { once: true });
		}
		queueMicrotask(() => void this.#execute(active));
		return { id, snapshot: snapshotCopy(snapshot), done };
	}

	get(id?: string): WorkflowRunSnapshot | undefined {
		const target = id ?? this.#activeRunId;
		if (!target) return undefined;
		const active = this.#runs.get(target);
		const snapshot = active?.snapshot ?? this.#history.get(target) ?? this.#store.readRunStatus(target);
		return snapshot ? snapshotCopy(snapshot) : undefined;
	}

	list(): WorkflowRunSnapshot[] {
		return [...this.#history.values()].map(snapshotCopy).sort((a, b) => b.createdAt - a.createdAt);
	}

	/** Snapshots of runs that may still produce work (non-terminal states). */
	listActive(): WorkflowRunSnapshot[] {
		return [...this.#runs.values()]
			.filter((run) => !["completed", "failed", "stopped"].includes(run.snapshot.state))
			.map((run) => snapshotCopy(run.snapshot));
	}

	pause(id?: string): WorkflowRunSnapshot {
		const run = this.#requireActive(id);
		run.pauseRequested = true;
		run.snapshot.state = run.snapshot.activeAgents.length > 0 ? "pausing" : "paused";
		this.#touch(run, { type: "pause_requested" });
		return snapshotCopy(run.snapshot);
	}

	resume(id?: string): WorkflowRunSnapshot {
		const run = this.#requireActive(id);
		if (!run.pauseRequested && run.snapshot.state !== "paused" && run.snapshot.state !== "pausing") {
			throw new Error(`Workflow '${run.snapshot.id}' is not paused.`);
		}
		run.pauseRequested = false;
		run.snapshot.state = "running";
		for (const resolve of run.pauseWaiters) resolve();
		run.pauseWaiters.clear();
		this.#touch(run, { type: "resumed" });
		return snapshotCopy(run.snapshot);
	}

	stop(id?: string): WorkflowRunSnapshot {
		const run = this.#requireActive(id);
		if (run.stopRequested) return snapshotCopy(run.snapshot);
		run.stopRequested = true;
		run.pauseRequested = false;
		run.snapshot.state = "stopping";
		for (const resolve of run.pauseWaiters) resolve();
		run.pauseWaiters.clear();
		run.controller.abort();
		try {
			this.#touch(run, { type: "stop_requested" });
		} catch (error) {
			run.snapshot.lastLog = `Stop status persistence failed: ${errorText(error)}`;
		}
		return snapshotCopy(run.snapshot);
	}

	async shutdown(graceMs = 2_500): Promise<void> {
		this.#shuttingDown = true;
		const pending: Promise<WorkflowRunResult>[] = [];
		for (const run of this.#runs.values()) {
			if (!["completed", "failed", "stopped"].includes(run.snapshot.state)) {
				pending.push(run.done);
				this.stop(run.snapshot.id);
			}
		}
		if (pending.length === 0) {
			this.#delegation.dispose();
			return;
		}
		const waitForPending = async (limitMs: number): Promise<boolean> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settled = await Promise.race([
				Promise.allSettled(pending).then(() => true),
				new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), limitMs); }),
			]);
			if (timer) clearTimeout(timer);
			return settled;
		};
		const drained = await waitForPending(graceMs);
		this.#delegation.dispose(!drained);
		if (!drained) await waitForPending(Math.max(250, Math.min(graceMs, 1_000)));
	}

	#requireActive(id?: string): ActiveWorkflowRun {
		const target = id ?? this.#activeRunId;
		if (!target) throw new Error("No active workflow run.");
		const run = this.#runs.get(target);
		if (!run) throw new Error(`Workflow run '${target}' was not found in this session.`);
		if (["completed", "failed", "stopped"].includes(run.snapshot.state)) {
			throw new Error(`Workflow run '${target}' is already ${run.snapshot.state}.`);
		}
		return run;
	}

	async #execute(run: ActiveWorkflowRun): Promise<void> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let result: WorkflowRunResult | undefined;
		try {
			run.snapshot.state = "running";
			run.snapshot.startedAt = Date.now();
			this.#touch(run, { type: "started" });
			timeout = setTimeout(() => {
				run.timedOut = true;
				run.pauseRequested = false;
				for (const resolve of run.pauseWaiters) resolve();
				run.pauseWaiters.clear();
				run.controller.abort();
				run.snapshot.state = "stopping";
				try {
					this.#touch(run, { type: "timeout", timeoutMs: run.snapshot.policy.timeoutMs });
				} catch (error) {
					run.snapshot.lastLog = `Timeout status persistence failed: ${errorText(error)}`;
				}
			}, run.snapshot.policy.timeoutMs);
			timeout.unref?.();
			await this.#executeNodes(run, run.compiled.steps, run.env);
			await this.#checkpoint(run);
			const value = resolveValue(run.compiled.result, run.env);
			const serialized = JSON.stringify(value, null, 2);
			if (Buffer.byteLength(serialized, "utf8") > run.snapshot.policy.maxResultBytes) {
				throw new Error(`Workflow selected result exceeds the ${run.snapshot.policy.maxResultBytes}-byte final-result limit. Save a compact synthesis as the workflow result and keep bulky data in intermediate artifacts.`);
			}
			const resultPath = path.join(run.snapshot.runDir, "result.json");
			writeJsonAtomic(resultPath, value);
			run.snapshot.resultPath = resultPath;
			run.snapshot.state = "completed";
			run.snapshot.endedAt = Date.now();
			result = {
				run: snapshotCopy(run.snapshot),
				value,
				summary: typeof value === "string" ? value : serialized,
			};
			this.#touch(run, { type: "completed", resultPath });
		} catch (error) {
			run.snapshot.endedAt = Date.now();
			delete run.snapshot.resultPath;
			if (run.timedOut) {
				run.snapshot.state = "failed";
				run.snapshot.error = `Workflow exceeded its ${run.snapshot.policy.timeoutMs}ms runtime limit. Active agents were cancelled when possible; external side effects are not rolled back.`;
			} else if (run.stopRequested || run.controller.signal.aborted) {
				run.snapshot.state = "stopped";
				run.snapshot.error = "Workflow stopped. Active agents were cancelled when possible; external side effects are not rolled back.";
			} else {
				run.snapshot.state = "failed";
				run.snapshot.error = errorText(error);
			}
			try {
				this.#touch(run, { type: run.snapshot.state, error: run.snapshot.error });
			} catch (persistenceError) {
				run.snapshot.error = `${run.snapshot.error} Status persistence also failed: ${errorText(persistenceError)}`;
			}
			result = { run: snapshotCopy(run.snapshot), summary: run.snapshot.error };
		} finally {
			if (timeout) clearTimeout(timeout);
			if (run.externalSignal && run.externalAbortHandler) {
				run.externalSignal.removeEventListener("abort", run.externalAbortHandler);
			}
			if (this.#activeRunId === run.snapshot.id) this.#activeRunId = undefined;
			const finalResult = result ?? {
				run: snapshotCopy(run.snapshot),
				summary: run.snapshot.error ?? "Workflow execution ended without a result.",
			};
			run.resolve(finalResult);
			if (run.snapshot.background && !this.#shuttingDown) {
				try { this.#onBackgroundComplete?.(finalResult); } catch { /* Durable status remains authoritative. */ }
			}
		}
	}

	async #checkpoint(run: ActiveWorkflowRun): Promise<void> {
		if (run.stopRequested || run.controller.signal.aborted) throw new Error("Workflow stopped.");
		if (!run.pauseRequested) return;
		run.snapshot.state = "paused";
		this.#touch(run, { type: "paused" });
		await new Promise<void>((resolve) => run.pauseWaiters.add(resolve));
		if (run.stopRequested || run.controller.signal.aborted) throw new Error("Workflow stopped.");
	}

	async #executeNodes(run: ActiveWorkflowRun, nodes: WorkflowNode[], env: ExecutionEnvironment): Promise<void> {
		for (const node of nodes) {
			await this.#checkpoint(run);
			this.#store.appendRunEvent(run.snapshot.runDir, { at: Date.now(), type: "node_start", nodeId: node.id, kind: node.kind });
			try {
				await this.#executeNode(run, node, env);
				this.#store.appendRunEvent(run.snapshot.runDir, { at: Date.now(), type: "node_complete", nodeId: node.id, kind: node.kind });
			} catch (error) {
				this.#store.appendRunEvent(run.snapshot.runDir, {
					at: Date.now(), type: "node_failed", nodeId: node.id, kind: node.kind, error: errorText(error),
				});
				throw error;
			}
		}
	}

	async #executeNode(run: ActiveWorkflowRun, node: WorkflowNode, env: ExecutionEnvironment): Promise<void> {
		switch (node.kind) {
			case "phase": {
				const phase = run.snapshot.phases.find((entry) => entry.name === node.name)!;
				phase.status = "running";
				phase.startedAt = Date.now();
				run.snapshot.currentPhase = node.name;
				this.#touch(run, { type: "phase_started", phase: node.name });
				try {
					await this.#executeNodes(run, node.steps, env);
					phase.status = "completed";
					phase.endedAt = Date.now();
					this.#touch(run, { type: "phase_completed", phase: node.name });
				} catch (error) {
					phase.status = "failed";
					phase.endedAt = Date.now();
					phase.error = errorText(error);
					this.#touch(run, { type: "phase_failed", phase: node.name, error: phase.error });
					throw error;
				}
				return;
			}
			case "run": {
				const [outcome] = await this.#executeRunBatch(run, [{ node, env }], { concurrency: 1, failFast: true });
				assertAggregateValueSize(outcome!.value, run.snapshot.policy.maxIntermediateBytes, `Output '${node.saveAs}'`);
				env.outputs[node.saveAs] = outcome!.value;
				return;
			}
			case "parallel": {
				const outcomes = await this.#executeRunBatch(
					run,
					node.steps.map((step) => ({ node: step, env })),
					{
						concurrency: node.concurrency ?? run.snapshot.policy.maxConcurrency,
						worktree: node.worktree,
						failFast: node.failFast ?? false,
					},
				);
				for (const outcome of outcomes) {
					assertAggregateValueSize(outcome.value, run.snapshot.policy.maxIntermediateBytes, `Output '${outcome.node.saveAs}'`);
					env.outputs[outcome.node.saveAs] = outcome.value;
				}
				return;
			}
			case "for-each": {
				const items = resolveValue(node.from, env);
				if (!Array.isArray(items)) throw new Error(`forEach('${node.id}') source did not resolve to an array.`);
				if (items.length > node.maxItems) {
					throw new Error(`forEach('${node.id}') resolved ${items.length} items; maxItems is ${node.maxItems}.`);
				}
				if (items.length === 0) {
					env.outputs[node.collectAs] = [];
					return;
				}
				const childEnvs = items.map<ExecutionEnvironment>((entry) => ({
					input: env.input,
					outputs: { ...env.outputs },
					variables: { ...env.variables },
					item: entry,
					itemName: node.itemName,
				}));
				if (node.steps.length === 1 && node.steps[0]!.kind === "run") {
					const outcomes = await this.#executeRunBatch(
						run,
						childEnvs.map((childEnv) => ({ node: node.steps[0] as RunNode, env: childEnv })),
						{
							concurrency: node.concurrency ?? run.snapshot.policy.maxConcurrency,
							worktree: node.worktree,
							failFast: node.failFast ?? false,
						},
					);
					const collected = outcomes.map((outcome) => outcome.value);
					assertAggregateValueSize(collected, run.snapshot.policy.maxIntermediateBytes, `forEach '${node.id}' collection '${node.collectAs}'`);
					env.outputs[node.collectAs] = collected;
					return;
				}
				const names = collectOutputNames(node.steps);
				const collected: unknown[] = [];
				for (const childEnv of childEnvs) {
					await this.#executeNodes(run, node.steps, childEnv);
					const itemOutput: Record<string, unknown> = {};
					for (const name of names) if (Object.hasOwn(childEnv.outputs, name)) itemOutput[name] = childEnv.outputs[name];
					collected.push(itemOutput);
					assertAggregateValueSize(collected, run.snapshot.policy.maxIntermediateBytes, `forEach '${node.id}' collection '${node.collectAs}'`);
				}
				assertAggregateValueSize(collected, run.snapshot.policy.maxIntermediateBytes, `forEach '${node.id}' collection '${node.collectAs}'`);
				env.outputs[node.collectAs] = collected;
				return;
			}
			case "when":
				await this.#executeNodes(run, conditionValue(node.condition, env) ? node.then : node.else, env);
				return;
			case "repeat": {
				const names = collectOutputNames(node.steps);
				const collected: unknown[] = [];
				for (let iteration = 0; iteration < node.maxIterations; iteration++) {
					env.iteration = iteration;
					await this.#executeNodes(run, node.steps, env);
					if (node.collectAs) {
						const iterationOutput: Record<string, unknown> = {};
						for (const name of names) if (Object.hasOwn(env.outputs, name)) iterationOutput[name] = env.outputs[name];
						collected.push(iterationOutput);
						assertAggregateValueSize(collected, run.snapshot.policy.maxIntermediateBytes, `repeat '${node.id}' collected iterations`);
					}
					if (conditionValue(node.until, env)) break;
					if (iteration === node.maxIterations - 1) {
						throw new Error(`repeat('${node.id}') reached maxIterations=${node.maxIterations} without satisfying until.`);
					}
				}
				delete env.iteration;
				if (node.collectAs) env.outputs[node.collectAs] = collected;
				return;
			}
			case "set": {
				const value = resolveValue(node.value, env);
				assertAggregateValueSize(value, run.snapshot.policy.maxIntermediateBytes, `Variable '${node.name}'`);
				env.variables[node.name] = value;
				return;
			}
		}
	}

	async #executeRunBatch(
		run: ActiveWorkflowRun,
		entries: Array<{ node: RunNode; env: ExecutionEnvironment }>,
		options: { concurrency: number; worktree?: boolean; failFast: boolean },
	): Promise<Array<{ node: RunNode; result: WorkflowAgentResult; value: unknown }>> {
		if (entries.length === 0) return [];
		this.#reserveAgents(run, entries.length);
		const prepared = entries.map(({ node, env }) => ({ node, env, task: this.#prepareTask(run, node, env) }));
		const writers = prepared.filter((entry) => entry.task.write === true);
		if (writers.length > 0 && entries.length > 1) {
			throw new Error("Dynamic workflows serialize writers. Parallel write-capable nodes are rejected even when source requests worktree:true; use one writer followed by read-only verification.");
		}
		const concurrency = Math.max(1, Math.min(options.concurrency, run.snapshot.policy.maxConcurrency, entries.length));
		const rawResults: WorkflowAgentResult[] = [];
		if (prepared.length > 1) {
			for (let start = 0; start < prepared.length; start += concurrency) {
				await this.#checkpoint(run);
				const chunk = prepared.slice(start, start + concurrency);
				const requestIds = new Set<string>();
				try {
					const results = await this.#delegation.runParallel(chunk.map((entry) => entry.task), {
						cwd: run.snapshot.cwd,
						context: chunk[0]!.task.context ?? "fresh",
						model: run.model,
						concurrency: chunk.length,
						signal: run.controller.signal,
						onProgress: (progress) => {
							requestIds.add(progress.requestId);
							this.#recordProgress(run, progress, chunk.map((entry) => entry.node.task.agent));
						},
					});
					rawResults.push(...results);
				} finally {
					this.#clearProgress(run, requestIds);
				}
				if (options.failFast && rawResults.some((result) => result.status !== "completed")) break;
			}
		} else {
			for (const entry of prepared) {
				await this.#checkpoint(run);
				const requestIds = new Set<string>();
				try {
					rawResults.push(await this.#delegation.runSingle(entry.task, {
						cwd: run.snapshot.cwd,
						context: entry.task.context ?? "fresh",
						model: run.model,
						signal: run.controller.signal,
						onProgress: (progress) => {
							requestIds.add(progress.requestId);
							this.#recordProgress(run, progress, [entry.node.task.agent]);
						},
					}));
				} finally {
					this.#clearProgress(run, requestIds);
				}
				if (options.failFast && rawResults.at(-1)?.status !== "completed") break;
			}
		}
		const outcomes: Array<{ node: RunNode; result: WorkflowAgentResult; value: unknown }> = [];
		for (let index = 0; index < rawResults.length; index++) {
			const entry = prepared[index]!;
			const result = rawResults[index]!;
			const fullOutput = result.output;
			let structured: unknown;
			let validationError: string | undefined;
			if (Buffer.byteLength(fullOutput, "utf8") > run.snapshot.policy.maxIntermediateBytes) {
				validationError = `Agent output exceeds the ${run.snapshot.policy.maxIntermediateBytes}-byte intermediate-output limit.`;
			} else if (result.status === "completed" && entry.node.task.schema) {
				try {
					structured = parseAndValidateStructuredOutput(fullOutput, entry.node.task.schema);
					if (Buffer.byteLength(JSON.stringify(structured), "utf8") > run.snapshot.policy.maxIntermediateBytes) {
						validationError = `Structured agent output exceeds the ${run.snapshot.policy.maxIntermediateBytes}-byte intermediate-output limit.`;
						structured = undefined;
					}
				} catch (error) {
					validationError = errorText(error);
				}
			}
			const normalized: WorkflowAgentResult = {
				...result,
				agent: entry.node.task.agent,
				...(validationError ? { status: "failed" as const, error: validationError } : {}),
				output: truncateUtf8(fullOutput, run.snapshot.policy.maxIntermediateBytes),
				...(structured !== undefined ? { structured } : {}),
			};
			run.snapshot.agentsCompleted++;
			this.#persistAgentResult(run, entry.node, normalized, fullOutput);
			outcomes.push({ node: entry.node, result: normalized, value: resultValue(normalized) });
		}
		this.#touch(run, { type: "agent_batch_completed", count: outcomes.length });
		const failure = outcomes.find((outcome) => outcome.result.status !== "completed");
		if (failure && options.failFast) {
			throw new Error(
				`Workflow agent '${failure.result.agent}' failed at node '${failure.node.id}': ${failure.result.error || failure.result.output || failure.result.status}`,
			);
		}
		if (outcomes.length !== entries.length) {
			throw new Error(`Workflow batch stopped after ${outcomes.length}/${entries.length} agents.`);
		}
		return outcomes;
	}

	#prepareTask(run: ActiveWorkflowRun, node: RunNode, env: ExecutionEnvironment): WorkflowAgentTask {
		const task = { ...node.task, task: renderTemplate(node.task.task, env) };
		if (!allowsSurface(task.agent, "dynamic")) {
			throw new Error(`Node '${node.id}' selects agent '${task.agent}', which is not approved for the Dynamic Workflows surface.`);
		}
		const capability = capabilityForAgent(task.agent);
		if (capability === "writer" && !task.write) {
			throw new Error(`Node '${node.id}' selects writer-capable agent '${task.agent}' without explicit write:true.`);
		}
		if (capability === "read-only" && task.write) {
			throw new Error(`Node '${node.id}' marks read-only agent '${task.agent}' as write-capable.`);
		}
		if (task.write && !run.snapshot.manifest.permissions.includes("write")) {
			throw new Error(`Node '${node.id}' requests write access, but workflow permissions do not include 'write'.`);
		}
		if (!task.write) {
			const pinnedAgent = this.#readOnlyAgentMap[task.agent];
			if (!pinnedAgent) {
				throw new Error(
					`Node '${node.id}' uses agent '${task.agent}' as read-only. v0.1 permits only the pinned logical agents ${Object.keys(this.#readOnlyAgentMap).join(", ")}; declare write:true with manifest permission for any other agent.`,
				);
			}
			task.agent = pinnedAgent;
		}
		if ((task.context ?? "fresh") === "fork" && !run.snapshot.manifest.permissions.includes("fork-context")) {
			throw new Error(`Node '${node.id}' requests forked parent context, but workflow permissions do not include 'fork-context'.`);
		}
		if (task.schema) assertSchemaSafe(task.schema);
		const remainingMs = Math.max(1, run.snapshot.policy.timeoutMs - (Date.now() - (run.snapshot.startedAt ?? Date.now())));
		const timeoutMs = Math.min(task.timeoutMs ?? remainingMs, remainingMs);
		const safety = task.write
			? "This node is explicitly write-capable. Stay within the task and report every changed file. Do not launch subagents, agent teams, Shipyard, or workflows."
			: "This node is read-only. Do not edit, write, delete, move, or create project/source files. Returning output and normal Pi-owned artifacts is allowed. Do not launch subagents, agent teams, Shipyard, or workflows.";
		const structured = task.schema
			? `\nReturn only JSON matching this schema (no prose or Markdown fence):\n${JSON.stringify(task.schema)}`
			: "";
		return {
			...task,
			timeoutMs,
			task: [
				`Dynamic workflow '${run.snapshot.name}', node '${node.id}'.`,
				safety,
				"Your response is an intermediate workflow value and will not be copied into the main conversation unless the workflow returns it.",
				"",
				task.task,
				structured,
			].filter(Boolean).join("\n"),
		};
	}

	#reserveAgents(run: ActiveWorkflowRun, count: number): void {
		if (run.snapshot.agentsLaunched + count > run.snapshot.policy.maxAgents) {
			throw new Error(
				`Workflow agent budget exceeded: ${run.snapshot.agentsLaunched} already launched + ${count} requested > ${run.snapshot.policy.maxAgents}.`,
			);
		}
		run.snapshot.agentsLaunched += count;
		this.#touch(run, { type: "agents_reserved", count });
	}

	#logicalAgent(runtimeName: string): string {
		for (const [logical, runtime] of Object.entries(this.#readOnlyAgentMap)) if (runtime === runtimeName) return logical;
		return runtimeName;
	}

	#recordProgress(run: ActiveWorkflowRun, progress: DelegationProgress, fallbackAgents: string[]): void {
		const logicalFor = (runtimeName: string, index?: number): string => {
			if (index !== undefined && fallbackAgents[index]) return fallbackAgents[index]!;
			if (fallbackAgents.length === 1) return fallbackAgents[0]!;
			return this.#logicalAgent(runtimeName);
		};
		let active = run.snapshot.activeAgents.find((entry) => entry.requestId === progress.requestId);
		if (!active) {
			active = {
				requestId: progress.requestId,
				agents: progress.tasks?.map((entry) => logicalFor(entry.agent, entry.index)) ?? fallbackAgents,
				startedAt: Date.now(),
			};
			run.snapshot.activeAgents.push(active);
		}
		const current = progress.tasks?.find((entry) => entry.currentTool || entry.recentOutput);
		const summary = current
			? `${logicalFor(current.agent, current.index)}${current.currentTool ? ` → ${current.currentTool}` : ""}${current.recentOutput ? `: ${current.recentOutput}` : ""}`
			: `${progress.agent ? logicalFor(progress.agent) : fallbackAgents.join(", ")}${progress.currentTool ? ` → ${progress.currentTool}` : ""}${progress.recentOutput ? `: ${progress.recentOutput}` : ""}`;
		run.snapshot.lastLog = truncateUtf8(summary, 2_000);
		this.#touch(run);
	}

	#clearProgress(run: ActiveWorkflowRun, requestIds: Set<string>): void {
		if (requestIds.size === 0) return;
		run.snapshot.activeAgents = run.snapshot.activeAgents.filter((entry) => !requestIds.has(entry.requestId));
		if (run.pauseRequested) run.snapshot.state = "paused";
		this.#touch(run);
	}

	#persistAgentResult(run: ActiveWorkflowRun, node: RunNode, result: WorkflowAgentResult, fullOutput: string): void {
		const index = ++run.agentArtifactIndex;
		const file = path.join(
			run.snapshot.runDir,
			"agents",
			`${String(index).padStart(3, "0")}-${node.id}.json`,
		);
		const boundedFullOutput = truncateUtf8(fullOutput, run.snapshot.policy.maxIntermediateBytes);
		writeJsonAtomic(file, { nodeId: node.id, saveAs: node.saveAs, ...result, output: boundedFullOutput });
	}

	#notify(run: ActiveWorkflowRun): void {
		const copy = snapshotCopy(run.snapshot);
		try { run.onUpdate?.(copy); } catch { /* Observers must not control workflow lifecycle. */ }
		try { this.#onChange?.(copy); } catch { /* UI/reporting failures are non-fatal. */ }
	}

	#touch(run: ActiveWorkflowRun, event?: Record<string, unknown>): void {
		this.#history.set(run.snapshot.id, run.snapshot);
		this.#store.writeRunStatus(run.snapshot);
		if (event) this.#store.appendRunEvent(run.snapshot.runDir, { at: Date.now(), ...event });
		this.#notify(run);
	}
}
