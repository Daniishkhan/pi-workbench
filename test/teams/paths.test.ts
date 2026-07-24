import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { listTeamNames, teamDir, teamsRoot } from "../../extensions/teams/store.ts";

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
	if (!(name in savedEnv)) savedEnv[name] = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	for (const [name, value] of Object.entries(savedEnv)) setEnv(name, value);
	for (const name of Object.keys(savedEnv)) delete savedEnv[name];
});

function fixture(): { root: string; agentDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-teams-paths-test-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("PI_WORKBENCH_TEAMS_ROOT", undefined);
	setEnv("PI_AGENT_TEAMS_ROOT", undefined);
	return { root, agentDir };
}

function seedLegacyTeam(agentDir: string, name: string): string {
	const dir = path.join(agentDir, "teams", name);
	fs.mkdirSync(path.join(dir, "inboxes"), { recursive: true });
	fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({
		version: 1,
		name,
		goal: "legacy",
		leadSessionId: "legacy-session",
		createdAt: Date.now(),
		closed: false,
		members: [],
	}, null, 2)}\n`);
	fs.writeFileSync(path.join(dir, "tasks.json"), '{"version":1,"tasks":[]}\n');
	return dir;
}

test("teamsRoot follows the pi agent directory when no override is set", () => {
	const { agentDir } = fixture();
	assert.equal(teamsRoot(), path.join(agentDir, "workbench", "teams"));
});

test("PI_WORKBENCH_TEAMS_ROOT wins over the legacy override and the agent dir", () => {
	const { agentDir, root } = fixture();
	const legacyOverride = path.join(root, "legacy-override");
	const override = path.join(root, "override");
	setEnv("PI_AGENT_TEAMS_ROOT", legacyOverride);
	assert.equal(teamsRoot(), path.resolve(legacyOverride));
	setEnv("PI_WORKBENCH_TEAMS_ROOT", override);
	assert.equal(teamsRoot(), path.resolve(override));
	// With an explicit override, the pre-unification agent-dir root is not consulted.
	const legacy = seedLegacyTeam(agentDir, "legacy-team");
	assert.equal(listTeamNames().includes("legacy-team"), false);
	assert.notEqual(teamDir("legacy-team"), legacy);
});

test("pre-unification teams stay readable as a fallback", () => {
	const { agentDir } = fixture();
	const legacy = seedLegacyTeam(agentDir, "legacy-team");
	assert.equal(teamDir("legacy-team"), legacy);
	assert.deepEqual(listTeamNames(), ["legacy-team"]);

	// A team present in the unified root shadows the legacy copy.
	const primary = path.join(agentDir, "workbench", "teams", "legacy-team");
	fs.mkdirSync(primary, { recursive: true });
	fs.copyFileSync(path.join(legacy, "config.json"), path.join(primary, "config.json"));
	assert.equal(teamDir("legacy-team"), primary);
	assert.deepEqual(listTeamNames(), ["legacy-team"], "no duplicates across roots");

	// New teams are created in the unified root.
	assert.equal(teamDir("brand-new-team"), path.join(agentDir, "workbench", "teams", "brand-new-team"));
});
