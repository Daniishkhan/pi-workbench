import assert from "node:assert/strict";
import { test } from "node:test";
import { runIdFromSpawnReply, TeamsRpcClient, type RpcEventBus } from "../../extensions/teams/rpc.ts";

class FakeBus implements RpcEventBus {
	readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, handler: (payload: unknown) => void): () => void {
		let set = this.handlers.get(event);
		if (!set) this.handlers.set(event, set = new Set());
		set.add(handler);
		return () => set!.delete(handler);
	}
	emit(event: string, payload: unknown): void {
		if (event === "subagents:rpc:v1:request") {
			const request = payload as { requestId: string; method: string };
			queueMicrotask(() => this.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				method: request.method,
				success: true,
				data: { details: { runId: "team-run" } },
			}));
		}
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
	}
}

test("uses the shared RPC implementation and extracts the spawned run id", async () => {
	const client = new TeamsRpcClient(new FakeBus(), 100);
	const reply = await client.request("spawn", { agent: "pi-agent-teams.scout" });
	assert.equal(reply.success, true);
	assert.equal(runIdFromSpawnReply(reply), "team-run");
	assert.equal(client.pendingCount, 0);
	client.dispose();
});
