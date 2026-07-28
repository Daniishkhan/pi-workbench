import assert from "node:assert/strict";
import { test } from "node:test";
import { allowsSurface, capabilityForAgent, ROLE_POLICIES } from "../../extensions/core/role-policy.ts";

test("classifies the five packaged roles and fails unknown agents closed as writers", () => {
	assert.equal(capabilityForAgent("pi-workbench.fast-scout"), "read-only");
	assert.equal(capabilityForAgent("pi-workbench.planner"), "read-only");
	assert.equal(capabilityForAgent("pi-workbench.worker"), "writer");
	assert.equal(capabilityForAgent("pi-workbench.reviewer"), "read-only");
	assert.equal(capabilityForAgent("pi-workbench.risk-reviewer"), "read-only");
	assert.equal(capabilityForAgent("unregistered.custom-agent"), "writer");
	assert.deepEqual(Object.keys(ROLE_POLICIES).sort(), [
		"pi-workbench.fast-scout",
		"pi-workbench.planner",
		"pi-workbench.reviewer",
		"pi-workbench.risk-reviewer",
		"pi-workbench.worker",
	]);
});

test("limits routing to the surfaces each packaged role needs", () => {
	assert.equal(allowsSurface("pi-workbench.fast-scout", "one-off"), true);
	assert.equal(allowsSurface("pi-workbench.fast-scout", "workflow"), false);
	assert.equal(allowsSurface("pi-workbench.planner", "workflow"), true);
	assert.equal(allowsSurface("pi-workbench.worker", "workflow"), true);
	assert.equal(allowsSurface("pi-workbench.reviewer", "workflow"), true);
	assert.equal(allowsSurface("pi-workbench.risk-reviewer", "workflow"), true);
	assert.equal(allowsSurface("pi-workbench.risk-reviewer", "one-off"), false);
	assert.equal(allowsSurface("unregistered.custom-agent", "one-off"), false);
});
