import assert from "node:assert/strict";
import { test } from "node:test";
import { ONE_OFF_AGENTS, resolveOneOffRoute, routeCategory, WORKBENCH_MODES } from "../../extensions/core/routing.ts";

test("routes every explicit mode into one non-nested orchestration category", () => {
	const categories = Object.fromEntries(WORKBENCH_MODES.map((mode) => [mode, routeCategory(mode)]));
	assert.equal(categories.quick, "one-off");
	assert.equal(categories.implement, "one-off");
	assert.equal(categories.deliver, "shipyard");
	assert.equal(categories.team, "team");
	assert.equal(categories.dynamic, "dynamic");
	assert.equal(categories.status, "status");
});

test("uses package-scoped general agents rather than a bare scout", () => {
	assert.equal(ONE_OFF_AGENTS.quick, "pi-workbench.fast-scout");
	assert.equal(ONE_OFF_AGENTS.deep, "pi-workbench.deep-reader");
	assert.equal(Object.values(ONE_OFF_AGENTS).some((name) => name === "scout"), false);
});

test("classifies the selected one-off agent rather than trusting the route name", () => {
	assert.deepEqual(resolveOneOffRoute("quick"), { agent: "pi-workbench.fast-scout", capability: "read-only" });
	assert.deepEqual(resolveOneOffRoute("quick", "pi-workbench.worker"), { agent: "pi-workbench.worker", capability: "writer" });
	assert.throws(() => resolveOneOffRoute("quick", "unknown.custom-agent"), /not approved/);
	assert.throws(() => resolveOneOffRoute("quick", "pi-shipyard.review-synthesizer"), /not approved/);
});
