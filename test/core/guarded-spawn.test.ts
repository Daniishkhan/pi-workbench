import assert from "node:assert/strict";
import { test } from "node:test";
import { beginGuardedSpawn } from "../../extensions/core/guarded-spawn.ts";
import type { SubagentRpcReply } from "../../extensions/core/subagent-rpc.ts";
import type { WriterLease } from "../../extensions/core/writer-coordinator.ts";

class FakeRpc {
	readonly calls: Array<{ method: string; params: Record<string, unknown>; signal?: AbortSignal }> = [];
	private readonly plan: (method: string) => SubagentRpcReply | Error;
	constructor(plan: (method: string) => SubagentRpcReply | Error) { this.plan = plan; }
	async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<SubagentRpcReply> {
		this.calls.push({ method, params, signal });
		const outcome = this.plan(method);
		if (outcome instanceof Error) throw outcome;
		return outcome;
	}
}

class FakeCoordinator {
	readonly acquired: string[] = [];
	readonly released: Array<string | undefined> = [];
	readonly uncertain: Array<string | undefined> = [];
	readonly attached: Array<{ token: string | undefined; runId: string | undefined }> = [];
	acquireFailures: Error[] = [];
	blocking?: WriterLease;
	acquire(cwd: string, owner: string): WriterLease {
		const failure = this.acquireFailures.shift();
		if (failure) throw failure;
		this.acquired.push(owner);
		return { version: 1, token: `token-${this.acquired.length}`, cwd, owner, createdAt: Date.now(), pid: 1 };
	}
	get(cwd: string): WriterLease | undefined {
		return this.blocking ? { ...this.blocking, cwd } : undefined;
	}
	release(token: string | undefined): boolean { this.released.push(token); return true; }
	markUncertain(token: string | undefined): void { this.uncertain.push(token); }
	attachRun(token: string | undefined, runId: string | undefined): void { this.attached.push({ token, runId }); }
}

function reply(overrides: Partial<SubagentRpcReply> = {}): SubagentRpcReply {
	return { version: 1, requestId: "r", success: true, ...overrides };
}

const ctx = { cwd: "/repo" };

test("read-only spawns skip the lease and do not wire caller abort into the emitted RPC", async () => {
	const rpc = new FakeRpc(() => reply({ data: { text: "launched", details: { runId: "run-1" } } }));
	const coordinator = new FakeCoordinator();
	const guard = await beginGuardedSpawn({
		rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "test", writeCapable: false, label: "Test",
	});
	const controller = new AbortController();
	const { reply: spawnReply, runId } = await guard.spawn({ params: { agent: "a" }, signal: controller.signal });
	assert.equal(runId, "run-1");
	assert.equal(spawnReply.success, true);
	assert.equal(guard.lease, undefined);
	assert.deepEqual(coordinator.acquired, []);
	assert.equal(rpc.calls[1]?.signal, undefined);
	guard.discard();
	assert.deepEqual(coordinator.released, []);
});

test("an abort after emission waits for acknowledgement and stops the returned run", async () => {
	const calls: Array<{ method: string; params: Record<string, unknown>; signal?: AbortSignal }> = [];
	let acknowledgeSpawn: ((value: SubagentRpcReply) => void) | undefined;
	const rpc = {
		async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<SubagentRpcReply> {
			calls.push({ method, params, signal });
			if (method === "ping") return reply();
			if (method === "stop") return reply({ data: { text: "stop requested" } });
			return new Promise((resolve) => { acknowledgeSpawn = resolve; });
		},
	};
	const coordinator = new FakeCoordinator();
	const guard = await beginGuardedSpawn({
		rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "writer", writeCapable: true, label: "Test",
	});
	const controller = new AbortController();
	const pending = guard.spawn({ params: { agent: "a" }, signal: controller.signal });
	await Promise.resolve();
	assert.deepEqual(calls.map((call) => call.method), ["ping", "spawn"]);
	assert.equal(calls[1]?.signal, undefined);
	const rejection = assert.rejects(pending, /cancelled after spawn acknowledgement; stop requested for run-aborted/);
	controller.abort();
	assert.deepEqual(calls.map((call) => call.method), ["ping", "spawn"], "stop waits for the spawn acknowledgement");
	acknowledgeSpawn?.(reply({ data: { details: { runId: "run-aborted" } } }));
	await rejection;
	assert.deepEqual(calls.map((call) => call.method), ["ping", "spawn", "stop"]);
	assert.deepEqual(calls[2]?.params, { id: "run-aborted" });
	assert.equal(calls[2]?.signal, undefined);
	assert.deepEqual(coordinator.attached, [{ token: "token-1", runId: "run-aborted" }]);
	assert.deepEqual(coordinator.released, []);
});

