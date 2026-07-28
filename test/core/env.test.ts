import assert from "node:assert/strict";
import test from "node:test";
import {
	CHILD_ENV,
	isChildSession,
	isRuntimeHostOnly,
	RUNTIME_HOST_ONLY_ENV,
} from "../../extensions/core/env.ts";

function withMarkers(child: string | undefined, runtimeOnly: string | undefined, run: () => void): void {
	const previousChild = process.env[CHILD_ENV];
	const previousRuntimeOnly = process.env[RUNTIME_HOST_ONLY_ENV];
	try {
		if (child === undefined) delete process.env[CHILD_ENV];
		else process.env[CHILD_ENV] = child;
		if (runtimeOnly === undefined) delete process.env[RUNTIME_HOST_ONLY_ENV];
		else process.env[RUNTIME_HOST_ONLY_ENV] = runtimeOnly;
		run();
	} finally {
		if (previousChild === undefined) delete process.env[CHILD_ENV];
		else process.env[CHILD_ENV] = previousChild;
		if (previousRuntimeOnly === undefined) delete process.env[RUNTIME_HOST_ONLY_ENV];
		else process.env[RUNTIME_HOST_ONLY_ENV] = previousRuntimeOnly;
	}
}

test("runtime-host-only mode applies to a parent but never a specialist child", () => {
	withMarkers(undefined, "1", () => {
		assert.equal(isChildSession(), false);
		assert.equal(isRuntimeHostOnly(), true);
	});
	withMarkers("1", "1", () => {
		assert.equal(isChildSession(), true);
		assert.equal(isRuntimeHostOnly(), false);
	});
	withMarkers(undefined, "0", () => assert.equal(isRuntimeHostOnly(), false));
});
