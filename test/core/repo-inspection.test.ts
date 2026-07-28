import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	buildReadOnlyGitArgs,
	canonicalGitWorktreeRoot,
	type RepoInspectionInput,
} from "../../extensions/core/repo-inspection.ts";

const cwd = "/tmp/workbench-repo";

const actions: RepoInspectionInput[] = [
	{ action: "status", paths: ["src/file.ts"] },
	{ action: "diff", paths: ["src/file.ts"] },
	{ action: "diff-staged", paths: ["src/file.ts"] },
	{ action: "diff-worktree", paths: ["src/file.ts"] },
	{ action: "diff-range", base: "main", head: "HEAD", paths: ["src/file.ts"] },
	{ action: "diff-stat", staged: true, paths: ["src/file.ts"] },
	{ action: "changed-files", paths: ["src/file.ts"] },
	{ action: "show", ref: "HEAD^", paths: ["src/file.ts"] },
	{ action: "log", ref: "main", limit: 7, paths: ["src/file.ts"] },
	{ action: "blame", paths: ["src/file.ts"], lineStart: 3, lineEnd: 8 },
];

for (const input of actions) {
	test(`builds safe ${input.action} arguments`, () => {
		const args = buildReadOnlyGitArgs(cwd, input);
		assert.equal(args[0], "--no-optional-locks");
		assert.deepEqual(args.slice(1, 4), ["--no-pager", "-c", "core.fsmonitor=false"]);
		assert.equal(args.includes("--"), true);
		assert.equal(args.at(-1), "src/file.ts");
		if (["diff", "diff-staged", "diff-worktree", "diff-range", "diff-stat", "changed-files", "show"].includes(input.action)) {
			assert.equal(args.includes("--no-ext-diff"), true);
			assert.equal(args.includes("--no-textconv"), true);
		}
	});
}

test("builds merge-base ranges, bounded logs, and line-scoped blame", () => {
	assert.equal(
		buildReadOnlyGitArgs(cwd, { action: "diff-range", base: "origin/main", head: "feature" }).at(-1),
		"origin/main...feature",
	);
	assert.equal(buildReadOnlyGitArgs(cwd, { action: "diff-stat", staged: true }).includes("--cached"), true);
	assert.equal(buildReadOnlyGitArgs(cwd, { action: "log", limit: 7 }).includes("-7"), true);
	const blame = buildReadOnlyGitArgs(cwd, { action: "blame", paths: ["file.ts"], lineStart: 3, lineEnd: 8 });
	assert.deepEqual(blame.slice(blame.indexOf("-L"), blame.indexOf("-L") + 2), ["-L", "3,8"]);
});

test("uses compact bounded context and builds one HEAD-to-worktree diff", () => {
	const combined = buildReadOnlyGitArgs(cwd, { action: "diff-worktree" });
	assert.equal(combined.includes("--unified=3"), true);
	assert.equal(combined.includes("HEAD"), true);
	assert.equal(buildReadOnlyGitArgs(cwd, { action: "diff", context: 12 }).includes("--unified=12"), true);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff", context: 21 }), /between 0 and 20/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "status", context: 3 }), /does not accept: context/);
});

test("accepts the repository root but rejects option injection, traversal, and ambiguous revisions", () => {
	assert.equal(buildReadOnlyGitArgs(cwd, { action: "diff", paths: [cwd] }).at(-1), ".");
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff", paths: ["--output=x"] }), /may not start/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff", paths: ["../outside"] }), /below the current Git worktree/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "show", ref: "--help" }), /Invalid git revision/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff", base: "main" }), /does not accept: base/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff-range", head: "feature" }), /head requires base/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff-range" }), /base is required/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff-stat", staged: true, base: "main" }), /cannot be combined/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "blame", paths: [] }), /exactly one path/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "blame", paths: ["file.ts"], lineEnd: 4 }), /lineStart/);
});

test("resolves a canonical worktree root from a nested cwd and ignores ambient Git redirects", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "workbench-git-root-"));
	const other = await mkdtemp(path.join(os.tmpdir(), "workbench-git-redirect-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["init", "-q"], { cwd: other });
		const nested = path.join(repo, "packages", "app");
		await mkdir(nested, { recursive: true });
		const root = canonicalGitWorktreeRoot(nested, { ...process.env, GIT_DIR: path.join(other, ".git") });
		assert.equal(root, await realpath(repo));
		assert.equal(buildReadOnlyGitArgs(root, { action: "diff", paths: ["packages/app/file.ts"] }).at(-1), "packages/app/file.ts");
		assert.throws(() => canonicalGitWorktreeRoot(os.tmpdir()), /requires a Git worktree/);
	} finally {
		await rm(repo, { recursive: true, force: true });
		await rm(other, { recursive: true, force: true });
	}
});

test("range diff and blame inspect committed history", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "workbench-git-range-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Pi Engineering Test"], { cwd: repo });
		await writeFile(path.join(repo, "file.txt"), "first\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
		const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		await writeFile(path.join(repo, "file.txt"), "first\nsecond\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });

		const diff = execFileSync("git", buildReadOnlyGitArgs(repo, { action: "diff-range", base }), { cwd: repo, encoding: "utf8" });
		assert.match(diff, /\+second/);
		const blame = execFileSync("git", buildReadOnlyGitArgs(repo, { action: "blame", paths: ["file.txt"], lineStart: 2 }), { cwd: repo, encoding: "utf8" });
		assert.match(blame, /second/);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("combined worktree diff includes staged and unstaged tracked changes", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "workbench-git-combined-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Pi Engineering Test"], { cwd: repo });
		await writeFile(path.join(repo, "file.txt"), "base\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
		await writeFile(path.join(repo, "file.txt"), "base\nstaged\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo });
		await writeFile(path.join(repo, "file.txt"), "base\nstaged\nunstaged\n");

		const diff = execFileSync("git", buildReadOnlyGitArgs(repo, { action: "diff-worktree" }), { cwd: repo, encoding: "utf8" });
		assert.match(diff, /\+staged/);
		assert.match(diff, /\+unstaged/);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("status does not refresh or rewrite the Git index", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "workbench-git-readonly-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Pi Engineering Test"], { cwd: repo });
		await writeFile(path.join(repo, "file.txt"), "content\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
		const index = path.join(repo, ".git", "index");
		const before = await readFile(index);
		const future = new Date(Date.now() + 5_000);
		await utimes(path.join(repo, "file.txt"), future, future);
		execFileSync("git", buildReadOnlyGitArgs(repo, { action: "status" }), { cwd: repo });
		assert.deepEqual(await readFile(index), before);
		assert.equal((await stat(index)).size, before.length);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});
