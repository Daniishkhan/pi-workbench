import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WORKBENCH_CONFIG, resolveWorkbenchConfig } from "../../extensions/core/config.ts";

test("defaults to Shipyard and Teams enabled with Dynamic Workflows disabled", () => {
	const config = resolveWorkbenchConfig({});
	assert.deepEqual(config, DEFAULT_WORKBENCH_CONFIG);
	assert.equal(config.modules.dynamicWorkflows, false);
	assert.equal(config.writerGuard.enabled, true);
});

test("accepts explicit module flags and sanitized role bindings", () => {
	const config = resolveWorkbenchConfig({
		modules: { shipyard: false, agentTeams: false, dynamicWorkflows: true },
		shipyard: { agentBindings: { "pi-shipyard.codebase-reader": "custom.reader", bad: 42, empty: " " } },
		writerGuard: { enabled: false },
	});
	assert.deepEqual(config.modules, { shipyard: false, agentTeams: false, dynamicWorkflows: true });
	assert.deepEqual(config.shipyard.agentBindings, { "pi-shipyard.codebase-reader": "custom.reader" });
	assert.equal(config.writerGuard.enabled, false);
});

test("malformed values fail back to conservative defaults", () => {
	const config = resolveWorkbenchConfig({ modules: "bad", writerGuard: { enabled: "yes" } });
	assert.equal(config.modules.dynamicWorkflows, false);
	assert.equal(config.writerGuard.enabled, true);
});
