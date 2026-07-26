import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { applyMigration, buildMigratedSettings, rollback } from "../../scripts/migrate-settings.mjs";

const roots: string[] = [];
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-migration-test-"));
	roots.push(root);
	const settings = path.join(root, "agent", "settings.json");
	const scout = path.join(root, ".agents", "scout.md");
	fs.mkdirSync(path.dirname(settings), { recursive: true });
	fs.mkdirSync(path.dirname(scout), { recursive: true });
	const value = {
		theme: "custom",
		packages: [
			"npm:one",
			{ source: "npm:pi-subagents@0.35.1", prompts: [] },
			"./packages/pi-shipyard",
			"./packages/pi-agent-teams",
			"npm:other",
		],
		subagents: { agentOverrides: { scout: { model: "existing/model" } } as Record<string, unknown> },
	};
	fs.writeFileSync(settings, `${JSON.stringify(value, null, 2)}\n`);
	fs.writeFileSync(scout, "legacy scout\n");
	return { root, settings, scout, value };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("builds an exact package replacement while preserving unrelated settings and user overrides", () => {
	const { value } = fixture();
	const migrated = buildMigratedSettings(value, { "pi-workbench.fast-scout": { model: "recommended/model" } });
	assert.deepEqual(migrated.packages, [
		"npm:one",
		"./packages/pi-workbench",
		"npm:other",
	]);
	assert.equal(migrated.theme, "custom");
	assert.equal(migrated.subagents.agentOverrides.scout.model, "existing/model");
	assert.equal(migrated.subagents.agentOverrides["pi-workbench.fast-scout"].model, "recommended/model");
	assert.deepEqual(
		buildMigratedSettings({ ...value, packages: migrated.packages }, {}).packages,
		migrated.packages,
		"single-package migration must be idempotent",
	);
	assert.throws(
		() => buildMigratedSettings({ ...value, packages: ["npm:pi-subagents@0.36.0", "./packages/pi-workbench"] }, {}),
		/unexpected standalone runtime/,
	);
});

test("drops overrides for removed orchestration agents", () => {
	const { value } = fixture();
	value.subagents.agentOverrides["pi-agent-teams.scout"] = { model: "legacy/scout" };
	value.subagents.agentOverrides["pi-agent-teams.teammate"] = { model: "legacy/teammate", thinking: "high" };
	value.subagents.agentOverrides["pi-workbench.deep-reader"] = { model: "legacy/deep-reader" };
	value.subagents.agentOverrides["pi-workbench.teams-scout"] = { model: "legacy/teams-scout" };
	value.subagents.agentOverrides["pi-shipyard.falsifier"] = { model: "legacy/falsifier" };
	const migrated = buildMigratedSettings(value, {
		"pi-workbench.worker": { model: "recommended/worker" },
		"pi-shipyard.shipwright": { model: "obsolete/profile" },
	});
	const overrides = migrated.subagents.agentOverrides;
	assert.equal(overrides["pi-agent-teams.scout"], undefined);
	assert.equal(overrides["pi-agent-teams.teammate"], undefined);
	assert.equal(overrides["pi-workbench.deep-reader"], undefined);
	assert.equal(overrides["pi-workbench.teams-scout"], undefined);
	assert.equal(overrides["pi-shipyard.falsifier"], undefined);
	assert.equal(overrides["pi-shipyard.shipwright"], undefined);
	assert.equal(overrides["pi-workbench.worker"].model, "recommended/worker");
	assert.equal(overrides.scout.model, "existing/model");
});

test("applies with backups, archives the legacy scout, and rolls back safely", () => {
	const { settings, scout, value } = fixture();
	const applied = applyMigration(settings, scout);
	const next = JSON.parse(fs.readFileSync(settings, "utf8"));
	assert.ok(next.packages.includes("./packages/pi-workbench"));
	assert.equal(next.packages.includes("./packages/pi-shipyard"), false);
	assert.equal(next.packages.some((entry: unknown) => JSON.stringify(entry).includes("pi-subagents")), false);
	assert.equal(applied.manifest.embeddedRuntimeCommit, "105c1399d36517292cc7dbe1f56f4724de39bd10");
	assert.equal(fs.existsSync(scout), false);
	assert.ok(applied.manifest.archivedScout && fs.existsSync(applied.manifest.archivedScout));
	const restored = rollback(applied.manifestPath);
	assert.equal(restored.scoutRestored, true);
	assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), value);
	assert.equal(fs.readFileSync(scout, "utf8"), "legacy scout\n");
});
