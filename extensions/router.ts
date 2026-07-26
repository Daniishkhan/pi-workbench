import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { EngineeringConfig } from "./core/config.ts";
import { isChildSession } from "./core/env.ts";
import { beginGuardedSpawn } from "./core/guarded-spawn.ts";
import { textResult } from "./core/result.ts";
import {
	DEFAULT_ENGINEERING_EFFORT,
	isOneOffAction,
	isWorkflowAction,
	resolveOneOffAssignment,
	ENGINEERING_EFFORTS,
	ENGINEERING_ACTIONS,
	type OneOffAction,
	type EngineeringEffort,
	type EngineeringAction,
} from "./core/routing.ts";
import type { SubagentRpcClient } from "./core/subagent-rpc.ts";
import type { WriterCoordinator } from "./core/writer-coordinator.ts";
import type { WorkflowService } from "./workflows.ts";

const MAX_TASK_LENGTH = 32_768;
const Params = Type.Object({
	action: StringEnum(ENGINEERING_ACTIONS),
	task: Type.Optional(Type.String({ maxLength: MAX_TASK_LENGTH, description: "Task or target. Required except for status." })),
	model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Optional model override for one-off actions." })),
}, { additionalProperties: false });

export interface RegisterRouterOptions {
	config: EngineeringConfig;
	workflows?: WorkflowService;
	writerCoordinator: WriterCoordinator;
	rpc: SubagentRpcClient;
}

const ACTION_LIST = ENGINEERING_ACTIONS.filter((action) => action !== "status").join(", ");

function engineeringStatusText(options: RegisterRouterOptions): string {
	const leases = options.writerCoordinator.list();
	return [
		"Pi Engineering",
		`- Workflow service: ${options.workflows ? "available" : "unavailable"}`,
		`- Write lock: ${options.config.writeLock.enabled ? "enabled" : "disabled"}`,
		`- Active write locks: ${leases.length}`,
		...leases.map((lease) => `  - ${lease.cwd}: ${lease.owner}${lease.runId ? ` (${lease.runId})` : ""}${lease.uncertain ? " [uncertain]" : ""}`),
		"",
		`Actions: ${ACTION_LIST}.`,
	].join("\n");
}

async function statusText(options: RegisterRouterOptions, runId?: string, signal?: AbortSignal): Promise<string> {
	const engineering = engineeringStatusText(options);
	if (!runId) return engineering;
	const reply = await options.rpc.request("status", { runId }, signal);
	if (!reply.success) throw new Error(reply.error?.message || `Unable to inspect engineering run '${runId}'.`);
	const run = reply.data?.text?.trim() || `Run '${runId}' returned no status text.`;
	return `${run}\n\n${engineering}`;
}

export interface ParsedEngineeringCommand {
	action: EngineeringAction;
	task: string;
	effort: EngineeringEffort;
}

export function parseEngineeringCommand(args: string): ParsedEngineeringCommand {
	const parts = args.trim() ? args.trim().split(/\s+/) : [];
	let effort: EngineeringEffort = DEFAULT_ENGINEERING_EFFORT;
	let effortSeen = false;
	const consumeEffort = (index: number): void => {
		const token = parts[index];
		if (!token?.startsWith("--")) return;
		const candidate = token.slice(2);
		if (!(ENGINEERING_EFFORTS as readonly string[]).includes(candidate)) {
			throw new Error(`Unknown engineering option '${token}'. Expected --quick, --standard, or --deep.`);
		}
		if (effortSeen) throw new Error("Choose only one engineering effort option.");
		effort = candidate as EngineeringEffort;
		effortSeen = true;
		parts.splice(index, 1);
	};

	consumeEffort(0);
	const rawAction = parts.shift() ?? "status";
	consumeEffort(0);
	if (!(ENGINEERING_ACTIONS as readonly string[]).includes(rawAction)) {
		throw new Error(`Unknown engineering action '${rawAction}'.`);
	}
	const action = rawAction as EngineeringAction;
	if (action === "status" && effortSeen) throw new Error("Engineering effort applies only to actions, not status.");
	return { action, task: parts.join(" "), effort };
}

