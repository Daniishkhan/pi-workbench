import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isChildSession } from "../core/env.ts";
import type { WriterCoordinator } from "../core/writer-coordinator.ts";
import { compileWorkflowSource } from "./compiler.ts";
import { loadConfig, resolveWorkflowPolicy } from "./config.ts";
import { DelegationClient } from "./delegation.ts";
import { WorkflowManager } from "./manager.ts";
import { createPinnedReadOnlyAgents, type PinnedReadOnlyAgents } from "./pinned-agents.ts";
import { WorkflowStore } from "./store.ts";
import type {
	ResolvedDynamicWorkflowsConfig,
	WorkflowRunResult,
	WorkflowRunSnapshot,
	WorkflowSource,
} from "./types.ts";

const WIDGET_KEY = "dynamic-workflows";
const MESSAGE_TYPE = "dynamic-workflow-complete";
const SOURCE_MAX_CHARS = 64 * 1024;
const INPUT_MAX_BYTES = 4 * 1024;

const JsonObject = Type.Unsafe<Record<string, unknown>>({
	type: "object",
	additionalProperties: true,
	description: "JSON object passed to the workflow as input.",
});

const CreateParams = Type.Object({
	name: Type.String({ description: "Workflow name; must match the name declared in source." }),
	source: Type.String({ maxLength: SOURCE_MAX_CHARS, description: "Restricted JavaScript workflow({...}) builder source." }),
});

const RunParams = Type.Object({
	name: Type.String({ description: "Session draft or saved workflow name." }),
	input: Type.Optional(JsonObject),
	background: Type.Optional(Type.Boolean({ description: "Run in the background. Default false." })),
});

const ControlParams = Type.Object({
	action: StringEnum(["list", "status", "pause", "resume", "stop", "save", "delete"] as const),
	id: Type.Optional(Type.String({ description: "Workflow run id for status/pause/resume/stop." })),
	name: Type.Optional(Type.String({ description: "Workflow name for save/delete." })),
	scope: Type.Optional(StringEnum(["user", "project"] as const)),
	overwrite: Type.Optional(Type.Boolean({ description: "Allow save to replace an existing workflow." })),
});

interface RuntimeState {
	store: WorkflowStore;
	manager: WorkflowManager;
	config: ResolvedDynamicWorkflowsConfig;
	ctx: ExtensionContext;
	pinnedAgents: PinnedReadOnlyAgents;
}

