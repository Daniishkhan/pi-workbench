import assert from "node:assert/strict";
import test from "node:test";
import registerRepoTool from "../../extensions/core/repo-tool.ts";

test("registers workbench_repo and executes only the built read-only Git command", async () => {
	let tool: any;
	const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
	const pi = {
		registerTool(value: unknown) { tool = value; },
		async exec(command: string, args: string[], options: Record<string, unknown>) {
			calls.push({ command, args, options });
			return { code: 0, stdout: "## main\n", stderr: "" };
		},
	};
	registerRepoTool(pi as never);
	assert.equal(tool.name, "workbench_repo");

	const result = await tool.execute("call", { action: "status" }, undefined, undefined, { cwd: "/repo" });
	assert.deepEqual(calls, [{
		command: "git",
		args: ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", "status", "--short", "--branch"],
		options: { cwd: "/repo", signal: undefined, timeout: 30_000 },
	}]);
	assert.equal(result.content[0].text, "## main");
	assert.equal(result.details.truncated, false);
});

test("workbench_repo reports Git failures and honors pre-abort", async () => {
	let tool: any;
	const pi = {
		registerTool(value: unknown) { tool = value; },
		async exec() { return { code: 128, stdout: "", stderr: "not a repository" }; },
	};
	registerRepoTool(pi as never);
	await assert.rejects(
		() => tool.execute("call", { action: "status" }, undefined, undefined, { cwd: "/repo" }),
		/git status failed \(128\): not a repository/,
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => tool.execute("call", { action: "status" }, controller.signal, undefined, { cwd: "/repo" }),
		/workbench_repo cancelled/,
	);
});
