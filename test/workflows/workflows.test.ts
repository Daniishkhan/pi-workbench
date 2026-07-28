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
	label?: string;
	output?: string;
	outputMode?: string;
	outputSchema?: Record<string, unknown>;
	acceptance?: { level?: string; reason?: string };
}

interface ChainStep extends Partial<ChainTask> {
	parallel?: ChainTask[] | ChainTask;
	expand?: {
		from: { output: string; path: string };
		item?: string;
		key?: string;
		maxItems?: number;
		onEmpty?: string;
	};
	collect?: { as?: string };
	concurrency?: number;
	failFast?: boolean;
}

interface ChainFile {
	name: string;
	chain: ChainStep[];
}

interface JsonSchemaNode {
	type?: string;
	const?: string;
	additionalProperties?: boolean;
	required?: string[];
	enum?: string[];
	maxItems?: number;
	minItems?: number;
	items?: JsonSchemaNode;
	oneOf?: JsonSchemaNode[];
	allOf?: JsonSchemaNode[];
	if?: JsonSchemaNode;
	then?: JsonSchemaNode;
	else?: JsonSchemaNode;
	contains?: JsonSchemaNode;
	properties?: Record<string, JsonSchemaNode>;
}

async function chain(name: "audit" | "deliver"): Promise<ChainFile> {
	return JSON.parse(await readFile(path.resolve("chains", "workbench", `${name}.chain.json`), "utf8")) as ChainFile;
}

function children(value: ChainFile): ChainTask[] {
	return value.chain.flatMap((step) => Array.isArray(step.parallel)
		? step.parallel
		: step.expand && step.parallel ? [step.parallel] : [step as ChainTask]);
}

function assertReviewEnvelope(task: ChainTask, decision = false): void {
	assert.equal(task.acceptance?.level, "none");
	assert.ok(task.acceptance?.reason?.trim(), `${task.label ?? task.agent} must explain why acceptance is disabled`);
	const schema = task.outputSchema as JsonSchemaNode | undefined;
	assert.ok(schema, `${task.label ?? task.agent} must require structured review output`);
	assert.equal(schema.type, "object");
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.required, decision
		? ["verdict", "summary", "findings", "validationEvidence", "residualRisks", "criticalRepairBatches"]
		: ["verdict", "summary", "findings", "validationEvidence", "residualRisks"]);
	assert.deepEqual(schema.properties?.verdict?.enum, ["READY", "NOT_READY"]);
	assert.equal(schema.oneOf?.[0]?.properties?.verdict?.const, "READY");
	assert.equal(schema.oneOf?.[0]?.properties?.findings?.maxItems, 0);
	assert.equal(schema.oneOf?.[0]?.properties?.ledgerDisposition?.properties?.result?.const, "READY");
	assert.equal(schema.oneOf?.[1]?.properties?.verdict?.const, "NOT_READY");
	assert.equal(schema.oneOf?.[1]?.properties?.findings?.minItems, 1);
	assert.equal(schema.oneOf?.[1]?.properties?.ledgerDisposition?.properties?.result?.const, "NOT_READY");

	const finding = schema.properties?.findings?.items;
	assert.deepEqual(finding?.required, [
		"severity", "confidence", "path", "line", "violatedContract", "scenario", "safeFix", "validation",
	]);
	assert.deepEqual(finding?.properties?.severity?.enum, ["P0", "P1", "P2", "P3"]);
	assert.deepEqual(finding?.properties?.line?.required, ["start", "end"]);
	assert.ok(finding?.properties?.line?.properties?.start);
	assert.ok(finding?.properties?.line?.properties?.end);

	const evidence = schema.properties?.validationEvidence?.items;
	assert.deepEqual(evidence?.required, ["check", "status", "evidence"]);
	assert.deepEqual(evidence?.properties?.status?.enum, ["VERIFIED", "REPORTED", "MISSING", "STALE", "NOT_APPLICABLE"]);

	const disposition = schema.properties?.ledgerDisposition;
	assert.deepEqual(disposition?.required, ["artifactPath", "gateId", "result", "evidenceSummary", "requiredNextState"]);
	assert.deepEqual(disposition?.properties?.result?.enum, ["READY", "NOT_READY"]);
	assert.equal(schema.required?.includes("ledgerDisposition"), false, "the internal plan disposition is optional without a named gate");

	if (decision) {
		const batches = schema.properties?.criticalRepairBatches;
		assert.equal(batches?.type, "array");
		assert.equal(batches?.maxItems, 1);
		assert.equal(batches?.items?.additionalProperties, false);
		assert.deepEqual(batches?.items?.required, ["id"]);
		assert.deepEqual(Object.keys(batches?.items?.properties ?? {}), ["id"]);
		assert.equal(batches?.items?.properties?.id?.const, "critical-p0-p1");
		assert.equal(batches?.items?.properties?.findings, undefined);
		assert.equal(schema.oneOf?.[0]?.properties?.criticalRepairBatches?.maxItems, 0);
		assert.deepEqual(schema.allOf?.[0]?.if?.properties?.findings?.contains?.properties?.severity?.enum, ["P0", "P1"]);
		assert.equal(schema.allOf?.[0]?.then?.properties?.criticalRepairBatches?.minItems, 1);
		assert.equal(schema.allOf?.[0]?.then?.properties?.criticalRepairBatches?.maxItems, 1);
		assert.equal(schema.allOf?.[0]?.else?.properties?.criticalRepairBatches?.maxItems, 0);
	} else {
		assert.equal(schema.properties?.criticalRepairBatches, undefined);
	}
}

