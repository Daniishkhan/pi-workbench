import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReadOnlyGitArgs, type RepoInspectionInput } from "../../extensions/shipyard/repo-inspection.ts";

const cwd = "/tmp/shipyard-repo";

const validInputs: RepoInspectionInput[] = [
	{ action: "status", paths: ["src/file.ts"] },
	{ action: "diff", paths: ["src/file.ts"] },
	{ action: "diff-staged", paths: ["src/file.ts"] },
	{ action: "diff-range", base: "main", head: "HEAD", paths: ["src/file.ts"] },
	{ action: "diff-stat", base: "main", head: "HEAD", paths: ["src/file.ts"] },
	{ action: "changed-files", staged: true, paths: ["src/file.ts"] },
	{ action: "show", ref: "HEAD^", paths: ["src/file.ts"] },
	{ action: "log", ref: "main", paths: ["src/file.ts"], limit: 7 },
	{ action: "blame", ref: "HEAD", paths: ["src/file.ts"], lineStart: 3, lineEnd: 8 },
];

for (const input of validInputs) {
	test(`builds ${input.action} with Git optional locks disabled`, () => {
		const args = buildReadOnlyGitArgs(cwd, input);
		assert.equal(args[0], "--no-optional-locks");
		assert.equal(args.includes("--"), true);
		assert.equal(args.at(-1), "src/file.ts");
	});
}

test("builds merge-base range, staged summaries, full show, ref log, and line blame", () => {
	assert.deepEqual(
		buildReadOnlyGitArgs(cwd, { action: "diff-range", base: "origin/main", head: "feature" }).slice(-1),
		["origin/main...feature"],
	);
	assert.equal(buildReadOnlyGitArgs(cwd, { action: "diff-stat", staged: true }).includes("--cached"), true);
	assert.equal(buildReadOnlyGitArgs(cwd, { action: "changed-files" }).includes("--name-status"), true);
	const show = buildReadOnlyGitArgs(cwd, { action: "show", ref: "abc123" });
	assert.equal(show.includes("--stat"), false);
	assert.equal(show.includes("--format=fuller"), true);
	const log = buildReadOnlyGitArgs(cwd, { action: "log", ref: "release", limit: 7 });
	assert.equal(log.includes("release"), true);
	assert.equal(log.includes("-7"), true);
	const blame = buildReadOnlyGitArgs(cwd, { action: "blame", paths: ["src/file.ts"], lineStart: 3, lineEnd: 8 });
	assert.deepEqual(blame.slice(blame.indexOf("-L"), blame.indexOf("-L") + 2), ["-L", "3,8"]);
});

test("accepts the repository root as an explicit path scope", () => {
	assert.equal(buildReadOnlyGitArgs(cwd, { action: "diff", paths: ["."] }).at(-1), ".");
	assert.equal(buildReadOnlyGitArgs(cwd, { action: "diff", paths: [cwd] }).at(-1), ".");
});

test("rejects option-like paths, traversal, invalid refs, ambiguous ranges, and invalid blame", () => {
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff", paths: ["--output=x"] }), /may not start/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff", paths: ["../outside"] }), /below the current repository/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "show", ref: "--help" }), /Invalid git revision/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff", base: "main" }), /does not accept: base/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "status", ref: "HEAD" }), /does not accept: ref/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff-range", head: "feature" }), /head requires base/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff-range" }), /base is required/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff-stat", staged: true, base: "main" }), /cannot be combined/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "blame", paths: [] }), /exactly one path/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "blame", paths: ["a", "b"] }), /exactly one path/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "blame", paths: ["a"], lineEnd: 4 }), /lineStart/);
});

test("range diff and blame inspect committed history", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "shipyard-git-range-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Shipyard Test"], { cwd: repo });
		await writeFile(path.join(repo, "file.txt"), "first\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
		const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		await writeFile(path.join(repo, "file.txt"), "first\nsecond\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });

		const diff = execFileSync("git", buildReadOnlyGitArgs(repo, { action: "diff-range", base, head: "HEAD" }), { cwd: repo, encoding: "utf8" });
		assert.match(diff, /\+second/);
		const blame = execFileSync("git", buildReadOnlyGitArgs(repo, { action: "blame", paths: ["file.txt"], lineStart: 2 }), { cwd: repo, encoding: "utf8" });
		assert.match(blame, /second/);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("status inspection does not refresh or rewrite the Git index", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "shipyard-git-readonly-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Shipyard Test"], { cwd: repo });
		await writeFile(path.join(repo, "file.txt"), "content\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
		const indexPath = path.join(repo, ".git", "index");
		const beforeBytes = await readFile(indexPath);
		const future = new Date(Date.now() + 5_000);
		await utimes(path.join(repo, "file.txt"), future, future);
		execFileSync("git", buildReadOnlyGitArgs(repo, { action: "status" }), { cwd: repo });
		assert.deepEqual(await readFile(indexPath), beforeBytes);
		assert.equal((await stat(indexPath)).size, beforeBytes.length);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});
