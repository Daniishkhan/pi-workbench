import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeFindingAction, createCapabilityRegistry } from "../../extensions/shipyard/findings-capabilities.ts";
import { initializeStore } from "../../extensions/shipyard/findings-store.ts";

async function fixture(workflow = "review-mesh") {
	const root = await mkdtemp(path.join(os.tmpdir(), "shipyard-cap-"));
	const store = path.join(root, "S-test", "R-capability", "findings");
	await initializeStore(store, { runId: "R-capability", workflow });
	return { root, store };
}

test("binds workflow ledger actions to an opaque stage capability", async () => {
	const { root, store } = await fixture();
	try {
		const [grant] = await createCapabilityRegistry(store, "R-capability", "review-mesh", [{
			stage: "wave-1-contracts",
			sourceRole: "pi-shipyard.contract-reviewer",
			actions: ["init", "add"],
		}]);
		const authorization = await authorizeFindingAction(store, grant.token, "add");
		assert.equal(authorization.manual, false);
		assert.equal(authorization.stage, "wave-1-contracts");
		assert.equal(authorization.sourceRole, "pi-shipyard.contract-reviewer");
		await assert.rejects(() => authorizeFindingAction(store, grant.token, "list"), /does not allow list/);
		await assert.rejects(() => authorizeFindingAction(store, "x".repeat(43), "add"), /Invalid findings capability/);
		const registry = await readFile(path.join(path.dirname(store), ".findings-capabilities.json"), "utf8");
		assert.equal(registry.includes(grant.token), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("requires a capability for manual stores after initialization", async () => {
	const { root, store } = await fixture("manual");
	try {
		await assert.rejects(() => authorizeFindingAction(store, undefined, "export"), /no capability registry/);
		const [grant] = await createCapabilityRegistry(store, "R-capability", "manual", [{
			stage: "manual",
			sourceRole: "manual",
			actions: ["add", "export"],
		}]);
		const authorization = await authorizeFindingAction(store, grant.token, "export");
		assert.equal(authorization.manual, true);
		assert.equal(authorization.actions.includes("export"), true);
		await assert.rejects(() => authorizeFindingAction(store, "x".repeat(43), "add"), /Invalid findings capability/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
