import assert from "node:assert/strict";
import { test } from "node:test";
import { DelegationClient, type WorkflowEventBus } from "../../extensions/dynamic/delegation.ts";

const REQUEST = "prompt-template:subagent:request";
const STARTED = "prompt-template:subagent:started";
const UPDATE = "prompt-template:subagent:update";
const RESPONSE = "prompt-template:subagent:response";
const CANCEL = "prompt-template:subagent:cancel";

class FakeBus implements WorkflowEventBus {
	readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, handler: (payload: unknown) => void): () => void {
		let set = this.handlers.get(event);
		if (!set) this.handlers.set(event, set = new Set());
		set.add(handler);
		return () => set!.delete(handler);
	}
	emit(event: string, payload: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
	}
}

function complete(bus: FakeBus, request: Record<string, unknown>, output = "done"): void {
	queueMicrotask(() => {
		bus.emit(STARTED, { version: 1, requestId: request.requestId });
		bus.emit(UPDATE, { version: 1, requestId: request.requestId, currentTool: "read", toolCount: 1 });
		bus.emit(RESPONSE, {
			version: 1,
			requestId: request.requestId,
			status: "completed",
			agent: request.agent,
			output,
			model: "provider/model",
			turns: 2,
		});
	});
}

test("uses versioned public delegation for a single agent", async () => {
	const bus = new FakeBus();
	let request: Record<string, unknown> | undefined;
	const progress: unknown[] = [];
	bus.on(REQUEST, (payload) => {
		request = payload as Record<string, unknown>;
		complete(bus, request);
	});
	const client = new DelegationClient(bus);
	const result = await client.runSingle(
		{ agent: "pi-workbench.fast-scout", task: "Inspect", context: "fresh" },
		{ cwd: "/repo", context: "fresh", onProgress: (value) => progress.push(value) },
	);
	assert.equal(request?.version, 1);
	assert.equal(request?.output, false);
	assert.equal(request?.artifacts, true);
	assert.equal(request?.context, "fresh");
	assert.equal(Object.hasOwn(request!, "skill"), false);
	assert.equal(Object.hasOwn(request!, "acceptance"), false);
	assert.equal(result.status, "completed");
	assert.equal(result.output, "done");
	assert.equal(result.turns, 2);
	assert.equal(progress.length, 2);
	client.dispose();
});

test("parallel fanout uses only concurrent versioned single-agent requests", async () => {
	const bus = new FakeBus();
	const requests: Record<string, unknown>[] = [];
	const progress: unknown[] = [];
	bus.on(REQUEST, (payload) => {
		const request = payload as Record<string, unknown>;
		requests.push(request);
		complete(bus, request, `result:${request.task}`);
	});
	const client = new DelegationClient(bus);
	const results = await client.runParallel(
		[
			{ agent: "pi-workbench.reviewer", task: "A" },
			{ agent: "pi-workbench.fast-scout", task: "B" },
		],
		{ cwd: "/repo", context: "fresh", model: "provider/model", concurrency: 2, onProgress: (value) => progress.push(value) },
	);
	assert.equal(requests.length, 2);
	assert.ok(requests.every((request) => request.version === 1));
	assert.ok(requests.every((request) => !Object.hasOwn(request, "tasks")));
	assert.deepEqual(results.map((result) => result.output).sort(), ["result:A", "result:B"]);
	assert.ok(progress.length >= 2);
	client.dispose();
});

test("rejects worktree-backed parallel delegation instead of using a batch bridge", async () => {
	const client = new DelegationClient(new FakeBus());
	await assert.rejects(
		client.runParallel([{ agent: "pi-workbench.reviewer", task: "A" }], { cwd: "/repo", context: "fresh", worktree: true }),
		/do not create or merge temporary worktrees/,
	);
	client.dispose();
});

test("force disposal rejects an unacknowledged delegation immediately", async () => {
	const client = new DelegationClient(new FakeBus());
	const pending = client.runSingle({ agent: "pi-workbench.fast-scout", task: "Wait" }, { cwd: "/repo", context: "fresh" });
	client.dispose(true);
	await assert.rejects(pending, /force-closed/);
});

test("holds cancellation open until the versioned bridge acknowledges termination", async () => {
	const bus = new FakeBus();
	const controller = new AbortController();
	let cancelled: { version: number; requestId: string } | undefined;
	bus.on(CANCEL, (payload) => { cancelled = payload as { version: number; requestId: string }; });
	const client = new DelegationClient(bus);
	let settled = false;
	const pending = client.runSingle(
		{ agent: "pi-workbench.fast-scout", task: "Wait" },
		{ cwd: "/repo", context: "fresh", signal: controller.signal },
	);
	void pending.then(() => { settled = true; }, () => { settled = true; });
	controller.abort();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(cancelled?.version, 1);
	assert.equal(settled, false, "the caller—and therefore its writer lease—must remain pending until terminal acknowledgement");
	bus.emit(RESPONSE, { version: 1, requestId: cancelled!.requestId, status: "cancelled", agent: "pi-workbench.fast-scout" });
	const result = await pending;
	assert.equal(result.status, "cancelled");
	assert.equal(settled, true);
	client.dispose();
});
