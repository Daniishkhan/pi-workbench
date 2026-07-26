import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerRouter from "../../extensions/router.ts";
import type { SubagentRpcClient, SubagentRpcReply } from "../../extensions/core/subagent-rpc.ts";
import type { WriterCoordinator } from "../../extensions/core/writer-coordinator.ts";
import type { WorkflowService } from "../../extensions/workflows.ts";
import {
	ONE_OFF_AGENTS,
	resolveOneOffRoute,
	ROUTE_LIMITS,
	WORKBENCH_MODES,
} from "../../extensions/core/routing.ts";

test("exposes only the lean public routing surface", () => {
	assert.deepEqual(WORKBENCH_MODES, [
		"status",
		"inspect",
		"plan",
		"implement",
		"review",
		"deliver",
		"audit",
	]);
});

test("maps each one-off mode to one fixed packaged role", () => {
	assert.deepEqual(ONE_OFF_AGENTS, {
		inspect: "pi-workbench.fast-scout",
		plan: "pi-workbench.planner",
		implement: "pi-workbench.worker",
		review: "pi-workbench.reviewer",
	});
	assert.equal(resolveOneOffRoute("inspect").capability, "read-only");
	assert.equal(resolveOneOffRoute("plan").capability, "read-only");
	assert.equal(resolveOneOffRoute("implement").capability, "writer");
	assert.equal(resolveOneOffRoute("review").capability, "read-only");
});

test("keeps mandatory runtime and turn limits in one route table", () => {
	assert.deepEqual(ROUTE_LIMITS, {
		inspect: { timeoutMs: 5 * 60_000, turnBudget: { maxTurns: 8, graceTurns: 2 } },
		plan: { timeoutMs: 15 * 60_000, turnBudget: { maxTurns: 18, graceTurns: 2 } },
		implement: { timeoutMs: 45 * 60_000 },
		review: { timeoutMs: 15 * 60_000, turnBudget: { maxTurns: 18, graceTurns: 2 } },
		deliver: { timeoutMs: 45 * 60_000 },
		audit: { timeoutMs: 20 * 60_000 },
	});
	assert.equal("turnBudget" in ROUTE_LIMITS.implement, false, "writers must not have a hard turn cap");
});

interface RegisteredTool {
	execute(
		id: string,
		params: { mode: string; task?: string; model?: string },
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ details: Record<string, unknown> }>;
}

function routerHarness(workflows?: WorkflowService, spawnRunId: string | null = "run-1") {
	let tool: RegisteredTool | undefined;
	const pi = {
		registerTool(value: RegisteredTool) { tool = value; },
		registerCommand() {},
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
	const writerCoordinator = {
		list: () => [],
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
	} as unknown as WriterCoordinator;
	registerRouter(pi, {
		config: { writerGuard: { enabled: true } },
		workflows,
		writerCoordinator,
		rpc,
	});
	assert.ok(tool);
	return { tool, rpcCalls, uncertain };
}

const ctx = { cwd: "/repo" } as ExtensionContext;

test("one-off dispatch applies the fixed role policy while normalizing a bounded model override", async () => {
	const { tool, rpcCalls } = routerHarness();
	const signal = new AbortController().signal;
	await tool!.execute("tool", { mode: "inspect", task: "trace routing", model: "  provider/small  " }, signal, undefined, ctx);
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

test("one-off dispatch surfaces an accepted async launch that has no run id", async () => {
	const { tool, uncertain } = routerHarness(undefined, null);
	await assert.rejects(
		() => tool!.execute("tool", { mode: "implement", task: "change code" }, new AbortController().signal, undefined, ctx),
		/implement was accepted without a run id; inspect active subagents before retrying/,
	);
	assert.deepEqual(uncertain, ["writer-token"]);
});

test("workflow dispatch supplies the centralized timeout to the workflow service", async () => {
	const calls: Array<{ name: string; task: string; limits: { timeoutMs: number }; signal?: AbortSignal }> = [];
	const workflows = {
		async spawn(_ctx, name, task, limits, signal) {
			calls.push({ name, task, limits, signal });
			return { message: "launched", runId: "workflow-1", rpc: undefined };
		},
	} satisfies WorkflowService;
	const { tool, rpcCalls } = routerHarness(workflows);
	const signal = new AbortController().signal;
	await tool!.execute("tool", { mode: "audit", task: "review the diff" }, signal, undefined, ctx);
	assert.deepEqual(calls, [{ name: "audit", task: "review the diff", limits: { timeoutMs: 20 * 60_000 }, signal }]);
	assert.deepEqual(rpcCalls, [], "the supplied workflow service owns its launch lifecycle");
});

test("model overrides are rejected outside one-off modes and when blank or oversized", async () => {
	const calls: string[] = [];
	const workflows = {
		async spawn() {
			calls.push("spawn");
			return { message: "launched", runId: "workflow-1", rpc: undefined };
		},
	} satisfies WorkflowService;
	const { tool, rpcCalls } = routerHarness(workflows);
	for (const mode of ["status", "audit", "deliver"] as const) {
		await assert.rejects(
			() => tool!.execute("tool", { mode, task: "target", model: "provider/model" }, new AbortController().signal, undefined, ctx),
			/model override is only supported for one-off modes/,
		);
	}
	await assert.rejects(
		() => tool!.execute("tool", { mode: "inspect", task: "target", model: "   " }, new AbortController().signal, undefined, ctx),
		/model override must not be blank/,
	);
	await assert.rejects(
		() => tool!.execute("tool", { mode: "inspect", task: "target", model: "x".repeat(257) }, new AbortController().signal, undefined, ctx),
		/model override must be at most 256 characters/,
	);
	assert.deepEqual(calls, []);
	assert.deepEqual(rpcCalls, []);
});

test("task bounds also apply to command-style dispatch that bypasses schema validation", async () => {
	const { tool, rpcCalls } = routerHarness();
	await assert.rejects(
		() => tool!.execute("tool", { mode: "inspect", task: "x".repeat(32_769) }, new AbortController().signal, undefined, ctx),
		/task must be at most 32768 characters/,
	);
	assert.deepEqual(rpcCalls, []);
});
