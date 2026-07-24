import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkbenchConfig } from "./core/config.ts";
import { isChildSession } from "./core/env.ts";
import { beginGuardedSpawn } from "./core/guarded-spawn.ts";
import { textResult } from "./core/result.ts";
import {
	isShipyardMode,
	routeCategory,
	resolveOneOffRoute,
	SHIPYARD_WORKFLOW_NAMES,
	WORKBENCH_MODES,
	type WorkbenchMode,
} from "./core/routing.ts";
import type { SubagentRpcClient } from "./core/subagent-rpc.ts";
import type { WriterCoordinator } from "./core/writer-coordinator.ts";
import type { ShipyardService } from "./shipyard/index.ts";

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

const ONE_OFF_MODES = WORKBENCH_MODES.filter((mode) => routeCategory(mode) === "one-off");
const ROUTE_LIST = WORKBENCH_MODES.filter((mode) => mode !== "status").join(", ");

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
		`Routes: ${ROUTE_LIST}.`,
	].join("\n");
}

export default function registerRouter(pi: ExtensionAPI, options: RegisterRouterOptions): void {
	if (isChildSession()) return;
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
				context: mode === "implement" ? "fork" : "fresh",
				async: true,
				clarify: false,
				artifacts: true,
				...(model ? { model } : {}),
			},
			signal,
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
		agent?: string,
		model?: string,
		signal?: AbortSignal,
	) {
		const category = routeCategory(mode);
		if (category === "status") return { message: statusText(options), mode, nextAction: null };
		const target = task?.trim();
		if (!target) throw new Error(`Workbench mode '${mode}' requires a task.`);
		if (category === "one-off") return { mode, ...(await spawnOneOff(ctx, mode, target, agent, model, signal)), nextAction: null };
		if (category === "shipyard") {
			if (!options.shipyard || !options.config.modules.shipyard) throw new Error("Shipyard is disabled in Pi Workbench config.");
			if (!isShipyardMode(mode)) throw new Error(`Workbench mode '${mode}' is not a Shipyard workflow.`);
			const launched = await options.shipyard.workflows.spawn(ctx, mode, target, signal);
			return { mode, ...launched, nextAction: null };
		}
		if (category === "team") {
			if (!options.config.modules.agentTeams) throw new Error("Agent Teams is disabled in Pi Workbench config.");
			return {
				mode,
				message: "Team route selected. Call team_create with this goal, define 2-5 separable tasks, then use team_spawn. Default to read-only scouts; Workbench permits only one writer per cwd.",
				nextAction: { tool: "team_create", args: { goal: target } },
			};
		}
		if (category === "dynamic") {
			if (!options.config.modules.dynamicWorkflows) {
				throw new Error("Dynamic Workflows is experimental and disabled. Enable modules.dynamicWorkflows in ~/.pi/agent/extensions/pi-workbench/config.json, then /reload.");
			}
			return {
				mode,
				message: "Dynamic route selected. Use workflow_control for lifecycle or saved-definition requests; otherwise author a bounded read-only workflow with workflow_create, then call workflow_run for exact-source human approval.",
				nextAction: { tools: ["workflow_control", "workflow_create", "workflow_run"], task: target },
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
		`/workbench <${ONE_OFF_MODES.join("|")}> <task>`,
		`/workbench <${SHIPYARD_WORKFLOW_NAMES.join("|")}> <task>`,
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
					: `Use Workbench Dynamic mode for this request. If it concerns an existing run or saved definition, use workflow_control. Otherwise create a bounded read-only workflow with workflow_create, then call workflow_run for exact-source approval. Request:\n\n${target}`;
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
