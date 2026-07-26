import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerRouter, { parseEngineeringCommand } from "../../extensions/router.ts";
import type { SubagentRpcClient, SubagentRpcReply } from "../../extensions/core/subagent-rpc.ts";
import type { WriterCoordinator } from "../../extensions/core/writer-coordinator.ts";
import type { WorkflowService } from "../../extensions/workflows.ts";
import {
	EFFORT_ACTION_LIMITS,
	limitsForAction,
	ONE_OFF_AGENTS,
	resolveOneOffAssignment,
	ACTION_LIMITS,
	ENGINEERING_EFFORTS,
	ENGINEERING_ACTIONS,
	type EngineeringEffort,
} from "../../extensions/core/routing.ts";

test("exposes only the lean public action surface", () => {
	assert.deepEqual(ENGINEERING_ACTIONS, [
		"status",
		"inspect",
		"plan",
		"implement",
		"review",
		"deliver",
		"audit",
	]);
});

test("maps each one-off action to one fixed packaged role", () => {
	assert.deepEqual(ONE_OFF_AGENTS, {
		inspect: "pi-workbench.fast-scout",
		plan: "pi-workbench.planner",
		implement: "pi-workbench.worker",
		review: "pi-workbench.reviewer",
	});
	assert.equal(resolveOneOffAssignment("inspect").capability, "read-only");
	assert.equal(resolveOneOffAssignment("plan").capability, "read-only");
	assert.equal(resolveOneOffAssignment("implement").capability, "writer");
	assert.equal(resolveOneOffAssignment("review").capability, "read-only");
});

test("keeps mandatory runtime and turn limits in one action table", () => {
	assert.deepEqual(ACTION_LIMITS, {
		inspect: { timeoutMs: 5 * 60_000, turnBudget: { maxTurns: 8, graceTurns: 2 } },
		plan: { timeoutMs: 15 * 60_000, turnBudget: { maxTurns: 18, graceTurns: 2 } },
		implement: { timeoutMs: 45 * 60_000 },
		review: { timeoutMs: 15 * 60_000, turnBudget: { maxTurns: 18, graceTurns: 2 } },
		deliver: { timeoutMs: 45 * 60_000 },
		audit: { timeoutMs: 20 * 60_000 },
	});
	assert.equal("turnBudget" in ACTION_LIMITS.implement, false, "writers must not have a hard turn cap");
});

test("human-selected effort changes ceilings without changing action topology or authority", () => {
	assert.deepEqual(ENGINEERING_EFFORTS, ["quick", "standard", "deep"]);
	assert.deepEqual(EFFORT_ACTION_LIMITS, {
		quick: {
			inspect: { timeoutMs: 3 * 60_000, turnBudget: { maxTurns: 5, graceTurns: 1 } },
			plan: { timeoutMs: 8 * 60_000, turnBudget: { maxTurns: 10, graceTurns: 2 } },
			implement: { timeoutMs: 20 * 60_000 },
			review: { timeoutMs: 8 * 60_000, turnBudget: { maxTurns: 10, graceTurns: 2 } },
			deliver: { timeoutMs: 30 * 60_000 },
			audit: { timeoutMs: 15 * 60_000 },
		},
		standard: ACTION_LIMITS,
		deep: {
			inspect: { timeoutMs: 2 * 60 * 60_000 },
			plan: { timeoutMs: 2 * 60 * 60_000 },
			implement: { timeoutMs: 4 * 60 * 60_000 },
			review: { timeoutMs: 2 * 60 * 60_000 },
			deliver: { timeoutMs: 4 * 60 * 60_000 },
			audit: { timeoutMs: 3 * 60 * 60_000 },
		},
	});
	assert.equal(resolveOneOffAssignment("review", "deep").agent, "pi-workbench.reviewer");
	assert.equal(resolveOneOffAssignment("review", "deep").capability, "read-only");
	assert.equal(resolveOneOffAssignment("review", "deep").limits.timeoutMs, 2 * 60 * 60_000);
	assert.equal("turnBudget" in resolveOneOffAssignment("review", "deep").limits, false);
	assert.equal(limitsForAction("deliver", "deep").timeoutMs, 4 * 60 * 60_000);
	assert.ok(limitsForAction("inspect", "quick").timeoutMs < limitsForAction("inspect", "standard").timeoutMs);
});

test("parses effort only from explicit human command options", () => {
	assert.deepEqual(parseEngineeringCommand("--deep review inspect auth boundaries"), {
		action: "review",
		task: "inspect auth boundaries",
		effort: "deep",
	});
	assert.deepEqual(parseEngineeringCommand("implement --quick fix typo"), {
		action: "implement",
		task: "fix typo",
		effort: "quick",
	});
	assert.deepEqual(parseEngineeringCommand("status run-123"), {
		action: "status",
		task: "run-123",
		effort: "standard",
	});
	assert.throws(() => parseEngineeringCommand("--deep status"), /effort applies only to actions/);
	assert.throws(() => parseEngineeringCommand("--forever review target"), /Unknown engineering option/);
	assert.throws(() => parseEngineeringCommand("--deep review --quick target"), /Choose only one/);
});

