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

test("reconciles leases only after durable artifacts confirm terminal state", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-reconcile-test-"));
	try {
		const coordinator = new WriterCoordinator({ rootDir: root });
		for (const [cwd, runId] of [
			["active", "run-active"],
			["terminal", "run-terminal"],
			["result", "run-result"],
			["early-failure", "run-early-failure"],
			["legacy", "run-legacy"],
			["legacy-result", "run-legacy-result"],
		] as const) {
			const lease = coordinator.acquire(path.join(root, cwd), cwd)!;
			const asyncDir = cwd.startsWith("legacy") ? undefined : path.join(root, `async-${cwd}`);
			if (asyncDir) fs.mkdirSync(asyncDir);
			coordinator.attachRun(lease.token, runId, asyncDir);
		}
		fs.writeFileSync(path.join(root, "async-active", "status.json"), `${JSON.stringify({ runId: "run-active", state: "running" })}\n`);
		fs.writeFileSync(path.join(root, "async-terminal", "status.json"), `${JSON.stringify({ runId: "run-terminal", state: "complete", endedAt: 42 })}\n`);
		fs.writeFileSync(path.join(root, "async-result", "status.json"), `${JSON.stringify({ runId: "run-result", state: "stopped" })}\n`);
		fs.writeFileSync(path.join(root, "async-result", "result.json"), "{}\n");
		fs.writeFileSync(path.join(root, "async-early-failure", "status.json"), `${JSON.stringify({ runId: "run-early-failure", state: "failed" })}\n`);
		const legacyResultPath = path.join(root, "run-legacy-result.json");
		fs.writeFileSync(legacyResultPath, "{}\n");
		const rpc = {
			async request(_method: string, params: unknown) {
				const id = (params as { id: string }).id;
				if (id === "run-active") return { version: 1 as const, requestId: id, success: true as const, data: { text: "State: running" } };
				if (id === "run-terminal") return { version: 1 as const, requestId: id, success: true as const, data: { text: "State: complete" } };
				if (id === "run-result") return { version: 1 as const, requestId: id, success: true as const, data: { text: "State: stopped" } };
				if (id === "run-early-failure") return { version: 1 as const, requestId: id, success: true as const, data: { text: "State: failed" } };
				if (id === "run-legacy-result") return { version: 1 as const, requestId: id, success: true as const, data: { text: `State: failed\nResult: ${legacyResultPath}` } };
				return { version: 1 as const, requestId: id, success: true as const, data: { text: "State: complete" } };
			},
		} as unknown as Pick<SubagentRpcClient, "request">;
		const result = await reconcileWriterLeases(coordinator, rpc);
		assert.deepEqual(result, { checked: 6, active: 1, released: 3, uncertain: 2 });
		assert.equal(coordinator.get(path.join(root, "terminal")), undefined);
		assert.equal(coordinator.get(path.join(root, "result")), undefined);
		assert.equal(coordinator.get(path.join(root, "legacy-result")), undefined);
		assert.equal(coordinator.get(path.join(root, "active"))?.uncertain, false);
		assert.equal(coordinator.get(path.join(root, "early-failure"))?.uncertain, true);
		assert.equal(coordinator.get(path.join(root, "legacy"))?.uncertain, true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
