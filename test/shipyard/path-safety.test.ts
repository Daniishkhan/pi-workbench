import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { resolveSafeStorePath } from "../../extensions/shipyard/path-safety.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; primary: string; legacy: string; cwd: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-path-safety-test-"));
	roots.push(root);
	return {
		root,
		primary: path.join(root, "agent", "workbench", "shipyard", "runs"),
		legacy: path.join(root, "agent", "shipyard-runs"),
		cwd: path.join(root, "project"),
	};
}

test("stores below the unified runs root resolve against it", async () => {
	const { primary, legacy, cwd } = await fixture();
	const store = path.join(primary, "S-session", "R-run", "findings");
	const resolved = await resolveSafeStorePath(cwd, store, primary, legacy);
	assert.equal(resolved, store);
	const stat = await fs.stat(resolved);
	assert.equal(stat.isDirectory(), true);
});

test("legacy pre-unification stores stay readable and writable", async () => {
	const { primary, legacy, cwd } = await fixture();
	const store = path.join(legacy, "S-old-session", "R-old-run", "findings");
	await fs.mkdir(store, { recursive: true });
	await fs.writeFile(path.join(store, "manifest.json"), "{}\n");
	const resolved = await resolveSafeStorePath(cwd, store, primary, legacy);
	assert.equal(resolved, store);
});

test("paths outside both roots and malformed layouts are rejected", async () => {
	const { primary, legacy, cwd, root } = await fixture();
	await assert.rejects(
		() => resolveSafeStorePath(cwd, path.join(root, "elsewhere", "S-a", "R-b", "findings"), primary, legacy),
		/run-specific directory below/,
	);
	await assert.rejects(
		() => resolveSafeStorePath(cwd, path.join(primary, "not-a-session", "R-b", "findings"), primary, legacy),
		/Invalid Shipyard findings location/,
	);
	await assert.rejects(
		() => resolveSafeStorePath(cwd, path.join(legacy, "S-a", "R-b", "not-findings"), primary, legacy),
		/Invalid Shipyard findings location/,
	);
});

test("a unified-root store shadowing a legacy path always uses the unified root", async () => {
	const { primary, legacy, cwd } = await fixture();
	// Same relative layout exists under both roots: the primary must win.
	const relative = path.join("S-session", "R-run", "findings");
	await fs.mkdir(path.join(legacy, relative), { recursive: true });
	const resolved = await resolveSafeStorePath(cwd, path.join(primary, relative), primary, legacy);
	assert.equal(resolved, path.join(primary, relative));
});
