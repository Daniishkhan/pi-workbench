import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRpcReply } from "../../extensions/core/subagent-rpc.ts";
import type { WriterCoordinator, WriterLease } from "../../extensions/core/writer-coordinator.ts";
import createWorkflowService from "../../extensions/workflows.ts";

interface ChainTask {
	agent: string;
	task: string;
	as?: string;
	output?: string;
	outputMode?: string;
}

interface ChainStep extends Partial<ChainTask> {
	parallel?: ChainTask[];
}

interface ChainFile {
	name: string;
	chain: ChainStep[];
}

async function chain(name: "audit" | "deliver"): Promise<ChainFile> {
	return JSON.parse(await readFile(path.resolve("chains", "workbench", `${name}.chain.json`), "utf8")) as ChainFile;
}

function children(value: ChainFile): ChainTask[] {
	return value.chain.flatMap((step) => step.parallel ?? [step as ChainTask]);
}

test("audit is exactly two fresh independent reviews followed by one synthesis reviewer", async () => {
	const value = await chain("audit");
	const tasks = children(value);
	assert.equal(value.name, "audit");
	assert.equal(tasks.length, 3);
	assert.deepEqual(tasks.map((task) => task.agent), Array(3).fill("pi-workbench.reviewer"));
	assert.equal(value.chain[0].parallel?.length, 2);
	assert.match(value.chain[0].parallel![0].task, /correctness and runtime/i);
	assert.match(value.chain[0].parallel![1].task, /tests, simplicity, and applicable security/i);
	assert.equal(tasks[0].outputMode, "file-only");
	assert.equal(tasks[1].outputMode, "file-only");
	assert.equal(tasks[2].outputMode, "inline");
	assert.match(tasks[2].task, /\{outputs\.correctness\}/);
	assert.match(tasks[2].task, /\{outputs\.quality\}/);
});

test("deliver is the bounded six-child plan, write, review, supported-fix, final-review loop", async () => {
	const value = await chain("deliver");
	const tasks = children(value);
	assert.equal(tasks.length, 6);
	assert.deepEqual(tasks.map((task) => task.agent), [
		"pi-workbench.planner",
		"pi-workbench.worker",
		"pi-workbench.reviewer",
		"pi-workbench.reviewer",
		"pi-workbench.worker",
		"pi-workbench.reviewer",
	]);
	assert.equal(value.chain[2].parallel?.length, 2);
	assert.equal(tasks.slice(0, -1).every((task) => task.outputMode === "file-only"), true);
	assert.equal(tasks.at(-1)?.outputMode, "inline");
	assert.match(tasks[4].task, /apply only supported fixes/i);
	assert.match(tasks[4].task, /make no changes if no supported findings exist/i);
	assert.deepEqual(new Set(tasks.map((task) => task.agent)), new Set([
		"pi-workbench.planner",
		"pi-workbench.worker",
		"pi-workbench.reviewer",
	]));
});

class FakeRpc {
	readonly calls: Array<{ method: string; params: Record<string, unknown>; signal?: AbortSignal }> = [];
	async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<SubagentRpcReply> {
		this.calls.push({ method, params, signal });
		return {
			version: 1,
			requestId: "request",
			success: true,
			data: method === "spawn" ? { text: "accepted", details: { runId: `run-${this.calls.length}` } } : {},
		};
	}
}

class FakeCoordinator {
	readonly acquired: Array<{ cwd: string; owner: string }> = [];
	readonly attached: Array<{ token: string | undefined; runId: string | undefined }> = [];
	readonly released: Array<string | undefined> = [];
	acquire(cwd: string, owner: string): WriterLease {
		this.acquired.push({ cwd, owner });
		return { version: 1, token: "lease", cwd, owner, createdAt: Date.now(), pid: 1 };
	}
	get(): undefined { return undefined; }
	attachRun(token: string | undefined, runId: string | undefined): void { this.attached.push({ token, runId }); }
	markUncertain(): void {}
	release(token: string | undefined): boolean { this.released.push(token); return true; }
}

function service(rpc: FakeRpc, coordinator: FakeCoordinator) {
	return createWorkflowService({
		rpc: rpc as never,
		writerCoordinator: coordinator as unknown as WriterCoordinator,
	});
}

const ctx = { cwd: "/repo" } as ExtensionContext;

test("audit launches the static chain read-only with the routed 20-minute limit", async () => {
	const rpc = new FakeRpc();
	const coordinator = new FakeCoordinator();
	const launched = await service(rpc, coordinator).spawn(ctx, "audit", "  inspect target  ", { timeoutMs: 20 * 60_000 });
	assert.equal(launched.runId, "run-2");
	assert.deepEqual(coordinator.acquired, []);
	assert.deepEqual(rpc.calls.map((call) => call.method), ["ping", "spawn"]);
	const params = rpc.calls[1].params;
	assert.equal(params.task, "inspect target");
	assert.equal(params.maxRuntimeMs, 20 * 60_000);
	assert.equal(params.context, "fresh");
	assert.equal(params.async, true);
	assert.equal(params.clarify, false);
	assert.equal(params.artifacts, false, "file-only receipts use the upstream chain run directory without bulky child artifacts");
	assert.equal("runId" in params, false, "Workbench must not invent a parallel run id");
	assert.equal(children({ name: "audit", chain: params.chain as ChainStep[] }).length, 3);
});

test("deliver acquires one writer lease and launches the static six-child chain", async () => {
	const rpc = new FakeRpc();
	const coordinator = new FakeCoordinator();
	const launched = await service(rpc, coordinator).spawn(ctx, "deliver", "implement target", { timeoutMs: 45 * 60_000 });
	assert.equal(launched.runId, "run-2");
	assert.deepEqual(coordinator.acquired, [{ cwd: "/repo", owner: "workbench:deliver" }]);
	assert.deepEqual(coordinator.attached, [{ token: "lease", runId: "run-2" }]);
	assert.deepEqual(coordinator.released, []);
	assert.equal(rpc.calls[1].params.maxRuntimeMs, 45 * 60_000);
	assert.equal(children({ name: "deliver", chain: rpc.calls[1].params.chain as ChainStep[] }).length, 6);
});

test("workflow input and route ceilings fail before acquiring a lease or calling RPC", async () => {
	for (const [name, task, timeoutMs, message] of [
		["audit", "target", 20 * 60_000 + 1, /20-minute ceiling/],
		["deliver", "target", 45 * 60_000 + 1, /45-minute ceiling/],
		["deliver", "   ", 45 * 60_000, /non-empty task/],
		["audit", "target", 0, /positive integer timeoutMs/],
	] as const) {
		const rpc = new FakeRpc();
		const coordinator = new FakeCoordinator();
		await assert.rejects(() => service(rpc, coordinator).spawn(ctx, name, task, { timeoutMs }), message);
		assert.deepEqual(rpc.calls, []);
		assert.deepEqual(coordinator.acquired, []);
	}
});
