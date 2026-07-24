import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkbenchConfig } from "./core/config.ts";
import { ONE_OFF_AGENTS, resolveOneOffRoute, SHIPYARD_MODES, WORKBENCH_MODES, type WorkbenchMode } from "./core/routing.ts";
import { runIdFromSpawnReply, type SubagentRpcClient } from "./core/subagent-rpc.ts";
import type { WriterCoordinator } from "./core/writer-coordinator.ts";
import type { ShipyardService } from "./shipyard/index.ts";
import type { WorkflowName } from "./shipyard/workflow-names.ts";

const CHILD_ENV = "PI_SUBAGENT_CHILD";

const Params = Type.Object({
	mode: StringEnum(WORKBENCH_MODES),
	task: Type.Optional(Type.String({ maxLength: 32_768, description: "Task or target. Required except for status." })),
	agent: Type.Optional(Type.String({ description: "Optional agent override for one-off modes." })),
	model: Type.Optional(Type.String({ description: "Optional model override for one-off modes." })),
}, { additionalProperties: false });

export interface RegisterRouterOptions {
	config: WorkbenchConfig;
	shipyard?: ShipyardService;
	writerCoordinator: WriterCoordinator;
	rpc: SubagentRpcClient;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function workflowName(mode: WorkbenchMode): WorkflowName {
	if (mode === "explore" || mode === "debug" || mode === "fast" || mode === "review" || mode === "security" || mode === "ui" || mode === "compact" || mode === "deliver" || mode === "ship") return mode;
	throw new Error(`Workbench mode '${mode}' is not a Shipyard workflow.`);
}

function statusText(options: RegisterRouterOptions): string {
	const leases = options.writerCoordinator.list();
	return [
		"Pi Workbench",
		`- Shipyard: ${options.config.modules.shipyard ? "enabled" : "disabled"}`,
		`- Agent Teams: ${options.config.modules.agentTeams ? "enabled" : "disabled"}`,
		`- Dynamic Workflows: ${options.config.modules.dynamicWorkflows ? "enabled (experimental)" : "disabled (default)"}`,
		`- Writer guard: ${options.config.writerGuard.enabled ? "enabled" : "disabled"}`,
		`- Active writer leases: ${leases.length}`,
		...leases.map((lease) => `  - ${lease.cwd}: ${lease.owner}${lease.runId ? ` (${lease.runId})` : ""}${lease.uncertain ? " [uncertain]" : ""}`),
		"",
		"Routes: quick, deep, plan, implement, review-oneoff, explore, debug, fast, review, security, ui, compact, deliver, ship, team, dynamic.",
	].join("\n");
}

export default function registerRouter(pi: ExtensionAPI, options: RegisterRouterOptions): void {
	if (process.env[CHILD_ENV] === "1") return;
	const rpc = options.rpc;

	async function spawnOneOff(
		ctx: ExtensionContext,
		mode: WorkbenchMode,
		task: string,
		agentOverride?: string,
		model?: string,
		signal?: AbortSignal,
	) {
		const route = resolveOneOffRoute(mode, agentOverride);
		const agent = route.agent;
		const writerLease = route.capability === "writer"
			? options.writerCoordinator.acquire(ctx.cwd, `workbench:${mode}:${agent}`)
			: undefined;
		const ping = await rpc.request("ping", {}, signal).catch((error) => {
			options.writerCoordinator.release(writerLease?.token);
			throw error;
		});
		if (!ping.success) {
			options.writerCoordinator.release(writerLease?.token);
			throw new Error(`pi-subagents RPC unavailable: ${ping.error?.message ?? "ping failed"}.`);
		}
		const reply = await rpc.request("spawn", {
			agent,
			task,
			cwd: ctx.cwd,
			context: mode === "implement" ? "fork" : "fresh",
			async: true,
			clarify: false,
			artifacts: true,
			...(model ? { model } : {}),
		}, signal).catch((error) => {
			options.writerCoordinator.markUncertain(writerLease?.token);
			throw error;
		});
		if (!reply.success) {
			options.writerCoordinator.release(writerLease?.token);
			throw new Error(`Workbench launch failed: ${reply.error?.message ?? "unknown RPC error"}`);
		}
		const runId = runIdFromSpawnReply(reply);
		if (writerLease) {
			if (runId) options.writerCoordinator.attachRun(writerLease.token, runId);
			else options.writerCoordinator.markUncertain(writerLease.token);
		}
		return {
			message: `${reply.data?.text?.trim() || `Launched ${agent}.`}${runId ? `\nRun: ${runId}` : ""}`,
			agent,
			runId: runId ?? null,
			rpc: reply.data ?? null,
		};
	}

	async function dispatch(
		ctx: ExtensionContext,
		mode: WorkbenchMode,
		task?: string,
		agent?: string,
		model?: string,
		signal?: AbortSignal,
	) {
		if (mode === "status") return { message: statusText(options), mode, nextAction: null };
		const target = task?.trim();
		if (!target) throw new Error(`Workbench mode '${mode}' requires a task.`);
		if (ONE_OFF_AGENTS[mode]) return { mode, ...(await spawnOneOff(ctx, mode, target, agent, model, signal)), nextAction: null };
		if (SHIPYARD_MODES.has(mode)) {
			if (!options.shipyard || !options.config.modules.shipyard) throw new Error("Shipyard is disabled in Pi Workbench config.");
			const launched = await options.shipyard.workflows.spawn(ctx, workflowName(mode), target, signal);
			return { mode, ...launched, nextAction: null };
		}
		if (mode === "team") {
			if (!options.config.modules.agentTeams) throw new Error("Agent Teams is disabled in Pi Workbench config.");
			return {
				mode,
				message: "Team route selected. Call team_create with this goal, define 2-5 separable tasks, then use team_spawn. Default to read-only scouts; Workbench permits only one writer per cwd.",
				nextAction: { tool: "team_create", args: { goal: target } },
			};
		}
		if (mode === "dynamic") {
			if (!options.config.modules.dynamicWorkflows) {
				throw new Error("Dynamic Workflows is experimental and disabled. Enable modules.dynamicWorkflows in ~/.pi/agent/extensions/pi-workbench/config.json, then /reload.");
			}
			return {
				mode,
				message: "Dynamic route selected. Author a bounded read-only workflow with workflow_create, then call workflow_run for exact-source human approval.",
				nextAction: { tool: "workflow_create", task: target },
			};
		}
		throw new Error(`Unsupported Workbench mode: ${mode}`);
	}

	pi.registerTool({
		name: "workbench_route",
		label: "Pi Workbench",
		description: "Route work through the unified Pi Workbench. Use quick/deep/plan/implement/review-oneoff for one-off agents; Shipyard modes for fixed software workflows; team only when peers must coordinate; dynamic only for bounded data-dependent branches or loops. Never nest orchestration modes.",
		promptSnippet: "Route delegation, Shipyard, teams, or bounded workflows through one policy layer",
		promptGuidelines: [
			"Use workbench_route for explicit orchestration selection; prefer quick or a one-off role before expensive multi-agent workflows.",
			"Do not nest Shipyard, Agent Teams, or Dynamic Workflows inside one another.",
		],
		parameters: Params,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await dispatch(ctx, params.mode as WorkbenchMode, params.task, params.agent, params.model, signal);
			return textResult(result.message, result);
		},
	});

	const HELP = [
		"/workbench [status]",
		"/workbench <quick|deep|plan|implement|review-oneoff> <task>",
		"/workbench <explore|debug|fast|review|security|ui|compact|deliver|ship> <task>",
		"/workbench team <goal>",
		"/workbench dynamic <task>  (experimental; disabled by default)",
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
			if (mode === "team" || mode === "dynamic") {
				const target = rest.join(" ").trim();
				if (!target) throw new Error(`Workbench mode '${mode}' requires a task.`);
				const prompt = mode === "team"
					? `Use Agent Teams for this goal. Create one team, partition 2-5 separable tasks, prefer read-only scouts, and allow only one writer in this cwd. Goal:\n\n${target}`
					: `Use Dynamic Workflows for this task. Create a bounded read-only workflow, then call workflow_run for exact-source approval. Task:\n\n${target}`;
				if (ctx.isIdle()) pi.sendUserMessage(prompt);
				else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				return;
			}
			const result = await dispatch(ctx, mode, rest.join(" "));
			ctx.ui.notify(result.message, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	pi.registerCommand("workbench", { description: "Unified Workbench router and status", handler: command });
	pi.registerCommand("work", { description: "Alias for /workbench", handler: command });
}
