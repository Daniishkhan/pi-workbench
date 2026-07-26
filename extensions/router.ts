import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { WorkbenchConfig } from "./core/config.ts";
import { isChildSession } from "./core/env.ts";
import { beginGuardedSpawn } from "./core/guarded-spawn.ts";
import { textResult } from "./core/result.ts";
import {
	isOneOffMode,
	isWorkflowMode,
	limitsForMode,
	resolveOneOffRoute,
	WORKBENCH_MODES,
	type OneOffMode,
	type WorkbenchMode,
} from "./core/routing.ts";
import type { SubagentRpcClient } from "./core/subagent-rpc.ts";
import type { WriterCoordinator } from "./core/writer-coordinator.ts";
import type { WorkflowService } from "./workflows.ts";

const MAX_TASK_LENGTH = 32_768;
const Params = Type.Object({
	mode: StringEnum(WORKBENCH_MODES),
	task: Type.Optional(Type.String({ maxLength: MAX_TASK_LENGTH, description: "Task or target. Required except for status." })),
	model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Optional model override for one-off modes." })),
}, { additionalProperties: false });

export interface RegisterRouterOptions {
	config: WorkbenchConfig;
	workflows?: WorkflowService;
	writerCoordinator: WriterCoordinator;
	rpc: SubagentRpcClient;
}

const ROUTE_LIST = WORKBENCH_MODES.filter((mode) => mode !== "status").join(", ");

function statusText(options: RegisterRouterOptions): string {
	const leases = options.writerCoordinator.list();
	return [
		"Pi Workbench",
		`- Workflow service: ${options.workflows ? "available" : "unavailable"}`,
		`- Writer guard: ${options.config.writerGuard.enabled ? "enabled" : "disabled"}`,
		`- Active writer leases: ${leases.length}`,
		...leases.map((lease) => `  - ${lease.cwd}: ${lease.owner}${lease.runId ? ` (${lease.runId})` : ""}${lease.uncertain ? " [uncertain]" : ""}`),
		"",
		`Routes: ${ROUTE_LIST}.`,
	].join("\n");
}

