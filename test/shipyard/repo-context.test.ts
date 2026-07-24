import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRepositoryContextFresh, repositoryContextKey, repositoryContextPath } from "../../extensions/shipyard/repo-context-key.ts";
import { inspectRepositoryState } from "../../extensions/shipyard/repo-context-state.ts";

test("repository context keys are stable per normalized repository root", () => {
	assert.equal(repositoryContextKey("/tmp/repo"), repositoryContextKey("/tmp/repo/../repo"));
	assert.notEqual(repositoryContextKey("/tmp/repo-a"), repositoryContextKey("/tmp/repo-b"));
	assert.match(repositoryContextKey("/tmp/repo"), /^[a-f0-9]{32}$/);
	assert.equal(repositoryContextPath("/cache", "/tmp/repo"), path.join("/cache", `${repositoryContextKey("/tmp/repo")}.json`));
});

test("repository context is fresh only when both revisions match", () => {
	assert.equal(isRepositoryContextFresh("abc", "abc"), true);
	assert.equal(isRepositoryContextFresh("abc", "def"), false);
	assert.equal(isRepositoryContextFresh(null, null), false);
	assert.equal(isRepositoryContextFresh("abc", null), false);
});

test("unborn repositories use their canonical root from nested directories", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "shipyard-context-unborn-"));
	const nested = path.join(repo, "nested", "deeper");
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		await mkdir(nested, { recursive: true });
		const state = await inspectRepositoryState(nested, async (args) => {
			const result = spawnSync("git", args, { cwd: nested, encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout || "" };
		});
		assert.equal(state.root, await realpath(repo));
		assert.equal(state.head, null);
		assert.equal(repositoryContextKey(state.root), repositoryContextKey(await realpath(repo)));
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});