test("audit is exactly two fresh independent reviews followed by one synthesis reviewer", async () => {
	const value = await chain("audit");
	const tasks = children(value);
	assert.equal(value.name, "audit");
	assert.equal(tasks.length, 3);
	assert.deepEqual(tasks.map((task) => task.agent), [
		"pi-workbench.reviewer",
		"pi-workbench.risk-reviewer",
		"pi-workbench.reviewer",
	]);
	const parallel = value.chain[0].parallel;
	assert.ok(Array.isArray(parallel));
	assert.equal(parallel.length, 2);
	assert.match(parallel[0].task, /correctness and runtime/i);
	assert.match(parallel[1].task, /non-functional and security risk/i);
	assert.match(parallel[0].task, /Spec baseline/i);
	assert.match(parallel[1].task, /acceptance coverage/i);
	assert.equal(tasks[0].outputMode, undefined, "structured receipts are passed by value, not duplicated into prose files");
	assert.equal(tasks[1].outputMode, undefined, "structured receipts are passed by value, not duplicated into prose files");
	assert.equal(tasks[2].outputMode, "inline");
	assert.equal(tasks[0].output, undefined);
	assert.equal(tasks[1].output, undefined);
	for (const task of tasks.slice(0, 2)) assertReviewEnvelope(task);
	assert.equal(tasks[2].outputSchema, undefined, "the terminal verdict must remain human-readable in async completion output");
	for (const task of tasks) assert.equal(task.acceptance?.level, "none");
	assert.match(tasks[2].task, /\{outputs\.correctness\}/);
	assert.match(tasks[2].task, /\{outputs\.quality\}/);
	assert.match(tasks[2].task, /first line is READY[\s\S]*otherwise NOT READY/i);
	assert.match(tasks[2].task, /work-plan disposition/i);
});