export default function registerRouter(pi: ExtensionAPI, options: RegisterRouterOptions): void {
	if (isChildSession()) return;
	const rpc = options.rpc;
	function normalizeModel(model: string | undefined): string | undefined {
		if (model === undefined) return undefined;
		const value = model.trim();
		if (!value) throw new Error("Workbench model override must not be blank.");
		if (value.length > 256) throw new Error("Workbench model override must be at most 256 characters.");
		return value;
	}

	async function spawnOneOff(
		ctx: ExtensionContext,
		mode: OneOffMode,
		task: string,
		model?: string,
		signal?: AbortSignal,
	) {
		const route = resolveOneOffRoute(mode);
		const guard = await beginGuardedSpawn({
			rpc,
			writerCoordinator: options.writerCoordinator,
			cwd: ctx.cwd,
			owner: `workbench:${mode}:${route.agent}`,
			writeCapable: route.capability === "writer",
			label: "Workbench launch",
			signal,
		});
		const { reply, runId } = await guard.spawn({
			params: {
				agent: route.agent,
				task,
				cwd: ctx.cwd,
				async: true,
				clarify: false,
				artifacts: false,
				maxRuntimeMs: route.limits.timeoutMs,
				...(route.limits.turnBudget ? { turnBudget: route.limits.turnBudget } : {}),
				...(model ? { model } : {}),
			},
			signal,
			requireRunIdMessage: `Workbench ${mode} was accepted without a run id; inspect active subagents before retrying.`,
		});
		return {
			message: `${reply.data?.text?.trim() || `Launched ${route.agent}.`}${runId ? `\nRun: ${runId}` : ""}`,
			agent: route.agent,
			runId: runId ?? null,
			rpc: reply.data ?? null,
		};
	}

	async function dispatch(
		ctx: ExtensionContext,
		mode: WorkbenchMode,
		task?: string,
		model?: string,
		signal?: AbortSignal,
	) {
		const selectedModel = normalizeModel(model);
		if (mode === "status") {
			if (selectedModel) throw new Error("Workbench model override is only supported for one-off modes: inspect, plan, implement, review.");
			return { message: statusText(options), mode, nextAction: null };
		}
		const target = task?.trim();
		if (!target) throw new Error(`Workbench mode '${mode}' requires a task.`);
		if (target.length > MAX_TASK_LENGTH) throw new Error(`Workbench task must be at most ${MAX_TASK_LENGTH} characters.`);
		if (isOneOffMode(mode)) {
			return { mode, ...(await spawnOneOff(ctx, mode, target, selectedModel, signal)), nextAction: null };
		}
		if (!isWorkflowMode(mode)) throw new Error(`Unsupported Workbench mode: ${mode}`);
		if (selectedModel) throw new Error("Workbench model override is only supported for one-off modes: inspect, plan, implement, review.");
		if (!options.workflows) throw new Error("Workbench workflows are unavailable.");
		const limits = limitsForMode(mode);
		const launched = await options.workflows.spawn(ctx, mode, target, { timeoutMs: limits.timeoutMs }, signal);
		return { mode, ...launched, nextAction: null };
	}

	pi.registerTool({
		name: "workbench_route",
		label: "Pi Workbench",
		description: "Route bounded software work to inspect, plan, implement, review, deliver, or audit. Roles and runtime limits are fixed by mode.",
		promptSnippet: "Route bounded software work through one small policy layer",
		promptGuidelines: [
			"Use the smallest route that can complete the task; reserve deliver and audit for their explicit end-to-end workflows.",
			"Do not delegate again from a Workbench child.",
		],
		parameters: Params,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await dispatch(ctx, params.mode as WorkbenchMode, params.task, params.model, signal);
			return textResult(result.message, result);
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("workbench "))}${theme.fg("accent", args.mode)}${args.task ? theme.fg("dim", ` ${args.task.length > 60 ? `${args.task.slice(0, 60)}…` : args.task}`) : ""}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((part) => part.type === "text");
			return new Text(theme.fg("success", text?.type === "text" ? text.text : "Route dispatched."), 0, 0);
		},
	});

	const HELP = [
		"/workbench [status]",
		"/workbench <inspect|plan|implement|review|deliver|audit> <task>",
		"/workbench release-writer  (manual recovery after checking the active run)",
	].join("\n");

	async function command(args: string, ctx: ExtensionContext): Promise<void> {
		const [rawMode = "status", ...rest] = args.trim().split(/\s+/);
		if (rawMode === "help") return ctx.ui.notify(HELP, "info");
		if (rawMode === "release-writer") {
			const lease = options.writerCoordinator.get(ctx.cwd);
			if (!lease) return ctx.ui.notify("No Workbench writer lease for this cwd.", "info");
			if (!ctx.hasUI) throw new Error("Manual writer release requires interactive confirmation.");
			const ok = await ctx.ui.confirm("Release Workbench writer lease?", `${lease.owner}${lease.runId ? `\nRun: ${lease.runId}` : ""}${lease.uncertain ? "\nLaunch state: uncertain" : ""}\n\nOnly release after confirming no writer is still active.`);
			if (ok) options.writerCoordinator.releaseCwd(lease.cwd);
			ctx.ui.notify(ok ? "Writer lease released." : "Writer lease kept.", ok ? "warning" : "info");
			return;
		}
		if (!(WORKBENCH_MODES as readonly string[]).includes(rawMode)) {
			ctx.ui.notify(`Unknown Workbench mode '${rawMode}'.\n\n${HELP}`, "error");
			return;
		}
		const mode = rawMode as WorkbenchMode;
		try {
			const result = await dispatch(ctx, mode, rest.join(" "));
			ctx.ui.notify(result.message, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	pi.registerCommand("workbench", { description: "Bounded software-work router and status", handler: command });
	pi.registerCommand("work", { description: "Alias for /workbench", handler: command });
}
