import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import registerRepoTool from "../../extensions/core/repo-tool.ts";

function registeredRepoTool(): any {
	let tool: any;
	registerRepoTool({ registerTool(value: unknown) { tool = value; } } as never);
	return tool;
}

function configureRepo(repo: string): void {
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "Pi Engineering Test"], { cwd: repo });
}

async function commitFile(repo: string, content: string): Promise<void> {
	await writeFile(path.join(repo, "file.txt"), content);
	execFileSync("git", ["add", "file.txt"], { cwd: repo });
	execFileSync("git", ["-c", "commit.gpgSign=false", "commit", "-qm", "fixture"], { cwd: repo });
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test("registers inspect_repo and executes only the built read-only Git command", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "workbench-repo-tool-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		const tool = registeredRepoTool();
		assert.equal(tool.name, "inspect_repo");
		assert.match(tool.parameters.properties.action.description, /diff-worktree/);
		assert.match(tool.parameters.properties.context.description, /defaults to 3/);

		const result = await tool.execute("call", { action: "status" }, undefined, undefined, { cwd: repo });
		assert.deepEqual(result.details.args, [
			"--no-optional-locks",
			"--no-pager",
			"-c",
			"core.fsmonitor=false",
			"status",
			"--short",
			"--branch",
		]);
		assert.match(result.content[0].text, /^## /);
		assert.equal(result.details.repoRoot, await realpath(repo));
		assert.equal(result.details.truncated, false);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("inspect_repo reports Git failures and honors pre-abort", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "workbench-repo-tool-failure-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		const tool = registeredRepoTool();
		await assert.rejects(
			() => tool.execute("call", { action: "show", ref: "missing" }, undefined, undefined, { cwd: repo }),
			/git show failed \(128\):/,
		);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			() => tool.execute("call", { action: "status" }, controller.signal, undefined, { cwd: repo }),
			/inspect_repo cancelled/,
		);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("inspect_repo executes and resolves paths from the worktree root when cwd is nested", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "workbench-repo-tool-nested-"));
	try {
		configureRepo(repo);
		const nested = path.join(repo, "packages", "app");
		await mkdir(nested, { recursive: true });
		await writeFile(path.join(nested, "file.ts"), "base\n");
		execFileSync("git", ["add", "packages/app/file.ts"], { cwd: repo });
		execFileSync("git", ["-c", "commit.gpgSign=false", "commit", "-qm", "fixture"], { cwd: repo });
		await writeFile(path.join(nested, "file.ts"), "base\nchanged\n");

		const tool = registeredRepoTool();
		const result = await tool.execute("call", {
			action: "diff",
			paths: ["packages/app/file.ts"],
		}, undefined, undefined, { cwd: nested });
		assert.equal(result.details.repoRoot, await realpath(repo));
		assert.equal(result.details.args.at(-1), "packages/app/file.ts");
		assert.equal(result.details.args.includes("--unified=3"), true);
		assert.match(result.content[0].text, /\+changed/);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("diff-worktree falls back clearly when HEAD is unborn", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "workbench-repo-tool-unborn-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		await writeFile(path.join(repo, "file.txt"), "staged\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo });
		await writeFile(path.join(repo, "file.txt"), "staged\nunstaged\n");

		const tool = registeredRepoTool();
		const result = await tool.execute("call", { action: "diff-worktree" }, undefined, undefined, { cwd: repo });
		assert.match(result.content[0].text, /HEAD has no commit/);
		assert.match(result.content[0].text, /\+staged/);
		assert.match(result.content[0].text, /\+unstaged/);
		assert.equal(result.details.unbornHeadFallback, true);
		assert.equal(Array.isArray(result.details.args[0]), true);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("inspect_repo ignores ambient GIT_DIR and GIT_WORK_TREE for the executed inspection", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "workbench-repo-tool-target-"));
	const redirect = await mkdtemp(path.join(os.tmpdir(), "workbench-repo-tool-redirect-"));
	const previousGitDir = process.env.GIT_DIR;
	const previousGitWorkTree = process.env.GIT_WORK_TREE;
	try {
		configureRepo(repo);
		configureRepo(redirect);
		await commitFile(repo, "base\n");
		await commitFile(redirect, "unrelated\n");
		await writeFile(path.join(repo, "file.txt"), "base\ntarget-change\n");
		process.env.GIT_DIR = path.join(redirect, ".git");
		process.env.GIT_WORK_TREE = redirect;

		const tool = registeredRepoTool();
		const result = await tool.execute("call", { action: "diff" }, undefined, undefined, { cwd: repo });
		assert.equal(result.details.repoRoot, await realpath(repo));
		assert.match(result.content[0].text, /\+target-change/);
		assert.doesNotMatch(result.content[0].text, /unrelated/);
	} finally {
		restoreEnvironment("GIT_DIR", previousGitDir);
		restoreEnvironment("GIT_WORK_TREE", previousGitWorkTree);
		await rm(repo, { recursive: true, force: true });
		await rm(redirect, { recursive: true, force: true });
	}
});