interface RegisteredTool {
	name: string;
	parameters: { properties: Record<string, unknown>; required?: string[] };
	execute(
		id: string,
		params: { action: string; task?: string; model?: string },
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ details: Record<string, unknown> }>;
}

interface RegisteredCommand {
	handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
}

function routerHarness(workflows?: WorkflowService, spawnRunId: string | null = "run-1", activeLock?: Record<string, unknown>) {
	let tool: RegisteredTool | undefined;
	const commands = new Map<string, RegisteredCommand>();
	const pi = {
		registerTool(value: RegisteredTool) { tool = value; },
		registerCommand(name: string, value: RegisteredCommand) { commands.set(name, value); },
	} as unknown as ExtensionAPI;
	const rpcCalls: Array<{ method: string; params: Record<string, unknown>; signal?: AbortSignal }> = [];
	const rpc = {
		async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<SubagentRpcReply> {
			rpcCalls.push({ method, params, signal });
			return method === "spawn"
				? {
					version: 1,
					requestId: "spawn",
					success: true,
					data: spawnRunId ? { details: { runId: spawnRunId } } : { text: "accepted" },
				}
				: { version: 1, requestId: method, success: true };
		},
	} as unknown as SubagentRpcClient;
	const uncertain: Array<string | undefined> = [];
	const released: string[] = [];
	const writerCoordinator = {
		list: () => [],
		get: () => activeLock,
		acquire: (cwd: string, owner: string) => ({
			version: 1 as const,
			token: "writer-token",
			cwd,
			owner,
			createdAt: 1,
			pid: 1,
		}),
		markUncertain: (token: string | undefined) => { uncertain.push(token); },
		attachRun: () => undefined,
		release: () => true,
		releaseCwd: (cwd: string) => { released.push(cwd); return true; },
	} as unknown as WriterCoordinator;
	registerRouter(pi, {
		config: { writeLock: { enabled: true } },
		workflows,
		writerCoordinator,
		rpc,
	});
	assert.ok(tool);
	assert.equal(tool.name, "assign_engineering");
	return { tool, commands, rpcCalls, uncertain, released };
}

test("registers one canonical command, a short alias, and temporary compatibility aliases", () => {
	const { commands } = routerHarness();
	assert.deepEqual([...commands.keys()].sort(), ["eng", "engineering", "work", "workbench"]);
	assert.equal(commands.get("engineering")?.handler, commands.get("eng")?.handler);
	assert.equal(commands.get("engineering")?.handler, commands.get("workbench")?.handler);
	assert.equal(commands.get("engineering")?.handler, commands.get("work")?.handler);
});

test("names the model-facing choice action, not mode", () => {
	const { tool } = routerHarness();
	assert.deepEqual(Object.keys(tool!.parameters.properties), ["action", "task", "model"]);
	assert.equal("mode" in tool!.parameters.properties, false);
	assert.deepEqual(tool!.parameters.required, ["action"]);
});

test("unlock and its temporary legacy spelling share the confirmed write-lock recovery", async () => {
	const activeLock = { cwd: "/repo", owner: "engineering:deliver", runId: "run-1", uncertain: false };
	const { commands, released } = routerHarness(undefined, "run-1", activeLock);
	const confirmations: string[] = [];
	const commandCtx = {
		cwd: "/repo",
		hasUI: true,
		ui: {
			notify() {},
			async confirm(title: string) { confirmations.push(title); return true; },
		},
	} as unknown as ExtensionCommandContext;
	await commands.get("engineering")!.handler("unlock", commandCtx);
	await commands.get("engineering")!.handler("release-writer", commandCtx);
	assert.deepEqual(confirmations, ["Release engineering write lock?", "Release engineering write lock?"]);
	assert.deepEqual(released, ["/repo", "/repo"]);
});

const ctx = { cwd: "/repo" } as ExtensionContext;

test("one-off dispatch applies the fixed role policy while normalizing a bounded model override", async () => {
	const { tool, rpcCalls } = routerHarness();
	const signal = new AbortController().signal;
	await tool!.execute("tool", { action: "inspect", task: "trace routing", model: "  provider/small  " }, signal, undefined, ctx);
	assert.deepEqual(rpcCalls.map((call) => call.method), ["ping", "spawn"]);
	assert.deepEqual(rpcCalls[1]?.params, {
		agent: "pi-workbench.fast-scout",
		task: "trace routing",
		cwd: "/repo",
		async: true,
		clarify: false,
		artifacts: false,
		maxRuntimeMs: 5 * 60_000,
		turnBudget: { maxTurns: 8, graceTurns: 2 },
		model: "provider/small",
	});
	assert.equal(rpcCalls[1]?.signal, undefined, "guarded spawn owns abort-after-emission handling");
});

