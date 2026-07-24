import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { allowsSurface, capabilityForAgent } from "../../extensions/core/role-policy.ts";
import {
	createPinnedReadOnlyAgents,
	DYNAMIC_READER_ROLES,
	DYNAMIC_VERIFIER_ROLES,
	sweepStalePinnedAgents,
} from "../../extensions/dynamic/pinned-agents.ts";

test("creates random policy-approved read-only agent definitions and removes them", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-dynamic-agent-test-"));
	try {
		for (const logical of [...DYNAMIC_READER_ROLES, ...DYNAMIC_VERIFIER_ROLES]) {
			assert.equal(allowsSurface(logical, "dynamic"), true, `${logical} must be approved for Dynamic Workflows`);
			assert.equal(capabilityForAgent(logical), "read-only", `${logical} must remain read-only`);
		}
		const first = createPinnedReadOnlyAgents(root);
		const second = createPinnedReadOnlyAgents(root);
		for (const logical of DYNAMIC_READER_ROLES) {
			assert.notEqual(first.map[logical], second.map[logical]);
			assert.match(first.map[logical]!, /^pi-workbench-dynamic-runtime\.reader-/);
		}
		for (const logical of DYNAMIC_VERIFIER_ROLES) {
			assert.notEqual(first.map[logical], second.map[logical]);
			assert.match(first.map[logical]!, /^pi-workbench-dynamic-runtime\.verifier-/);
		}
		for (const file of first.files) {
			const source = fs.readFileSync(file, "utf8");
			assert.match(source, /tools: read, grep, find, ls, web_search, fetch_content, get_search_content/);
			assert.doesNotMatch(source, /tools:.*(?:bash|write|edit)/);
			assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		}
		first.dispose();
		assert(first.files.every((file) => !fs.existsSync(file)));
		second.dispose();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("janitor sweeps only pinned runtime agents whose owning process is dead", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-dynamic-janitor-test-"));
	try {
		const agentsDir = path.join(root, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		const dead = path.join(agentsDir, "pi-workbench-dynamic-runtime-reader-424242-0123456789abcdef0123456789abcdef.md");
		const alive = path.join(agentsDir, `pi-workbench-dynamic-runtime-verifier-${process.pid}-fedcba9876543210fedcba9876543210.md`);
		const unrelated = path.join(agentsDir, "pi-workbench-dynamic-runtime-reader-notapid.md");
		const userAgent = path.join(agentsDir, "my-agent.md");
		for (const file of [dead, alive, unrelated, userAgent]) fs.writeFileSync(file, "test\n");

		const swept = sweepStalePinnedAgents(root, (pid) => pid === process.pid);
		assert.equal(swept, 1);
		assert.equal(fs.existsSync(dead), false, "dead owner's pinned agent must be swept");
		assert.equal(fs.existsSync(alive), true, "live owner's pinned agent must be kept");
		assert.equal(fs.existsSync(unrelated), true, "non-matching names are never touched");
		assert.equal(fs.existsSync(userAgent), true);

		// Missing agents directory and repeat sweeps are no-ops.
		assert.equal(sweepStalePinnedAgents(path.join(root, "missing")), 0);
		assert.equal(sweepStalePinnedAgents(root, () => false), 1, "the live-pid file is swept once its process is gone");
		assert.equal(fs.existsSync(alive), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
