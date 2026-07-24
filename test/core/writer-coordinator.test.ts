import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { WriterCoordinator } from "../../extensions/core/writer-coordinator.ts";

const roots: string[] = [];
function root(): string {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-writer-test-"));
	roots.push(value);
	return value;
}
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

test("excludes a second writer for the same cwd across coordinator instances", () => {
	const rootDir = root();
	const cwd = path.join(rootDir, "repo");
	const first = new WriterCoordinator({ rootDir, pid: 100, processAlive: () => true });
	const second = new WriterCoordinator({ rootDir, pid: 200, processAlive: () => true });
	const lease = first.acquire(cwd, "shipyard:deliver")!;
	assert.throws(() => second.acquire(cwd, "team:writer"), /already owns/);
	first.attachRun(lease.token, "run-1");
	assert.equal(second.list()[0]?.runId, "run-1");
	assert.equal(second.releaseRun("run-1"), true);
	assert.equal(second.acquire(cwd, "team:writer")?.owner, "team:writer");
});

test("reclaims a dead pre-launch owner but never an uncertain launch", () => {
	const rootDir = root();
	const cwd = path.join(rootDir, "repo");
	const dead = new WriterCoordinator({ rootDir, pid: 100, processAlive: () => false });
	dead.acquire(cwd, "dead-writer");
	const next = new WriterCoordinator({ rootDir, pid: 200, processAlive: () => false });
	const replacement = next.acquire(cwd, "replacement")!;
	assert.equal(replacement.owner, "replacement");
	next.markUncertain(replacement.token);
	const later = new WriterCoordinator({ rootDir, pid: 300, processAlive: () => false });
	assert.throws(() => later.acquire(cwd, "unsafe-replacement"), /launch uncertain/);
	assert.equal(later.releaseCwd(cwd), true);
});

test("stale tokens cannot mutate or release a replacement lease", () => {
	const rootDir = root();
	const cwd = path.join(rootDir, "repo");
	const first = new WriterCoordinator({ rootDir, pid: 100, processAlive: () => true });
	const stale = first.acquire(cwd, "first")!;
	assert.equal(first.releaseCwd(cwd), true);
	const replacement = first.acquire(cwd, "replacement")!;
	first.attachRun(stale.token, "stale-run");
	assert.equal(first.release(stale.token), false);
	assert.equal(first.get(cwd)?.token, replacement.token);
	assert.equal(first.get(cwd)?.runId, undefined);
});

test("canonicalizes symlink aliases to the same writer key", () => {
	const rootDir = root();
	const target = path.join(rootDir, "repo");
	const alias = path.join(rootDir, "repo-alias");
	fs.mkdirSync(target);
	fs.symlinkSync(target, alias, "dir");
	const first = new WriterCoordinator({ rootDir, pid: 100, processAlive: () => true });
	const second = new WriterCoordinator({ rootDir, pid: 200, processAlive: () => true });
	const lease = first.acquire(alias, "first")!;
	assert.equal(first.get(target)?.token, lease.token);
	assert.throws(() => second.acquire(target, "second"), /already owns/);
	assert.equal(second.releaseCwd(alias), true);
});

test("disabled guard performs no persistence", () => {
	const rootDir = root();
	const coordinator = new WriterCoordinator({ enabled: false, rootDir });
	assert.equal(coordinator.acquire("/tmp/repo", "writer"), undefined);
	assert.deepEqual(coordinator.list(), []);
});
