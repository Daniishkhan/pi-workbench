import assert from "node:assert/strict";
import test from "node:test";
import registerChildProjectTrustBoundary from "../../extensions/core/project-trust-boundary.ts";

test("specialist child project trust fails closed without persisting a decision", () => {
	let handler: (() => unknown) | undefined;
	registerChildProjectTrustBoundary({
		on(event: string, value: () => unknown) {
			assert.equal(event, "project_trust");
			handler = value;
		},
	} as never);

	assert.deepEqual(handler?.(), { trusted: "no" });
});
