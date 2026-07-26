import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ENGINEERING_CONFIG, resolveEngineeringConfig } from "../../extensions/core/config.ts";

test("defaults to the enabled write lock and accepts the legacy key", () => {
	assert.deepEqual(resolveEngineeringConfig({}), DEFAULT_ENGINEERING_CONFIG);
	assert.deepEqual(resolveEngineeringConfig({ writeLock: {} }), DEFAULT_ENGINEERING_CONFIG);
	assert.deepEqual(resolveEngineeringConfig({ writerGuard: {} }), DEFAULT_ENGINEERING_CONFIG);
});

test("accepts an explicit write lock setting", () => {
	assert.deepEqual(resolveEngineeringConfig({ writeLock: { enabled: false } }), {
		writeLock: { enabled: false },
	});
});

test("rejects non-object config shapes", () => {
	for (const value of [null, [], "bad", 42]) {
		assert.throws(() => resolveEngineeringConfig(value), /Pi Engineering config must be an object/);
	}
	for (const value of [null, [], "bad", 42]) {
		assert.throws(() => resolveEngineeringConfig({ writeLock: value }), /writeLock must be an object/);
	}
});

test("rejects unknown and incorrectly typed settings", () => {
	assert.throws(() => resolveEngineeringConfig({ modules: {} }), /unknown key: modules/);
	assert.throws(() => resolveEngineeringConfig({ writeLock: { enabled: "yes" } }), /must be a boolean/);
	assert.throws(() => resolveEngineeringConfig({ writeLock: { enabled: true, mode: "legacy" } }), /unknown key: mode/);
	assert.throws(
		() => resolveEngineeringConfig({ writeLock: {}, writerGuard: {} }),
		/must not define both writeLock and legacy writerGuard/,
	);
});