test("deliver is a fixed bounded chain with one optional critical repair and one terminal re-review", async () => {
	const value = await chain("deliver");
	const tasks = children(value);
	assert.equal(value.chain.length, 6);
	assert.equal(tasks.length, 7);
	assert.deepEqual(tasks.map((task) => task.agent), [
		"pi-workbench.planner",
		"pi-workbench.worker",
		"pi-workbench.reviewer",
		"pi-workbench.risk-reviewer",
		"pi-workbench.reviewer",
		"pi-workbench.worker",
		"pi-workbench.risk-reviewer",
	]);
	const initialReviews = value.chain[2].parallel;
	assert.ok(Array.isArray(initialReviews));
	assert.equal(initialReviews.length, 2);
	assert.equal(value.chain[2].concurrency, 2);
	assert.equal(value.chain[2].failFast, false);
	assert.notEqual(initialReviews[0].agent, initialReviews[1].agent, "functional and risk reviews must use distinct role/model profiles");
	assert.equal(tasks[0].outputMode, "file-only");
	assert.equal(tasks[1].outputMode, "file-only");
	assert.equal(tasks[4].outputMode, "inline");
	assert.equal(tasks[5].outputMode, "file-only");
	assert.equal(tasks[6].outputMode, "inline");
	assert.equal(tasks[0].outputSchema, undefined);
	assert.equal(tasks[1].outputSchema, undefined);
	assert.equal(tasks[5].outputSchema, undefined);
	assertReviewEnvelope(tasks[2]);
	assertReviewEnvelope(tasks[3]);
	assertReviewEnvelope(tasks[4], true);
	assertReviewEnvelope(tasks[6]);
	for (const index of [0, 2, 3, 4, 6]) assert.equal(tasks[index]?.acceptance?.level, "none");
	assert.equal(tasks[1].acceptance, undefined);
	assert.equal(tasks[5].acceptance, undefined);
	assert.equal(tasks[2].output, undefined);
	assert.equal(tasks[3].output, undefined);
	assert.equal(tasks[4].output, undefined);
	assert.equal(tasks[5].output, "critical-repair.md");
	assert.equal(tasks[6].output, undefined);
	assert.match(tasks[0].task, /stable task or milestone ID/i);
	assert.match(tasks[1].task, /status, Evidence, and Handoff/i);
	assert.match(tasks[2].task, /functional behavior and specification compliance/i);
	assert.match(tasks[3].task, /non-functional quality and security/i);
	assert.match(tasks[4].task, /top-level findings array is the sole authoritative finding set/i);
	assert.match(tasks[4].task, /only a gate signal/i);
	assert.match(tasks[5].task, /finding.*hypothesis/i);
	assert.match(tasks[5].task, /gate is only a boolean signal/i);
	assert.match(tasks[5].task, /every and only top-level P0\/P1 finding/i);
	assert.match(tasks[5].task, /never repair batch-supplied, duplicated, relabelled, P2, or P3 content/i);
	assert.match(tasks[5].task, /committing or pushing, deploying, accessing or changing credentials, remote actions or state, destructive operations/i);
	assert.match(tasks[5].task, /outside the original task and cited repair scope/i);
	assert.match(tasks[6].task, /explicitly overrides the risk-reviewer role's normal narrow functional scope/i);
	assert.match(tasks[6].task, /functional specification and correctness; non-functional[\s\S]*security or privacy/i);
	assert.match(tasks[6].task, /Mark a lens NOT_APPLICABLE only with a concrete reason tied to the inspected change/i);
	assert.match(tasks[6].task, /cannot trigger another repair|do not edit files, create criticalRepairBatches, launch another worker/i);
	const repair = value.chain[4];
	assert.deepEqual(repair.expand, {
		from: { output: "decision", path: "/criticalRepairBatches" },
		item: "repairBatch",
		key: "/id",
		maxItems: 1,
		onEmpty: "skip",
	});
	assert.deepEqual(repair.collect, { as: "repairResults" });
	assert.equal(repair.concurrency, 1);
	assert.equal(repair.failFast, true);
	const rereview = value.chain[5];
	assert.deepEqual(rereview.expand, {
		from: { output: "repairResults", path: "" },
		item: "repairResult",
		key: "/key",
		maxItems: 1,
		onEmpty: "skip",
	});
	assert.deepEqual(rereview.collect, { as: "finalReviews" });
	assert.equal(rereview.concurrency, 1);
	assert.equal(rereview.failFast, true);
	assert.doesNotMatch(JSON.stringify(value), /"when"|"loop"\s*:/i);
	assert.deepEqual(new Set(tasks.map((task) => task.agent)), new Set([
		"pi-workbench.planner",
		"pi-workbench.worker",
		"pi-workbench.reviewer",
		"pi-workbench.risk-reviewer",
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

test("audit launches the static chain read-only with standard effort", async () => {
	const rpc = new FakeRpc();
	const coordinator = new FakeCoordinator();
	const launched = await service(rpc, coordinator).spawn(ctx, "audit", "  inspect target  ", "standard");
	assert.equal(launched.runId, "run-2");
	assert.deepEqual(coordinator.acquired, []);
	assert.deepEqual(rpc.calls.map((call) => call.method), ["ping", "spawn"]);
	const params = rpc.calls[1].params;
	assert.equal(params.task, "inspect target");
	assert.equal(params.maxRuntimeMs, 20 * 60_000);
	assert.equal(params.context, "fresh");
	assert.equal(params.async, true);
	assert.equal(params.clarify, false);
	assert.equal(params.artifacts, true, "relative receipts must resolve in upstream run-scoped storage, not the worktree");
	assert.equal("runId" in params, false, "Pi Engineering must not invent a parallel run id");
	assert.equal(children({ name: "audit", chain: params.chain as ChainStep[] }).length, 3);
});

test("deliver acquires one write lock and launches the bounded seven-template chain", async () => {
	const rpc = new FakeRpc();
	const coordinator = new FakeCoordinator();
	const launched = await service(rpc, coordinator).spawn(ctx, "deliver", "implement target", "standard");
	assert.equal(launched.runId, "run-2");
	assert.deepEqual(coordinator.acquired, [{ cwd: "/repo", owner: "engineering:deliver" }]);
	assert.deepEqual(coordinator.attached, [{ token: "lease", runId: "run-2" }]);
	assert.deepEqual(coordinator.released, []);
	assert.equal(rpc.calls[1].params.maxRuntimeMs, 60 * 60_000);
	assert.equal(children({ name: "deliver", chain: rpc.calls[1].params.chain as ChainStep[] }).length, 7);
});

test("workflow input and effort fail before acquiring a lease or calling RPC", async () => {
	for (const [name, task, effort, message] of [
		["deliver", "   ", "standard", /non-empty task/],
		["audit", "target", "unbounded", /effort must be quick, standard, or deep/],
	] as const) {
		const rpc = new FakeRpc();
		const coordinator = new FakeCoordinator();
		await assert.rejects(() => service(rpc, coordinator).spawn(ctx, name, task, effort as never), message);
		assert.deepEqual(rpc.calls, []);
		assert.deepEqual(coordinator.acquired, []);
	}
});
