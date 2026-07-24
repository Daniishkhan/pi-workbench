import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileWorkflowSource } from "../../extensions/dynamic/compiler.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function minimal(overrides = ""): string {
	return `workflow({
  version: 1,
  name: "test-flow",
  description: "A bounded test workflow.",
  size: "small",
  permissions: ["read"],
  phases: ["Run"],
  ${overrides}
  steps: [phase("Run", [run("review", { agent: "pi-workbench.reviewer", saveAs: "report", task: "Review {{input.request}}" })])],
  result: output("report")
});`;
}

test("compiles the bounded audit example into IR", () => {
	const source = fs.readFileSync(path.join(packageRoot, "examples", "audit-routes.workflow.js"), "utf8");
	const compiled = compileWorkflowSource(source);
	assert.equal(compiled.manifest.name, "audit-routes");
	assert.deepEqual(compiled.manifest.phases, ["Discover", "Audit", "Verify"]);
	assert.equal(compiled.steps.length, 3);
	assert.ok(compiled.staticNodeCount >= 7);
	assert.ok(compiled.result && typeof compiled.result === "object" && !Array.isArray(compiled.result) && "kind" in compiled.result);
	assert.equal(compiled.result.kind, "reference");
});

test("rejects arbitrary JavaScript and native control flow", () => {
	assert.throws(() => compileWorkflowSource(`const secret = process.env; ${minimal()}`), /exactly one workflow/);
	assert.throws(() => compileWorkflowSource(`workflow((() => ({ }))());`), /unsupported|supported builder/i);
	assert.throws(() => compileWorkflowSource(`for (;;) {}`), /exactly one workflow|workflow\(\.\.\.\)/i);
	assert.throws(() => compileWorkflowSource(`import fs from "node:fs";`), /syntax|exactly one workflow/i);
});

test("rejects unmanifested skill and acceptance-command injection", () => {
	const withSkill = minimal().replace('task: "Review {{input.request}}"', 'task: "Review {{input.request}}", skill: "dangerous"');
	assert.throws(() => compileWorkflowSource(withSkill), /unsupported fields: skill/);
	const withAcceptance = minimal().replace('task: "Review {{input.request}}"', 'task: "Review {{input.request}}", acceptance: { verify: [{ command: "rm -rf x" }] }');
	assert.throws(() => compileWorkflowSource(withAcceptance), /unsupported fields: acceptance/);
	const forged = minimal().replace(
		'run("review", { agent: "pi-workbench.reviewer", saveAs: "report", task: "Review {{input.request}}" })',
		'{ kind: "run", id: "review", saveAs: "report", task: { agent: "pi-workbench.reviewer", task: "Review", skill: "dangerous", acceptance: { verify: [{ command: "rm -rf x" }] } } }',
	);
	assert.throws(() => compileWorkflowSource(forged), /must be produced by a supported workflow step builder/);
});

test("rejects invalid schemas and non-finite workflow numbers", () => {
	const invalidSchema = minimal().replace('task: "Review {{input.request}}"', 'task: "Review {{input.request}}", schema: []');
	assert.throws(() => compileWorkflowSource(invalidSchema), /schema must be an object/);
	const infinite = minimal().replace('output("report")', '1e999');
	assert.throws(() => compileWorkflowSource(infinite), /number literals must be finite/);
	const nestedInfinite = minimal().replace('output("report")', '{ value: 1e999 }');
	assert.throws(() => compileWorkflowSource(nestedInfinite), /number literals must be finite/);
	const invalidTurnBudget = minimal().replace('task: "Review {{input.request}}"', 'task: "Review {{input.request}}", turnBudget: {}');
	assert.throws(() => compileWorkflowSource(invalidTurnBudget), /maxTurns is required/);
	const invalidToolBudget = minimal().replace('task: "Review {{input.request}}"', 'task: "Review {{input.request}}", toolBudget: { hard: 2, soft: 3 }');
	assert.throws(() => compileWorkflowSource(invalidToolBudget), /soft must not exceed hard/);
});

test("requires exact manifest phase order and selected final result", () => {
	assert.throws(
		() => compileWorkflowSource(minimal().replace('phases: ["Run"]', 'phases: ["Other"]')),
		/must exactly match/,
	);
	assert.throws(() => compileWorkflowSource(minimal().replace(/,\n  result: output\("report"\)/, "")), /requires a result/);
});

