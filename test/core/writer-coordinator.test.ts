import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

test("canonicalizes every nested directory in one Git worktree to the same writer key", () => {
	const base = root();
	const repo = path.join(base, "checkout");
	const nested = path.join(repo, "packages", "app");
	fs.mkdirSync(nested, { recursive: true });
	execFileSync("git", ["init", "--quiet", repo]);
	const coordinator = new WriterCoordinator({ rootDir: path.join(base, "leases"), processAlive: () => true });
	const lease = coordinator.acquire(repo, "root-writer")!;
	assert.equal(lease.cwd, fs.realpathSync.native(repo));
	assert.equal(coordinator.get(nested)?.token, lease.token);
	assert.throws(() => coordinator.acquire(nested, "nested-writer"), /already owns/);
	assert.equal(coordinator.releaseCwd(path.join(repo, "packages")), true);
});

test("falls back to the validated .git ancestor when Git discovery cannot run", () => {
	const base = root();
	const repo = path.join(base, "checkout");
	const nested = path.join(repo, "nested", "deep");
	fs.mkdirSync(nested, { recursive: true });
	execFileSync("git", ["init", "--quiet", repo]);
	const previousPath = process.env.PATH;
	const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
	try {
		process.env.PATH = "";
		process.env.GIT_CEILING_DIRECTORIES = repo;
		const coordinator = new WriterCoordinator({ rootDir: path.join(base, "leases"), processAlive: () => true });
		const lease = coordinator.acquire(repo, "root-writer")!;
		assert.equal(coordinator.get(nested)?.token, lease.token);
		assert.throws(() => coordinator.acquire(nested, "nested-writer"), /already owns/);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
		else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
	}
});

test("keeps linked Git worktrees independent", () => {
	const base = root();
	const repo = path.join(base, "primary");
	const linked = path.join(base, "linked");
	fs.mkdirSync(repo);
	execFileSync("git", ["init", "--quiet", repo]);
	fs.writeFileSync(path.join(repo, "README.md"), "test\n");
	execFileSync("git", ["-C", repo, "add", "README.md"]);
	execFileSync("git", ["-C", repo, "-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "--quiet", "-m", "init"]);
	execFileSync("git", ["-C", repo, "worktree", "add", "--quiet", "--detach", linked, "HEAD"]);
	const coordinator = new WriterCoordinator({ rootDir: path.join(base, "leases"), processAlive: () => true });
	const primary = coordinator.acquire(repo, "primary")!;
	const secondary = coordinator.acquire(linked, "linked")!;
	assert.notEqual(primary.cwd, secondary.cwd);
	assert.notEqual(primary.token, secondary.token);
});

test("finds and releases legacy subdirectory-keyed leases after worktree-root migration", () => {
	const base = root();
	const repo = path.join(base, "checkout");
	const nested = path.join(repo, "nested");
	const leases = path.join(base, "leases");
	fs.mkdirSync(nested, { recursive: true });
	execFileSync("git", ["init", "--quiet", repo]);
	const legacyCwd = fs.realpathSync.native(nested);
	const legacyDir = path.join(leases, createHash("sha256").update(legacyCwd).digest("hex"));
	fs.mkdirSync(legacyDir, { recursive: true });
	fs.writeFileSync(path.join(legacyDir, "owner.json"), `${JSON.stringify({
		version: 1,
		token: "legacy-token",
		cwd: legacyCwd,
		owner: "legacy-writer",
		createdAt: Date.now(),
		pid: process.pid,
	})}\n`);
	fs.rmSync(nested, { recursive: true });
	const coordinator = new WriterCoordinator({ rootDir: leases, processAlive: () => true });
	assert.equal(coordinator.get(repo)?.token, "legacy-token");
	assert.throws(() => coordinator.acquire(repo, "new-writer"), /legacy-writer/);
	assert.equal(coordinator.releaseCwd(repo), true);
	assert.equal(fs.existsSync(legacyDir), false);
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
