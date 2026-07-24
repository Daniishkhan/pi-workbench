import assert from "node:assert/strict";
import { test } from "node:test";
import { allowsSurface, capabilityForAgent, resolveTeamAgentCapability, ROLE_POLICIES } from "../../extensions/core/role-policy.ts";

test("classifies known roles and fails unknown custom agents closed as writers", () => {
	assert.equal(capabilityForAgent("advisor"), "read-only");
	assert.equal(capabilityForAgent("pi-workbench.fast-scout"), "read-only");
	assert.equal(capabilityForAgent("pi-workbench.worker"), "writer");
	assert.equal(capabilityForAgent("pi-workbench.teams-scout"), "read-only");
	assert.equal(capabilityForAgent("unregistered.custom-agent"), "writer");
});

test("keeps workflow-only roles out of one-off and team routing", () => {
	assert.equal(allowsSurface("pi-shipyard.falsifier", "shipyard"), true);
	assert.equal(allowsSurface("pi-shipyard.falsifier", "one-off"), false);
	assert.equal(allowsSurface("pi-workbench.teams-teammate", "team"), true);
	assert.ok(Object.keys(ROLE_POLICIES).length >= 20);
});

test("prevents team callers from downgrading known or unknown writers", () => {
	assert.equal(resolveTeamAgentCapability("pi-workbench.teams-teammate"), "writer");
	assert.equal(resolveTeamAgentCapability("pi-workbench.teams-scout"), "read-only");
	assert.throws(() => resolveTeamAgentCapability("pi-workbench.teams-teammate", false), /cannot override packaged policy/);
	assert.throws(() => resolveTeamAgentCapability("pi-workbench.worker", true), /not approved for the Agent Teams surface/);
	assert.throws(() => resolveTeamAgentCapability("custom.read-only", false), /cannot self-declare as read-only/);
	assert.equal(resolveTeamAgentCapability("custom.declared-writer", true), "writer");
	assert.equal(resolveTeamAgentCapability("custom.undeclared"), "writer");
});
