import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WORKBENCH_CONFIG, resolveWorkbenchConfig } from "../../extensions/core/config.ts";

test("defaults to the enabled writer guard", () => {
	assert.deepEqual(resolveWorkbenchConfig({}), DEFAULT_WORKBENCH_CONFIG);
	assert.deepEqual(resolveWorkbenchConfig({ writerGuard: {} }), DEFAULT_WORKBENCH_CONFIG);
});

test("accepts an explicit writer guard setting", () => {
	assert.deepEqual(resolveWorkbenchConfig({ writerGuard: { enabled: false } }), {
		writerGuard: { enabled: false },
	});
});

test("rejects non-object config shapes", () => {
	for (const value of [null, [], "bad", 42]) {
		assert.throws(() => resolveWorkbenchConfig(value), /Pi Workbench config must be an object/);
	}
	for (const value of [null, [], "bad", 42]) {
		assert.throws(() => resolveWorkbenchConfig({ writerGuard: value }), /writerGuard must be an object/);
	}
});

test("rejects unknown and incorrectly typed settings", () => {
	assert.throws(() => resolveWorkbenchConfig({ modules: {} }), /unknown key: modules/);
	assert.throws(() => resolveWorkbenchConfig({ writerGuard: { enabled: "yes" } }), /must be a boolean/);
	assert.throws(() => resolveWorkbenchConfig({ writerGuard: { enabled: true, mode: "legacy" } }), /unknown key: mode/);
});
