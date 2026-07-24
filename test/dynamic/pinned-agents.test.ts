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
