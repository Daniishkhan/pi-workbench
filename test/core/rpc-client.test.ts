import assert from "node:assert/strict";
import { test } from "node:test";
import { SUBAGENT_RPC_REQUEST_EVENT, SubagentRpcClient, type SubagentRpcEventBus } from "../../extensions/core/subagent-rpc.ts";

class FakeBus implements SubagentRpcEventBus {
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

test("correlates a versioned RPC reply and cleans its listener", async () => {
	const bus = new FakeBus();
	bus.on(SUBAGENT_RPC_REQUEST_EVENT, (payload) => {
		const request = payload as { requestId: string; method: string; source: { extension: string } };
		assert.equal(request.source.extension, "test-extension");
		queueMicrotask(() => bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
			version: 1, requestId: request.requestId, method: request.method, success: true, data: { text: "ok" },
		}));
	});
	const client = new SubagentRpcClient(bus, { label: "Test", source: "test-extension", timeoutMs: 100 });
	const reply = await client.request("ping", {});
	assert.equal(reply.data?.text, "ok");
	assert.equal(client.pendingCount, 0);
});

test("abort rejects and removes pending state", async () => {
	const bus = new FakeBus();
	const client = new SubagentRpcClient(bus, { label: "Test", source: "test-extension", timeoutMs: 1_000 });
	const controller = new AbortController();
	const pending = client.request("spawn", {}, controller.signal);
	controller.abort();
	await assert.rejects(pending, /cancelled/);
	assert.equal(client.pendingCount, 0);
});
