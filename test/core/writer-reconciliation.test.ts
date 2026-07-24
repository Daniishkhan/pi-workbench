import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { SubagentRpcClient } from "../../extensions/core/subagent-rpc.ts";
import { WriterCoordinator } from "../../extensions/core/writer-coordinator.ts";
import { classifySubagentStatusText, reconcileWriterLeases } from "../../extensions/core/writer-reconciliation.ts";

test("classifies the documented pi-subagents status text", () => {
	assert.equal(classifySubagentStatusText("Run: a\nState: running\nMode: single"), "active");
	assert.equal(classifySubagentStatusText("Run: a\nState: complete\nResult: /tmp/result"), "terminal");
	assert.equal(classifySubagentStatusText("Async run not found."), "unknown");
});

test("reconciles durable leases through versioned RPC without releasing unknown runs", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-reconcile-test-"));
	try {
		const coordinator = new WriterCoordinator({ rootDir: root });
		for (const [cwd, runId] of [["active", "run-active"], ["terminal", "run-terminal"], ["unknown", "run-unknown"]] as const) {
			const lease = coordinator.acquire(path.join(root, cwd), cwd)!;
			coordinator.attachRun(lease.token, runId);
		}
		const rpc = {
			async request(_method: string, params: unknown) {
				const id = (params as { id: string }).id;
				if (id === "run-active") return { version: 1 as const, requestId: id, success: true as const, data: { text: "State: running" } };
				if (id === "run-terminal") return { version: 1 as const, requestId: id, success: true as const, data: { text: "State: complete" } };
				return { version: 1 as const, requestId: id, success: false as const, error: { code: "execution_failed", message: "not found" } };
			},
		} as unknown as Pick<SubagentRpcClient, "request">;
		const result = await reconcileWriterLeases(coordinator, rpc);
		assert.deepEqual(result, { checked: 3, active: 1, released: 1, uncertain: 1 });
		assert.equal(coordinator.get(path.join(root, "terminal")), undefined);
		assert.equal(coordinator.get(path.join(root, "active"))?.uncertain, false);
		assert.equal(coordinator.get(path.join(root, "unknown"))?.uncertain, true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