test("status can inspect one retained run without launching work", async () => {
	const { tool, rpcCalls } = routerHarness();
	await tool!.execute("tool", { action: "status", task: "run-123" }, new AbortController().signal, undefined, ctx);
	assert.deepEqual(rpcCalls.map((call) => ({ method: call.method, params: call.params })), [
		{ method: "status", params: { runId: "run-123" } },
	]);
});

test("status rejects ambiguous run targets before calling upstream", async () => {
	const { tool, rpcCalls } = routerHarness();
	await assert.rejects(
		() => tool!.execute("tool", { action: "status", task: "run-1 run-2" }, new AbortController().signal, undefined, ctx),
		/status accepts one run id/,
	);
	assert.deepEqual(rpcCalls, []);
});

test("one-off dispatch surfaces an accepted async launch that has no run id", async () => {
	const { tool, uncertain } = routerHarness(undefined, null);
	await assert.rejects(
		() => tool!.execute("tool", { action: "implement", task: "change code" }, new AbortController().signal, undefined, ctx),
		/implement was accepted without a run id; inspect active specialists before retrying/,
	);
	assert.deepEqual(uncertain, ["writer-token"]);
});

test("model-facing workflow dispatch stays standard even if runtime params contain deep effort", async () => {
	const calls: Array<{ name: string; task: string; effort: EngineeringEffort; signal?: AbortSignal }> = [];
	const workflows = {
		async spawn(_ctx, name, task, effort, signal) {
			calls.push({ name, task, effort, signal });
			return { message: "launched", runId: "workflow-1", rpc: undefined };
		},
	} satisfies WorkflowService;
	const { tool, rpcCalls } = routerHarness(workflows);
	const signal = new AbortController().signal;
	await tool!.execute("tool", { action: "audit", task: "review the diff", effort: "deep" } as never, signal, undefined, ctx);
	assert.deepEqual(calls, [{ name: "audit", task: "review the diff", effort: "standard", signal }]);
	assert.deepEqual(rpcCalls, [], "the supplied workflow service owns its launch lifecycle");
});

test("human slash command can select deep effort for the fixed workflow topology", async () => {
	const calls: Array<{ name: string; task: string; effort: EngineeringEffort }> = [];
	const workflows = {
		async spawn(_ctx, name, task, effort) {
			calls.push({ name, task, effort });
			return { message: "launched", runId: "workflow-1", rpc: undefined };
		},
	} satisfies WorkflowService;
	const { commands } = routerHarness(workflows);
	const notices: string[] = [];
	const commandCtx = {
		cwd: "/repo",
		hasUI: true,
		ui: { notify(message: string) { notices.push(message); } },
	} as unknown as ExtensionCommandContext;
	await commands.get("engineering")!.handler("--deep audit review the release", commandCtx);
	assert.deepEqual(calls, [{ name: "audit", task: "review the release", effort: "deep" }]);
	assert.match(notices.at(-1) ?? "", /Effort: deep/);
});

test("model overrides are rejected outside one-off actions and when blank or oversized", async () => {
	const calls: string[] = [];
	const workflows = {
		async spawn() {
			calls.push("spawn");
			return { message: "launched", runId: "workflow-1", rpc: undefined };
		},
	} satisfies WorkflowService;
	const { tool, rpcCalls } = routerHarness(workflows);
	for (const action of ["status", "audit", "deliver"] as const) {
		await assert.rejects(
			() => tool!.execute("tool", { action, task: "target", model: "provider/model" }, new AbortController().signal, undefined, ctx),
			/model override is only supported for one-off actions/,
		);
	}
	await assert.rejects(
		() => tool!.execute("tool", { action: "inspect", task: "target", model: "   " }, new AbortController().signal, undefined, ctx),
		/model override must not be blank/,
	);
	await assert.rejects(
		() => tool!.execute("tool", { action: "inspect", task: "target", model: "x".repeat(257) }, new AbortController().signal, undefined, ctx),
		/model override must be at most 256 characters/,
	);
	assert.deepEqual(calls, []);
	assert.deepEqual(rpcCalls, []);
});

test("task bounds also apply to command-style dispatch that bypasses schema validation", async () => {
	const { tool, rpcCalls } = routerHarness();
	await assert.rejects(
		() => tool!.execute("tool", { action: "inspect", task: "x".repeat(32_769) }, new AbortController().signal, undefined, ctx),
		/task must be at most 32768 characters/,
	);
	assert.deepEqual(rpcCalls, []);
});
