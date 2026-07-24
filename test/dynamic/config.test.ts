import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { legacyDynamicConfigPath, loadDynamicConfig } from "../../extensions/dynamic/config.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-dynamic-config-test-"));
	roots.push(root);
	return path.join(root, "agent");
}

function writeLegacy(agentDir: string, value: unknown): void {
	const file = legacyDynamicConfigPath(agentDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("the unified workbench config dynamic section is the primary source", () => {
	const agentDir = fixture();
	const { config, warnings } = loadDynamicConfig(agentDir, { defaultSize: "medium", maxConcurrency: 2 });
	assert.equal(config.defaultSize, "medium");
	assert.equal(config.maxConcurrency, 2);
	assert.deepEqual(warnings, []);
});

test("the legacy standalone config is a deprecated fallback", () => {
	const agentDir = fixture();
	writeLegacy(agentDir, { defaultSize: "large", allowUnrestricted: true });
	const { config, warnings } = loadDynamicConfig(agentDir);
	assert.equal(config.defaultSize, "large");
	assert.equal(config.allowUnrestricted, true);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /deprecated legacy file/);
	assert.match(warnings[0]!, /extensions\/dynamic-workflows\/config\.json/);
});

test("the primary section wins over an existing legacy file with a warning", () => {
	const agentDir = fixture();
	writeLegacy(agentDir, { defaultSize: "large" });
	const { config, warnings } = loadDynamicConfig(agentDir, { defaultSize: "small", maxRuntimeMs: 60_000 });
	assert.equal(config.defaultSize, "small");
	assert.equal(config.maxRuntimeMs, 60_000);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /ignored and can be deleted/);
});

test("no configuration resolves conservative defaults without warnings", () => {
	const agentDir = fixture();
	const { config, warnings } = loadDynamicConfig(agentDir, {});
	assert.equal(config.defaultSize, "small");
	assert.equal(config.allowUnrestricted, false);
	assert.deepEqual(warnings, []);
});

test("a malformed legacy file falls back to defaults without throwing", () => {
	const agentDir = fixture();
	const file = legacyDynamicConfigPath(agentDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{ not json\n");
	const { config } = loadDynamicConfig(agentDir);
	assert.equal(config.defaultSize, "small");
});
