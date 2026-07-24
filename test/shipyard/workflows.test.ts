import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { completeWorkflowModes, normalizeWorkflowName, parseShipyardCommand } from "../../extensions/shipyard/workflow-names.ts";
import { bindWorkflowAgents, materializeWorkflowOutputs, resolveWorkflowTask } from "../../extensions/shipyard/workflow-policy.ts";

test("normalizes canonical and legacy workflow names", () => {
	assert.equal(normalizeWorkflowName("explore"), "explore");
	assert.equal(normalizeWorkflowName(" REVIEW "), "review");
	assert.equal(normalizeWorkflowName("review-fast"), "fast");
	assert.equal(normalizeWorkflowName("review-mesh"), "review");
	assert.equal(normalizeWorkflowName("review-security"), "security");
	assert.equal(normalizeWorkflowName("review-ui"), "ui");
	assert.equal(normalizeWorkflowName("deliver-compact"), "compact");
	assert.equal(normalizeWorkflowName("compact"), "compact");
	assert.equal(normalizeWorkflowName("unknown"), undefined);
});

test("parses one shipyard command mode and preserves the remaining task", () => {
	assert.deepEqual(parseShipyardCommand(""), {});
	assert.deepEqual(parseShipyardCommand("debug"), { workflow: "debug", mode: "debug", task: undefined });
	assert.deepEqual(parseShipyardCommand(" explore   trace auth callers "), {
		workflow: "explore",
		mode: "explore",
		task: "trace auth callers",
	});
	assert.deepEqual(parseShipyardCommand("compact ship the settings slice"), {
		workflow: "compact",
		mode: "compact",
		task: "ship the settings slice",
	});
	assert.deepEqual(parseShipyardCommand("nope task"), { workflow: undefined, mode: "nope", task: "task" });
});

test("mode completion stops after task-separating whitespace", () => {
	assert.deepEqual(completeWorkflowModes("rev"), ["review"]);
	assert.deepEqual(completeWorkflowModes("  deb"), ["debug"]);
	assert.equal(completeWorkflowModes("review "), null);
	assert.equal(completeWorkflowModes("debug\t"), null);
	assert.equal(completeWorkflowModes("unknown"), null);
});

test("mutating and diagnostic workflows require an explicit task", () => {
	for (const workflow of ["debug", "compact", "deliver"] as const) {
		assert.throws(() => resolveWorkflowTask(workflow, "  "), new RegExp(`Shipyard ${workflow} requires a non-empty task`));
	}
	assert.equal(resolveWorkflowTask("deliver", "  implement cache invalidation  "), "implement cache invalidation");
	assert.match(resolveWorkflowTask("review"), /current worktree diff/);
	assert.match(resolveWorkflowTask("explore"), /repository's architecture/);
});

test("binds canonical Shipyard roles without changing task policy fields", () => {
	const bound = bindWorkflowAgents([
		{ agent: "pi-shipyard.codebase-reader", as: "scope" },
		{ parallel: [{ agent: "pi-shipyard.contract-reviewer", as: "contracts" }] },
	], {
		"pi-shipyard.codebase-reader": "pi-workbench.deep-reader",
		"pi-shipyard.contract-reviewer": "pi-workbench.reviewer",
	}) as Array<Record<string, unknown>>;
	assert.equal(bound[0].agent, "pi-workbench.deep-reader");
	assert.equal(bound[0].as, "scope");
	const parallel = bound[1].parallel as Array<Record<string, unknown>>;
	assert.equal(parallel[0].agent, "pi-workbench.reviewer");
	assert.equal(parallel[0].as, "contracts");
	assert.throws(
		() => bindWorkflowAgents([{ agent: "pi-shipyard.codebase-reader" }], { "pi-shipyard.codebase-reader": "unknown.custom-agent" }),
		/changes capability from read-only to writer/,
	);
});

test("materializes every chain output beneath the private run artifact directory", () => {
	const artifactsDir = path.resolve("/tmp/shipyard-private-artifacts");
	const chain = materializeWorkflowOutputs([
		{ agent: "reader", output: "scope/brief.md" },
		{ parallel: [
			{ agent: "contract", output: "review/contracts.md" },
			{ agent: "runtime", output: "review/runtime.md" },
		] },
	], artifactsDir);
	assert.equal(chain[0].output, path.join(artifactsDir, "scope/brief.md"));
	const parallel = chain[1].parallel as Array<Record<string, unknown>>;
	assert.equal(parallel[0].output, path.join(artifactsDir, "review/contracts.md"));
	assert.equal(parallel[1].output, path.join(artifactsDir, "review/runtime.md"));
	assert.throws(() => materializeWorkflowOutputs([{ output: "../escape.md" }], artifactsDir), /escapes the private run directory/);
	assert.throws(() => materializeWorkflowOutputs([{ output: "/tmp/public.md" }], artifactsDir), /must be a non-empty relative path/);
});