test("an abort before emission releases the held lease and never spawns", async () => {
	const rpc = new FakeRpc(() => reply());
	const coordinator = new FakeCoordinator();
	const controller = new AbortController();
	const guard = await beginGuardedSpawn({
		rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "writer", writeCapable: true, label: "Test", signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(
		() => guard.spawn({ params: { agent: "a" } }),
		/cancelled before spawn request/,
	);
	assert.deepEqual(rpc.calls.map((call) => call.method), ["ping"]);
	assert.deepEqual(coordinator.released, ["token-1"]);
});

test("writer spawn attaches the lease to the returned run id", async () => {
	const rpc = new FakeRpc(() => reply({ data: { details: { runId: "run-9" } } }));
	const coordinator = new FakeCoordinator();
	const guard = await beginGuardedSpawn({
		rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "writer", writeCapable: true, label: "Test",
	});
	await guard.spawn({ params: {} });
	assert.deepEqual(coordinator.attached, [{ token: "token-1", runId: "run-9" }]);
	assert.deepEqual(coordinator.released, []);
	guard.discard(); // no-op: the run owns the lease now
	assert.deepEqual(coordinator.released, []);
});

test("success without a run id marks the lease uncertain and keeps it", async () => {
	const rpc = new FakeRpc(() => reply({ data: { text: "launched" } }));
	const coordinator = new FakeCoordinator();
	const guard = await beginGuardedSpawn({
		rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "writer", writeCapable: true, label: "Test",
	});
	const { runId } = await guard.spawn({ params: {} });
	assert.equal(runId, undefined);
	assert.deepEqual(coordinator.uncertain, ["token-1"]);
	assert.deepEqual(coordinator.released, []);
});

test("requireRunIdMessage throws after marking the lease uncertain", async () => {
	const rpc = new FakeRpc(() => reply({ data: {} }));
	const coordinator = new FakeCoordinator();
	const guard = await beginGuardedSpawn({
		rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "writer", writeCapable: true, label: "Spawn",
	});
	await assert.rejects(
		() => guard.spawn({ params: {}, requireRunIdMessage: "accepted without a run id" }),
		/accepted without a run id/,
	);
	assert.deepEqual(coordinator.uncertain, ["token-1"]);
	assert.deepEqual(coordinator.released, []);
});

test("ping transport error releases the lease and rethrows the original error", async () => {
	const failure = new Error("bus exploded");
	const rpc = new FakeRpc((method) => method === "ping" ? failure : reply());
	const coordinator = new FakeCoordinator();
	await assert.rejects(
		() => beginGuardedSpawn({ rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "w", writeCapable: true, label: "Test" }),
		(error) => error === failure,
	);
	assert.deepEqual(coordinator.released, ["token-1"]);
});

test("ping RPC-level failure releases the lease with a labeled error", async () => {
	const rpc = new FakeRpc((method) => method === "ping" ? reply({ success: false, error: { message: "no session" } }) : reply());
	const coordinator = new FakeCoordinator();
	await assert.rejects(
		() => beginGuardedSpawn({ rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "w", writeCapable: true, label: "Workbench workflow launch" }),
		/Workbench workflow launch: pi-subagents RPC unavailable: no session/,
	);
	assert.deepEqual(coordinator.released, ["token-1"]);
});

test("spawn transport error marks uncertain, keeps the lease, journals, and rethrows", async () => {
	const failure = new Error("reply lost");
	const rpc = new FakeRpc((method) => method === "spawn" ? failure : reply());
	const coordinator = new FakeCoordinator();
	const guard = await beginGuardedSpawn({
		rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "w", writeCapable: true, label: "Test",
	});
	const journal: string[] = [];
	await assert.rejects(
		() => guard.spawn({ params: {}, onTransportError: () => { journal.push("launch-uncertain"); } }),
		(error) => error === failure,
	);
	assert.deepEqual(journal, ["launch-uncertain"]);
	assert.deepEqual(coordinator.uncertain, ["token-1"]);
	guard.discard(); // no-op: launch state is uncertain, lease is preserved
	assert.deepEqual(coordinator.released, []);
});

test("spawn RPC-level rejection journals then releases the lease", async () => {
	const rpc = new FakeRpc((method) => method === "spawn" ? reply({ success: false, error: { code: "invalid_params", message: "bad agent" } }) : reply());
	const coordinator = new FakeCoordinator();
	const guard = await beginGuardedSpawn({
		rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "w", writeCapable: true, label: "Workbench launch",
	});
	const journal: string[] = [];
	await assert.rejects(
		() => guard.spawn({ params: {}, onRejected: () => { journal.push("rejected"); } }),
		/Workbench launch failed: invalid_params: bad agent/,
	);
	assert.deepEqual(journal, ["rejected"]);
	assert.deepEqual(coordinator.released, ["token-1"]);
	assert.deepEqual(coordinator.uncertain, []); // a clean rejection is never uncertain
});

test("acquire conflicts propagate before any RPC call", async () => {
	const rpc = new FakeRpc(() => reply());
	const coordinator = new FakeCoordinator();
	coordinator.acquireFailures = [new Error("Workbench writer guard: busy")];
	await assert.rejects(
		() => beginGuardedSpawn({ rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "w", writeCapable: true, label: "Test" }),
		/busy/,
	);
	assert.equal(rpc.calls.length, 0);
});

test("a terminal blocking lease is reaped and the acquire retried once", async () => {
	const rpc = new FakeRpc((method) => method === "status"
		? reply({ data: { text: "Run: run-old\nState: completed\n" } })
		: reply({ data: { details: { runId: "run-new" } } }));
	const coordinator = new FakeCoordinator();
	coordinator.acquireFailures = [new Error("Workbench writer guard: busy")];
	coordinator.blocking = { version: 1, token: "old-token", cwd: ctx.cwd, owner: "old-owner", createdAt: 1, pid: 1, runId: "run-old" };
	const guard = await beginGuardedSpawn({
		rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "w", writeCapable: true, label: "Test",
	});
	assert.deepEqual(coordinator.released, ["old-token"]);
	assert.equal(guard.lease?.token, "token-1");
	assert.equal(rpc.calls[0]?.method, "status");
	assert.deepEqual(rpc.calls[0]?.params, { id: "run-old" });
	assert.equal(rpc.calls[1]?.method, "ping");
});

test("an active or unverifiable blocking lease keeps the conflict error", async () => {
	for (const statusText of ["State: running", "State: mysterious"]) {
		const rpc = new FakeRpc((method) => method === "status" ? reply({ data: { text: statusText } }) : reply());
		const coordinator = new FakeCoordinator();
		coordinator.acquireFailures = [new Error("Workbench writer guard: busy")];
		coordinator.blocking = { version: 1, token: "old-token", cwd: ctx.cwd, owner: "old-owner", createdAt: 1, pid: 1, runId: "run-old" };
		await assert.rejects(
			() => beginGuardedSpawn({ rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "w", writeCapable: true, label: "Test" }),
			/busy/,
		);
		assert.equal(coordinator.released.length, 0);
		assert.equal(rpc.calls.length, 1, "only the status probe may run");
		assert.equal(rpc.calls[0]?.method, "status");
	}
	// A status transport failure is not terminal evidence either.
	const rpc = new FakeRpc(() => new Error("transport down"));
	const coordinator = new FakeCoordinator();
	coordinator.acquireFailures = [new Error("Workbench writer guard: busy")];
	coordinator.blocking = { version: 1, token: "old-token", cwd: ctx.cwd, owner: "old-owner", createdAt: 1, pid: 1, runId: "run-old" };
	await assert.rejects(
		() => beginGuardedSpawn({ rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "w", writeCapable: true, label: "Test" }),
		/busy/,
	);
	assert.equal(coordinator.released.length, 0);
});

test("discard before spawn releases; discard after success does not", async () => {
	const rpc = new FakeRpc(() => reply({ data: { details: { runId: "run-1" } } }));
	const coordinator = new FakeCoordinator();
	const first = await beginGuardedSpawn({
		rpc, writerCoordinator: coordinator as never, cwd: ctx.cwd, owner: "w", writeCapable: true, label: "Test",
	});
	first.discard();
	assert.deepEqual(coordinator.released, ["token-1"]);
	first.discard(); // idempotent
	assert.deepEqual(coordinator.released, ["token-1"]);
});
