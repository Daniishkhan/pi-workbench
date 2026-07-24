import assert from "node:assert/strict";
import { test } from "node:test";
import { allowsSurface, capabilityForAgent, resolveTeamAgentCapability, ROLE_POLICIES } from "../../extensions/core/role-policy.ts";

test("classifies known roles and fails unknown custom agents closed as writers", () => {
	assert.equal(capabilityForAgent("advisor"), "read-only");
	assert.equal(capabilityForAgent("pi-workbench.fast-scout"), "read-only");
	assert.equal(capabilityForAgent("pi-workbench.worker"), "writer");
	assert.equal(capabilityForAgent("pi-agent-teams.scout"), "read-only");
	assert.equal(capabilityForAgent("unregistered.custom-agent"), "writer");
});

test("keeps workflow-only roles out of one-off and team routing", () => {
	assert.equal(allowsSurface("pi-shipyard.falsifier", "shipyard"), true);
	assert.equal(allowsSurface("pi-shipyard.falsifier", "one-off"), false);
	assert.equal(allowsSurface("pi-agent-teams.teammate", "team"), true);
	assert.ok(Object.keys(ROLE_POLICIES).length >= 20);
});

test("prevents team callers from downgrading known writers while allowing explicit custom read-only roles", () => {
	assert.equal(resolveTeamAgentCapability("pi-agent-teams.teammate"), "writer");
	assert.equal(resolveTeamAgentCapability("pi-agent-teams.scout"), "read-only");
	assert.throws(() => resolveTeamAgentCapability("pi-agent-teams.teammate", false), /cannot override packaged policy/);
	assert.throws(() => resolveTeamAgentCapability("pi-workbench.worker", true), /not approved for the Agent Teams surface/);
	assert.equal(resolveTeamAgentCapability("custom.read-only", false), "read-only");
	assert.equal(resolveTeamAgentCapability("custom.undeclared"), "writer");
});