export default function registerRouter(pi: ExtensionAPI, options: RegisterRouterOptions): void {
	if (isChildSession()) return;
	const rpc = options.rpc;
	function normalizeModel(model: string | undefined): string | undefined {
		if (model === undefined) return undefined;
		const value = model.trim();
		if (!value) throw new Error("Engineering model override must not be blank.");
		if (value.length > 256) throw new Error("Engineering model override must be at most 256 characters.");
		return value;
	}

	async function spawnOneOff(
		ctx: ExtensionContext,
		action: OneOffAction,
		task: string,
		effort: EngineeringEffort,
		model?: string,
		signal?: AbortSignal,
	) {
		const assignment = resolveOneOffAssignment(action, effort);
		const guard = await beginGuardedSpawn({
			rpc,
			writerCoordinator: options.writerCoordinator,
			cwd: ctx.cwd,
			owner: `engineering:${action}:${assignment.agent}`,
			writeCapable: assignment.capability === "writer",
			label: "Engineering assignment",
			signal,
		});
		const { reply, runId } = await guard.spawn({
			params: {
				agent: assignment.agent,
				task,
				cwd: ctx.cwd,
				async: true,
				clarify: false,
				artifacts: false,
				maxRuntimeMs: assignment.limits.timeoutMs,
				...(assignment.limits.turnBudget ? { turnBudget: assignment.limits.turnBudget } : {}),
				...(model ? { model } : {}),
			},
			signal,
			requireRunIdMessage: `Engineering ${action} was accepted without a run id; inspect active specialists before retrying.`,
		});
		return {
			message: `${reply.data?.text?.trim() || `Assigned the ${action} specialist.`}\nEffort: ${effort}${runId ? `\nRun: ${runId}` : ""}`,
			agent: assignment.agent,
			effort,
			runId: runId ?? null,
			rpc: reply.data ?? null,
		};
	}

	async function dispatch(
		ctx: ExtensionContext,
		action: EngineeringAction,
		task?: string,
		model?: string,
		signal?: AbortSignal,
		effort: EngineeringEffort = DEFAULT_ENGINEERING_EFFORT,
	) {
		const selectedModel = normalizeModel(model);
		if (action === "status") {
			if (selectedModel) throw new Error("Engineering model override is only supported for one-off actions: inspect, plan, implement, review.");
			const runId = task?.trim() || undefined;
			if (runId && (runId.length > 512 || /\s/.test(runId))) {
				throw new Error("Engineering status accepts one run id of at most 512 characters.");
			}
			return { message: await statusText(options, runId, signal), action, runId: runId ?? null, nextAction: null };
		}
		const target = task?.trim();
		if (!target) throw new Error(`Engineering action '${action}' requires a task.`);
		if (target.length > MAX_TASK_LENGTH) throw new Error(`Engineering task must be at most ${MAX_TASK_LENGTH} characters.`);
		if (isOneOffAction(action)) {
			return { action, ...(await spawnOneOff(ctx, action, target, effort, selectedModel, signal)), nextAction: null };
		}
		if (!isWorkflowAction(action)) throw new Error(`Unsupported engineering action: ${action}`);
		if (selectedModel) throw new Error("Engineering model override is only supported for one-off actions: inspect, plan, implement, review.");
		if (!options.workflows) throw new Error("Engineering workflows are unavailable.");
		const launched = await options.workflows.spawn(ctx, action, target, effort, signal);
		return { action, effort, ...launched, message: `${launched.message}\nEffort: ${effort}`, nextAction: null };
	}

	pi.registerTool({
		name: "assign_engineering",
		label: "Pi Engineering",
		description: "Assign bounded software work to inspect, plan, implement, review, deliver, or audit. Specialist roles and runtime limits are fixed by action.",
		promptSnippet: "Assign bounded software work to the smallest capable specialist",
		promptGuidelines: [
			"Use the smallest action that can complete the task; reserve deliver and audit for their explicit workflows.",
			"Do not delegate again from an engineering specialist.",
		],
		parameters: Params,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await dispatch(ctx, params.action as EngineeringAction, params.task, params.model, signal);
			return textResult(result.message, result);
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("engineering "))}${theme.fg("accent", args.action)}${args.task ? theme.fg("dim", ` ${args.task.length > 60 ? `${args.task.slice(0, 60)}…` : args.task}`) : ""}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((part) => part.type === "text");
			return new Text(theme.fg("success", text?.type === "text" ? text.text : "Engineering action assigned."), 0, 0);
		},
	});

	const HELP = [
		"/engineering [status]",
		"/engineering status <run-id>",
		"/engineering [--quick|--standard|--deep] <inspect|plan|implement|review|deliver|audit> <task>",
		"/engineering unlock  (manual recovery after checking the active run)",
		"deliver plans, implements, and reviews one bounded change; it never commits, publishes, or deploys",
	].join("\n");

	async function command(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const [rawAction = "status"] = args.trim().split(/\s+/);
		if (rawAction === "help") return ctx.ui.notify(HELP, "info");
		if (rawAction === "unlock" || rawAction === "release-writer") {
			const lease = options.writerCoordinator.get(ctx.cwd);
			if (!lease) return ctx.ui.notify("No engineering write lock for this worktree.", "info");
			if (!ctx.hasUI) throw new Error("Manual write-lock release requires interactive confirmation.");
			const ok = await ctx.ui.confirm("Release engineering write lock?", `${lease.owner}${lease.runId ? `\nRun: ${lease.runId}` : ""}${lease.uncertain ? "\nLaunch state: uncertain" : ""}\n\nOnly release after confirming no implementer is still active.`);
			if (ok) options.writerCoordinator.releaseCwd(lease.cwd);
			ctx.ui.notify(ok ? "Write lock released." : "Write lock kept.", ok ? "warning" : "info");
			return;
		}
		try {
			const parsed = parseEngineeringCommand(args);
			const result = await dispatch(ctx, parsed.action, parsed.task, undefined, undefined, parsed.effort);
			ctx.ui.notify(result.message, "info");
		} catch (error) {
			ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`, "error");
		}
	}

	pi.registerCommand("engineering", { description: "Assign bounded engineering work and inspect status", handler: command });
	pi.registerCommand("eng", { description: "Alias for /engineering", handler: command });
	pi.registerCommand("workbench", { description: "Deprecated alias for /engineering", handler: command });
	pi.registerCommand("work", { description: "Deprecated alias for /engineering", handler: command });
}
