import assert from "node:assert/strict";
import test from "node:test";
import { RPC_REQUEST_EVENT, RPC_REPLY_PREFIX, ShipyardRpcClient } from "../../extensions/shipyard/rpc-client.ts";

class MockBus {
	readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
	readonly emitted: Array<{ event: string; payload: any }> = [];

	on(event: string, handler: (payload: unknown) => void): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}

	emit(event: string, payload: unknown): void {
		this.emitted.push({ event, payload });
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
	}
}

function lastRequest(bus: MockBus) {
	const request = bus.emitted.findLast((entry) => entry.event === RPC_REQUEST_EVENT)?.payload;
	assert.ok(request?.requestId);
	return request;
}

test("resolves a correlated RPC reply and removes its listener", async () => {
	const bus = new MockBus();
	const client = new ShipyardRpcClient(bus, 100);
	const pending = client.request("ping", {});
	const request = lastRequest(bus);
	const replyEvent = `${RPC_REPLY_PREFIX}${request.requestId}`;
	bus.emit(replyEvent, { version: 999, requestId: request.requestId, method: "ping", success: true });
	assert.equal(client.pendingCount, 1);
	bus.emit(replyEvent, { version: 1, requestId: request.requestId, method: "ping", success: true });
	assert.equal((await pending).success, true);
	assert.equal(client.pendingCount, 0);
	assert.equal(bus.handlers.get(replyEvent)?.size, 0);
});

test("abort rejects before a delayed reply and cleans pending state", async () => {
	const bus = new MockBus();
	const client = new ShipyardRpcClient(bus, 1_000);
	const controller = new AbortController();
	const pending = client.request("ping", {}, controller.signal);
	const request = lastRequest(bus);
	controller.abort();
	await assert.rejects(pending, /cancelled/);
	assert.equal(client.pendingCount, 0);
	bus.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, {
		version: 1,
		requestId: request.requestId,
		method: "ping",
		success: true,
	});
	assert.equal(client.pendingCount, 0);
});

test("timeout rejects and removes pending state", async () => {
	const bus = new MockBus();
	const client = new ShipyardRpcClient(bus, 10);
	await assert.rejects(client.request("ping", {}), /Timed out/);
	assert.equal(client.pendingCount, 0);
});

test("dispose rejects all pending requests and prevents reuse", async () => {
	const bus = new MockBus();
	const client = new ShipyardRpcClient(bus, 1_000);
	const first = client.request("ping", {});
	const second = client.request("spawn", {});
	client.dispose("test shutdown");
	await assert.rejects(first, /test shutdown/);
	await assert.rejects(second, /test shutdown/);
	assert.equal(client.pendingCount, 0);
	await assert.rejects(client.request("ping", {}), /disposed/);
});