test("requires hard bounds for fanout and repeat", () => {
	const fanout = minimal().replace(
		'run("review", { agent: "pi-workbench.reviewer", saveAs: "report", task: "Review {{input.request}}" })',
		'forEach("fanout", { from: input("/items"), collectAs: "report", steps: [run("item-review", { agent: "pi-workbench.reviewer", saveAs: "item_report", task: "Review {{item}}" })] })',
	);
	assert.throws(() => compileWorkflowSource(fanout), /requires a finite maxItems/);

	const repeat = minimal().replace(
		'run("review", { agent: "pi-workbench.reviewer", saveAs: "report", task: "Review {{input.request}}" })',
		'repeat("loop", { until: equals(variable("done"), true), steps: [set("done", true)] })',
	).replace('result: output("report")', 'result: variable("done")');
	assert.throws(() => compileWorkflowSource(repeat), /requires a finite maxIterations/);
});

test("rejects deceptive source controls", () => {
	assert.throws(() => compileWorkflowSource(minimal().replace("bounded", "bound\u202Eed")), /bidirectional/);
	assert.throws(() => compileWorkflowSource(`${minimal()}\u0001`), /control characters/);
});

test("rejects duplicate node and output names", () => {
	const duplicate = minimal().replace(
		'run("review", { agent: "pi-workbench.reviewer", saveAs: "report", task: "Review {{input.request}}" })',
		'parallel("reviews", { steps: [run("review", { agent: "pi-workbench.reviewer", saveAs: "report", task: "A" }), run("review", { agent: "pi-workbench.reviewer", saveAs: "report2", task: "B" })] })',
	);
	assert.throws(() => compileWorkflowSource(duplicate), /Duplicate workflow node id/);
});

test("rejects references that are future, fanout-local, or branch-conditional", () => {
	const future = `workflow({ version: 1, name: "future", description: "Future reference.", size: "small", permissions: ["read"], phases: ["Run"], steps: [phase("Run", [set("early", output("later")), run("later", { agent: "pi-dynamic-workflows.reader", saveAs: "later", task: "Read" })])], result: variable("early") });`;
	assert.throws(() => compileWorkflowSource(future), /unknown output 'later'/);
	const local = `workflow({ version: 1, name: "local", description: "Fanout local reference.", size: "small", permissions: ["read"], phases: ["Run"], steps: [phase("Run", [set("items", [1]), forEach("each", { from: variable("items"), maxItems: 1, collectAs: "all", steps: [run("inner", { agent: "pi-dynamic-workflows.reader", saveAs: "inner", task: "Read {{item}}" })] })])], result: output("inner") });`;
	assert.throws(() => compileWorkflowSource(local), /unknown output 'inner'/);
	const conditional = `workflow({ version: 1, name: "conditional", description: "Conditional reference.", size: "small", permissions: ["read"], phases: ["Run"], steps: [phase("Run", [when("maybe", exists(input("/enabled")), [run("only", { agent: "pi-dynamic-workflows.reader", saveAs: "only", task: "Read" })])])], result: output("only") });`;
	assert.throws(() => compileWorkflowSource(conditional), /unknown output 'only'/);
	const template = `workflow({ version: 1, name: "template", description: "Future template reference.", size: "small", permissions: ["read"], phases: ["Run"], steps: [phase("Run", [run("early", { agent: "pi-dynamic-workflows.reader", saveAs: "early", task: "Use {{outputs.later}}" }), run("later", { agent: "pi-dynamic-workflows.reader", saveAs: "later", task: "Read" })])], result: output("early") });`;
	assert.throws(() => compileWorkflowSource(template), /before it is available/);
});

test("rejects nested phases, missing references, and forged reference objects", () => {
	const nested = minimal().replace(
		'run("review", { agent: "pi-workbench.reviewer", saveAs: "report", task: "Review {{input.request}}" })',
		'phase("Nested", [run("review", { agent: "pi-workbench.reviewer", saveAs: "report", task: "Review" })])',
	);
	assert.throws(() => compileWorkflowSource(nested), /top level/);
	assert.throws(() => compileWorkflowSource(minimal().replace('output("report")', 'output("missing")')), /unknown output/);
	assert.throws(
		() => compileWorkflowSource(minimal().replace('output("report")', '{ kind: "reference", source: "bogus", pointer: "" }')),
		/malformed workflow reference/,
	);
});