function modelId(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function inputBytes(input: unknown): number {
	let serialized: string;
	try {
		serialized = JSON.stringify(input ?? {}, (_key, child) => {
			if (typeof child === "number" && !Number.isFinite(child)) throw new Error("non-finite numbers are not valid JSON");
			if (typeof child === "bigint") throw new Error("BigInt is not valid JSON");
			return child;
		});
	} catch (error) {
		throw new Error(`Workflow input must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes > INPUT_MAX_BYTES) throw new Error(`Workflow input is ${bytes} bytes; maximum is ${INPUT_MAX_BYTES}.`);
	return bytes;
}

function approvalKey(source: WorkflowSource, input: unknown, cwd: string): string {
	return createHash("sha256")
		.update(source.hash)
		.update("\0")
		.update(JSON.stringify(input ?? {}))
		.update("\0")
		.update(cwd)
		.digest("hex");
}

function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
	return `${Math.round(ms / 60_000)}m`;
}

function formatSnapshot(snapshot: WorkflowRunSnapshot): string {
	const elapsed = (snapshot.endedAt ?? Date.now()) - (snapshot.startedAt ?? snapshot.createdAt);
	const phase = snapshot.currentPhase ? ` · phase: ${snapshot.currentPhase}` : "";
	const agents = `agents: ${snapshot.agentsCompleted}/${snapshot.agentsLaunched}/${snapshot.policy.maxAgents}`;
	return [
		`${snapshot.name} [${snapshot.state}] · ${snapshot.id}`,
		`${agents}${phase} · ${formatDuration(elapsed)}`,
		...(snapshot.lastLog ? [snapshot.lastLog] : []),
		...(snapshot.error ? [`Error: ${snapshot.error}`] : []),
		`Artifacts: ${snapshot.runDir}`,
	].join("\n");
}

function formatWorkflow(source: WorkflowSource): string {
	return `${source.name} [${source.scope}] · ${source.manifest.size} · ${source.manifest.permissions.join(",")} · ${source.manifest.description}`;
}

export interface RegisterDynamicWorkflowsOptions {
	writerCoordinator?: WriterCoordinator;
}

export default function registerDynamicWorkflows(pi: ExtensionAPI, options: RegisterDynamicWorkflowsOptions = {}): void {
	if (isChildSession()) return;

	let runtime: RuntimeState | undefined;
	const sessionApprovals = new Set<string>();

	function requireRuntime(ctx?: ExtensionContext): RuntimeState {
		if (!runtime) throw new Error("Dynamic-workflows runtime is not initialized. Run /reload and try again.");
		if (ctx && runtime.ctx.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
			throw new Error("Dynamic-workflows runtime belongs to a different Pi session.");
		}
		return runtime;
	}

	function refreshUi(snapshot: WorkflowRunSnapshot): void {
		const current = runtime?.ctx;
		if (!current?.hasUI) return;
		try {
			if (["completed", "failed", "stopped"].includes(snapshot.state)) {
				current.ui.setStatus(WIDGET_KEY, undefined);
				current.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			current.ui.setStatus(WIDGET_KEY, `workflow:${snapshot.name} ${snapshot.state}`);
			const active = snapshot.activeAgents.flatMap((entry) => entry.agents).slice(0, 4);
			current.ui.setWidget(WIDGET_KEY, [
				`Dynamic workflow: ${snapshot.name} [${snapshot.state}]`,
				`Phase: ${snapshot.currentPhase ?? "starting"} · Agents: ${snapshot.agentsCompleted}/${snapshot.agentsLaunched}/${snapshot.policy.maxAgents}`,
				...(active.length > 0 ? [`Active: ${active.join(", ")}`] : []),
				...(snapshot.lastLog ? [snapshot.lastLog.split("\n", 1)[0]!] : []),
				`Use /workbench dynamic to inspect or control run ${snapshot.id}`,
			]);
		} catch {
			// The context can become stale during session replacement.
		}
	}

	function backgroundComplete(result: WorkflowRunResult): void {
		const snapshot = result.run;
		const content = [
			`Dynamic workflow **${snapshot.name}** ${snapshot.state}.`,
			"",
			result.summary,
			"",
			`Artifacts: ${snapshot.runDir}`,
		].join("\n");
		try {
			pi.sendMessage(
				{ customType: MESSAGE_TYPE, content, display: true, details: { run: snapshot } },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// The durable run result remains on disk and workflow_control can inspect it.
		}
	}

	async function initialize(ctx: ExtensionContext): Promise<RuntimeState> {
		if (runtime) {
			const prior = runtime;
			runtime = undefined;
			await prior.manager.shutdown();
			prior.pinnedAgents.dispose();
		}
		const config = loadConfig(getAgentDir());
		const store = new WorkflowStore({
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
			configDirName: CONFIG_DIR_NAME,
			sessionId: ctx.sessionManager.getSessionId() ?? `ephemeral-${Date.now().toString(36)}`,
			projectTrusted: ctx.isProjectTrusted(),
		});
		const pinnedAgents = createPinnedReadOnlyAgents(getAgentDir());
		try {
			const delegation = new DelegationClient(pi.events);
			const manager = new WorkflowManager({
				store,
				delegation,
				config,
				readOnlyAgentMap: pinnedAgents.map,
				onChange: refreshUi,
				onBackgroundComplete: backgroundComplete,
			});
			runtime = { store, manager, config, ctx, pinnedAgents };
			return runtime;
		} catch (error) {
			pinnedAgents.dispose();
			throw error;
		}
	}

	async function reviewAndApprove(
		original: WorkflowSource,
		input: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<WorkflowSource> {
		const current = requireRuntime(ctx);
		inputBytes(input);
		let source = original;
		let compiled = compileWorkflowSource(source.source, current.config.defaultSize);
		if (compiled.manifest.name !== source.name) {
			throw new Error(`Workflow source defines '${compiled.manifest.name}', not '${source.name}'.`);
		}
		source = { ...source, hash: compiled.sourceHash, manifest: compiled.manifest };
		const persistedTrusted = source.scope !== "draft" && current.store.isTrusted(source);
		const initialKey = approvalKey(source, input, ctx.cwd);
		if (sessionApprovals.has(initialKey)) return source;

		const mustReviewSource = current.config.approvalMode === "always" || !persistedTrusted;
		if (!ctx.hasUI) {
			if (persistedTrusted && current.config.allowUnattendedTrusted) return source;
			throw new Error("Dynamic workflow execution requires interactive approval. Unattended runs are disabled by default.");
		}
		if (mustReviewSource) {
			const edited = await ctx.ui.editor(
				`Review dynamic workflow JavaScript: ${source.name}`,
				source.source,
			);
			if (edited === undefined) throw new Error("Workflow review cancelled.");
			const normalized = edited.endsWith("\n") ? edited : `${edited}\n`;
			compiled = compileWorkflowSource(normalized, current.config.defaultSize);
			if (compiled.manifest.name !== source.name) {
				throw new Error(`Reviewed source renamed the workflow to '${compiled.manifest.name}'. Expected '${source.name}'.`);
			}
			if (source.scope === "draft") {
				source = current.store.stage(source.name, normalized, compiled.manifest);
			} else {
				source = { ...source, source: normalized, hash: compiled.sourceHash, manifest: compiled.manifest };
			}
		}

		source = { ...source, hash: compiled.sourceHash, manifest: compiled.manifest };
		const policy = resolveWorkflowPolicy(compiled.manifest, current.config);
		const inputPreview = JSON.stringify(input, null, 2);
		const confirmed = await ctx.ui.confirm(
			`Run workflow '${source.name}'?`,
			[
				compiled.manifest.description,
				`SHA-256: ${compiled.sourceHash}`,
				`Scope: ${source.scope} · Permissions: ${compiled.manifest.permissions.join(", ")}`,
				`Phases: ${compiled.manifest.phases.join(" → ")}`,
				`Static nodes: ${compiled.staticNodeCount} · Hard agent cap: ${policy.maxAgents}`,
				`Concurrency: ${policy.maxConcurrency} · Timeout: ${formatDuration(policy.timeoutMs)}`,
				`Cwd: ${ctx.cwd}`,
				`Input: ${inputPreview || "{}"}`,
			].join("\n"),
		);
		if (!confirmed) throw new Error("Workflow execution not approved.");
		sessionApprovals.add(approvalKey(source, input, ctx.cwd));
		return source;
	}

	async function startNamed(
		name: string,
		input: Record<string, unknown>,
		background: boolean,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		onUpdate?: (snapshot: WorkflowRunSnapshot) => void,
	): Promise<{ started: ReturnType<WorkflowManager["start"]>; result?: WorkflowRunResult }> {
		const current = requireRuntime(ctx);
		let source = current.store.resolve(name);
		if (source.scope === "project" && !ctx.isProjectTrusted()) {
			throw new Error(`Project workflow '${name}' is unavailable because this project is not trusted.`);
		}
		source = await reviewAndApprove(source, input, ctx);
		const writerLease = source.manifest.permissions.includes("write")
			? options.writerCoordinator?.acquire(ctx.cwd, `dynamic:${source.name}`)
			: undefined;
		let started: ReturnType<WorkflowManager["start"]>;
		try {
			started = current.manager.start(source, {
				input,
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId() ?? "ephemeral",
				model: modelId(ctx),
				background,
				signal,
				onUpdate,
			});
		} catch (error) {
			options.writerCoordinator?.release(writerLease?.token);
			throw error;
		}
		if (writerLease) {
			options.writerCoordinator?.attachRun(writerLease.token, started.id);
			void started.done.finally(() => options.writerCoordinator?.release(writerLease.token));
		}
		pi.appendEntry("pi-dynamic-workflows:run", {
			runId: started.id,
			name: source.name,
			sourceHash: source.hash,
			statusPath: `${started.snapshot.runDir}/status.json`,
		});
		if (background) return { started };
		return { started, result: await started.done };
	}

	pi.registerMessageRenderer<{ run?: WorkflowRunSnapshot }>(MESSAGE_TYPE, (message, _options, theme) => {
		const run = message.details?.run;
		const content = typeof message.content === "string" ? message.content : "Dynamic workflow finished.";
		const color = run?.state === "completed" ? "success" : run?.state === "stopped" ? "warning" : "error";
		return new Text(theme.fg(color, content), 0, 0);
	});

	pi.registerTool({
		name: "workflow_create",
		label: "Workflow Create",
		description: "Compile and stage a restricted JavaScript dynamic workflow. This validates only; it never executes or approves the workflow. Source must be one workflow({...}) builder expression with bounded phase/run/parallel/forEach/when/repeat/set operations.",
		promptSnippet: "Compile and stage a bounded JavaScript orchestration workflow",
		promptGuidelines: [
			"Use workflow_create before workflow_run when a task needs deterministic multi-phase fanout, bounded loops/branches, or per-item verification.",
			"Dynamic workflow source is a restricted builder DSL, not arbitrary JavaScript: do not use imports, variables, callbacks, native loops, eval, filesystem, network, or process APIs.",
			"Default dynamic workflows to size small and permissions ['read']; request 'write' only for one explicit single-writer implementation node. Parallel writers are disabled.",
		],
		executionMode: "sequential",
		parameters: CreateParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Workflow creation cancelled.");
			const current = requireRuntime(ctx);
			const normalized = params.source.endsWith("\n") ? params.source : `${params.source}\n`;
			const compiled = compileWorkflowSource(normalized, current.config.defaultSize);
			const source = current.store.stage(params.name, normalized, compiled.manifest);
			const policy = resolveWorkflowPolicy(compiled.manifest, current.config);
			return {
				content: [{
					type: "text",
					text: [
						`Workflow '${source.name}' compiled and staged; not executed.`,
						`Phases: ${compiled.manifest.phases.join(" → ")}`,
						`Permissions: ${compiled.manifest.permissions.join(", ")} · size: ${compiled.manifest.size}`,
						`Static nodes: ${compiled.staticNodeCount} · agent cap: ${policy.maxAgents} · concurrency: ${policy.maxConcurrency}`,
						`SHA-256: ${source.hash}`,
						`Draft: ${source.path}`,
						"Next: call workflow_run. Pi will show the exact source and run manifest for human approval.",
					].join("\n"),
				}],
				details: { source, compiled },
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("workflow create "))}${theme.fg("accent", args.name)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((part) => part.type === "text");
			return new Text(theme.fg("success", text?.type === "text" ? text.text : "Workflow staged."), 0, 0);
		},
	});

	pi.registerTool({
		name: "workflow_run",
		label: "Workflow Run",
		description: "Review, approve, and run a staged or saved dynamic workflow. Untrusted source is shown verbatim in an editor, then Pi confirms exact hash, input, permissions, phases, cwd, agent cap, concurrency, and timeout. Intermediate agent results stay in workflow variables/artifacts; only the selected final result is returned.",
		promptSnippet: "Run a staged or saved workflow after human approval",
		promptGuidelines: [
			"Never claim a workflow ran until workflow_run returns a run id and terminal result (or a background start).",
			"Use background=false when the current request must return the workflow result in this turn; use background=true only when the user wants asynchronous monitoring through workflow_control.",
		],
		executionMode: "sequential",
		parameters: RunParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			const input = params.input ?? {};
			const background = params.background ?? false;
			const { started, result } = await startNamed(
				params.name,
				input,
				background,
				ctx,
				signal,
				(snapshot) => onUpdate?.({
					content: [{ type: "text", text: formatSnapshot(snapshot) }],
					details: { run: snapshot },
				}),
			);
			if (background) {
				return {
					content: [{ type: "text", text: `Workflow '${params.name}' started in background: ${started.id}\nArtifacts: ${started.snapshot.runDir}` }],
					details: { run: started.snapshot },
				};
			}
			return {
				content: [{ type: "text", text: [
					`Workflow '${params.name}' ${result!.run.state}.`,
					result!.summary,
					`Artifacts: ${result!.run.runDir}`,
				].join("\n\n") }],
				details: { run: result!.run, value: result!.value },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("workflow run "))}${theme.fg("accent", args.name)}${args.background ? theme.fg("warning", " [background]") : ""}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const run = (result.details as { run?: WorkflowRunSnapshot } | undefined)?.run;
			const text = result.content.find((part) => part.type === "text");
			const color = run?.state === "failed" ? "error" : run?.state === "stopped" ? "warning" : "success";
			return new Text(theme.fg(color, text?.type === "text" ? text.text : "Workflow updated."), 0, 0);
		},
	});

	pi.registerTool({
		name: "workflow_control",
		label: "Workflow Control",
		description: "List, inspect, cooperatively pause/resume, stop, save, or delete dynamic workflows. Pause stops scheduling new nodes and lets active agents drain. Save/delete require human confirmation; project workflows require a trusted project.",
		promptSnippet: "Inspect or control dynamic workflow runs and saved definitions",
		executionMode: "sequential",
		parameters: ControlParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const current = requireRuntime(ctx);
			switch (params.action) {
				case "list": {
					const workflows = current.store.list();
					const runs = current.manager.list();
					return {
						content: [{ type: "text", text: [
							"Workflows:",
							...(workflows.length ? workflows.map((source) => `- ${formatWorkflow(source)}`) : ["- (none)"]),
							"",
							"Runs:",
							...(runs.length ? runs.map((run) => `- ${run.id} · ${run.name} [${run.state}]`) : ["- (none this session)"]),
						].join("\n") }],
						details: { workflows, runs },
					};
				}
				case "status": {
					const run = current.manager.get(params.id);
					if (!run) throw new Error(params.id ? `Workflow run '${params.id}' not found.` : "No active workflow run.");
					return { content: [{ type: "text", text: formatSnapshot(run) }], details: { run } };
				}
				case "pause": {
					const run = current.manager.pause(params.id);
					return { content: [{ type: "text", text: `Pause requested. Active agents will drain.\n${formatSnapshot(run)}` }], details: { run } };
				}
				case "resume": {
					const run = current.manager.resume(params.id);
					return { content: [{ type: "text", text: formatSnapshot(run) }], details: { run } };
				}
				case "stop": {
					const run = current.manager.stop(params.id);
					return { content: [{ type: "text", text: `Stop requested. Side effects are not rolled back.\n${formatSnapshot(run)}` }], details: { run } };
				}
				case "save": {
					if (!params.name) throw new Error("workflow_control save requires name.");
					const scope = params.scope ?? "user";
					if (scope === "project" && !ctx.isProjectTrusted()) throw new Error("Cannot save a project workflow in an untrusted project.");
					if (!ctx.hasUI) throw new Error("Saving a workflow requires interactive confirmation.");
					const draft = current.store.resolve(params.name);
					if (draft.scope !== "draft") throw new Error(`'${params.name}' resolves to ${draft.scope}; only a session draft can be saved.`);
					const reviewedText = await ctx.ui.editor(`Review source before saving '${params.name}'`, draft.source);
					if (reviewedText === undefined) throw new Error("Workflow save cancelled during source review.");
					const reviewedSource = reviewedText.endsWith("\n") ? reviewedText : `${reviewedText}\n`;
					const reviewedCompiled = compileWorkflowSource(reviewedSource, current.config.defaultSize);
					if (reviewedCompiled.manifest.name !== params.name) throw new Error(`Reviewed source defines '${reviewedCompiled.manifest.name}', not '${params.name}'.`);
					const reviewedDraft = current.store.stage(params.name, reviewedSource, reviewedCompiled.manifest);
					const confirmed = await ctx.ui.confirm(
						`Save and trust workflow '${params.name}'?`,
						`Scope: ${scope}\nSHA-256: ${reviewedDraft.hash}\nThe saved definition remains reusable through the Workbench dynamic route. Trust is bound to these exact reviewed source bytes.`,
					);
					if (!confirmed) throw new Error("Workflow save cancelled.");
					const saved = current.store.saveDraft(params.name, scope, params.overwrite ?? false);
					current.store.trust(saved);
					return { content: [{ type: "text", text: `Saved and trusted ${scope} workflow '${saved.name}'. Run it through /workbench dynamic or workflow_run.\n${saved.path}` }], details: { source: saved } };
				}
				case "delete": {
					if (!params.name || !params.scope) throw new Error("workflow_control delete requires name and scope.");
					if (params.scope === "project" && !ctx.isProjectTrusted()) throw new Error("Cannot delete a project workflow in an untrusted project.");
					if (!ctx.hasUI) throw new Error("Deleting a workflow requires interactive confirmation.");
					const confirmed = await ctx.ui.confirm(`Delete ${params.scope} workflow '${params.name}'?`, "This removes the saved definition, not prior run artifacts.");
					if (!confirmed) throw new Error("Workflow delete cancelled.");
					const removed = current.store.deleteSaved(params.name, params.scope);
					return { content: [{ type: "text", text: removed ? `Deleted ${params.scope} workflow '${params.name}'.` : `No ${params.scope} workflow '${params.name}' existed.` }], details: { removed } };
				}
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("workflow "))}${theme.fg("accent", args.action)}`, 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await initialize(ctx);
	});

	pi.on("session_shutdown", async () => {
		const ending = runtime;
		runtime = undefined;
		try {
			ending?.ctx.ui.setStatus(WIDGET_KEY, undefined);
			ending?.ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Ignore stale UI contexts.
		}
		try {
			await ending?.manager.shutdown();
		} finally {
			ending?.pinnedAgents.dispose();
			sessionApprovals.clear();
		}
	});
}
